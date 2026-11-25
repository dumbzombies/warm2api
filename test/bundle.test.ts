// The plugins ship a built bundle of the proxy, and that bundle is what runs in
// the agents — so the dashboard has to survive bundling. A source-only test
// passes while `dist/warm2api.mjs` serves the 284-byte fallback page, which is
// exactly the bug this file exists to catch.

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the built bundle serves the real dashboard, not the fallback", async () => {
  const root = join(import.meta.dir, "..");
  const outDir = mkdtempSync(join(tmpdir(), "warm2api-bundle-"));
  const bundle = join(outDir, "warm2api.mjs");

  const build = Bun.spawn([process.execPath, "build", "src/main.ts", "--target=bun", `--outfile=${bundle}`], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [buildErr, buildCode] = await Promise.all([new Response(build.stderr).text(), build.exited]);
  expect(buildCode).toBe(0);
  expect(buildErr).not.toContain("error:");

  const dataDir = join(outDir, "data");
  const server = Bun.spawn([process.execPath, "run", bundle, "serve"], {
    cwd: root,
    env: { ...process.env, WARM2API_DATA: dataDir, WARM2API_PORT: "41994" },
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    // Wait for the child's own readiness line instead of guessing a duration:
    // the proxy prints "listening on ..." once the socket is bound.
    const reader = server.stdout.getReader();
    const decoder = new TextDecoder();
    let banner = "";
    const deadline = AbortSignal.timeout(20_000);
    while (!banner.includes("listening")) {
      if (deadline.aborted) throw new Error(`proxy never reported listening; saw: ${banner}`);
      const { value, done } = await reader.read();
      if (done) break;
      banner += decoder.decode(value, { stream: true });
    }
    reader.releaseLock();

    const html = await (await fetch("http://127.0.0.1:41994/")).text();
    expect(html.length).toBeGreaterThan(30_000);
    expect(html.includes("assets missing") || html.includes("Dashboard asset missing")).toBe(false);
    expect(html).toContain('class="shell"');
  } finally {
    server.kill();
    await server.exited;
    rmSync(outDir, { recursive: true, force: true });
  }
}, 60_000);
