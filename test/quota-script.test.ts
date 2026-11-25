// The shared quota script is a shipped artifact: agents and humans run it, and
// it must report the proxy's numbers without a key file (a loopback proxy is
// open) and without hanging when the proxy is gone.
//
// Runs the real script against the harness proxy. The spawn is async on purpose:
// the harness serves in this same process, so a blocking spawn would freeze the
// event loop that has to answer the script's request.

import { expect, test } from "bun:test";
import { join } from "node:path";
import { boot } from "./harness.ts";

const script = join(import.meta.dir, "..", "plugins", "shared", "warm-quota.sh");

interface Run {
  out: string;
  err: string;
  code: number;
}

async function run(args: string[], env: Record<string, string>): Promise<Run> {
  const child = Bun.spawn(["bash", script, ...args], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, err, code };
}

test("warm-quota prints the pool from /api/state", async () => {
  const h = await boot({ accounts: 2 });
  try {
    await fetch(`${h.server.url}/admin/poll`, {
      method: "POST",
      headers: { authorization: "Bearer test-local-key" },
    });
    const env = { WARM2API_PROXY: h.server.url, WARM2API_API_KEY: "test-local-key", WARM2API_DATA: h.dataDir };

    const human = await run([], env);
    expect(human.code).toBe(0);
    expect(human.out).toContain("Warm quota (USD, 2 accounts)");
    expect(human.out).toContain("used      0% of $2");
    expect(human.out).toContain("binding");

    const json = await run(["--json"], env);
    expect(json.code).toBe(0);
    const state = JSON.parse(json.out) as {
      ok: boolean;
      pool: { accounts: number; limit_usd: number; remaining_usd: number; used_percent: number };
    };
    expect(state.ok).toBe(true);
    expect(state.pool.accounts).toBe(2);
    expect(state.pool.limit_usd).toBe(2);
    expect(state.pool.remaining_usd).toBe(2);
    expect(state.pool.used_percent).toBe(0);
  } finally {
    await h.close();
  }
});

test("warm-quota says the budget is unknown before any snapshot", async () => {
  const h = await boot({ accounts: 1 });
  try {
    const env = { WARM2API_PROXY: h.server.url, WARM2API_API_KEY: "test-local-key", WARM2API_DATA: h.dataDir };
    const human = await run([], env);
    expect(human.code).toBe(0);
    expect(human.out).toContain("budget    unknown");
  } finally {
    await h.close();
  }
});

test("warm-quota fails honestly when nothing answers and no snapshot exists", async () => {
  const h = await boot({ accounts: 1 });
  try {
    // Port 9 (discard) is not listening: the connect is refused immediately.
    const env = { WARM2API_PROXY: "http://127.0.0.1:9", WARM2API_API_KEY: "test-local-key", WARM2API_DATA: h.dataDir };
    const human = await run([], env);
    expect(human.code).toBe(1);
    expect(human.err).toContain("no snapshots");

    const json = await run(["--json"], env);
    expect(json.code).toBe(0);
    const fallback = JSON.parse(json.out) as { ok: boolean; source: string; accounts: unknown[] };
    expect(fallback.ok).toBe(false);
    expect(fallback.source).toBe("sqlite");
    expect(fallback.accounts).toEqual([]);
  } finally {
    await h.close();
  }
});
