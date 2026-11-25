// Production hardening: a stalled gateway must not pin a request forever, and
// the append-only request log must stay bounded under load.

import { join } from "node:path";
import { expect, test } from "bun:test";
import { boot } from "./harness.ts";
import { recordRequest } from "../src/track.ts";
import { getDb } from "../src/db.ts";

test("a stalled upstream is bounded instead of hanging the request", async () => {
  // Child process: the stall test rewires config and owns its own database, so it
  // cannot share this process with the other tests.
  const probe = Bun.spawn([process.execPath, "run", "test/fixtures/stall-probe.ts"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(probe.stdout).text(),
    new Response(probe.stderr).text(),
  ]);
  expect(await probe.exited).toBe(0);

  const line = stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1);
  if (!line) throw new Error(`probe produced no result: ${stderr}`);
  const outcome: unknown = JSON.parse(line);

  if (typeof outcome !== "object" || outcome === null || !("status" in outcome) || !("elapsed" in outcome)) {
    throw new Error(`unexpected probe output: ${line}`);
  }
  const status = Number(outcome.status);
  const elapsed = Number(outcome.elapsed);

  // The request must terminate on its own, well before any client-side timeout.
  expect(elapsed).toBeLessThan(5_000);
  expect(status).toBeGreaterThanOrEqual(500);
});

test("oversized in-flight bytes are shed with 503 while admin stays answerable", async () => {
  // Child fixture: the byte budget is read once at module load, so it needs a
  // process whose environment is already set.
  const probe = Bun.spawn([process.execPath, "run", "test/fixtures/shed-probe.ts"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(probe.stdout).text(),
    new Response(probe.stderr).text(),
  ]);
  expect(await probe.exited).toBe(0);

  const line = stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1);
  if (!line) throw new Error(`probe produced no result: ${stderr}`);
  const outcome: unknown = JSON.parse(line);
  if (typeof outcome !== "object" || outcome === null || !("shed" in outcome) || !("admin" in outcome)) {
    throw new Error(`unexpected probe output: ${line}`);
  }
  expect(Number(outcome.shed)).toBeGreaterThan(0);
  expect(Number(outcome.admin)).toBe(200);
});

test("request_log stays bounded when hammered", async () => {
  const h = await boot({ accounts: 1 });
  try {
    const count = () =>
      (getDb().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM request_log").get() ?? { n: 0 }).n;

    const start = count();
    const writes = 51_000;
    for (let i = 0; i < writes; i += 1) {
      recordRequest({ accountId: null, surface: "openai", model: "m", status: 200, inputTokens: 1, outputTokens: 1, ms: 1 });
    }

    const after = count();
    // Retention trims at most PRUNE_EVERY rows past the cap, never grows unbounded.
    expect(after).toBeLessThan(start + writes);
    expect(after).toBeLessThanOrEqual(50_000 + 256);
  } finally {
    await h.close();
  }
});
