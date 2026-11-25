// A loopback proxy runs open by default, so the agents must work with no key
// file at all. The plugins used to throw here, which forced a credential the
// proxy never asked for.
//
// The probe captures the `/warm` command handler and runs `/warm status`, which
// reaches account listing → api() → apiKey(). That is the call that used to
// throw; registration alone never touches it (a weaker test passes with the bug
// present — verified). The proxy here is a real open loopback instance, not the
// harness one, which deliberately requires the key.

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the omp plugin lists accounts against an open proxy with no key file", async () => {
  const root = join(import.meta.dir, "..");
  const workDir = mkdtempSync(join(tmpdir(), "warm2api-keyless-"));
  const proxyData = join(workDir, "proxy");
  const pluginData = join(workDir, "plugin");
  const port = 41991;
  const base = `http://127.0.0.1:${port}`;

  // Open loopback proxy: no WARM2API_API_AUTH, no dashboard credentials.
  const proxy = Bun.spawn([process.execPath, "run", "src/main.ts", "serve"], {
    cwd: root,
    env: { ...process.env, WARM2API_DATA: proxyData, WARM2API_PORT: String(port), WARM2API_API_AUTH: "" },
    stdout: "pipe",
    stderr: "pipe",
  });

  const probe = join(pluginData, "probe.ts");
  // Dynamic import on purpose: the plugin reads WARM2API_PORT/WARM2API_DATA at
  // module load, so the probe must import it after this process's env is set.
  const probeSource = `const mod = await import(${JSON.stringify(join(root, "plugins/omp/src/index.ts"))});
let handler = null;
await mod.default({
  registerProvider: () => {},
  registerCommand: (name, options) => { if (name === "warm") handler = options.handler; },
  on: () => {},
});
const notes = [];
await handler("status", { ui: { notify: (message) => notes.push(message) } });
console.log(JSON.stringify({ notes }));
process.exit(0);
`;

  try {
    // Wait for the proxy's own readiness banner rather than sleeping.
    const reader = proxy.stdout.getReader();
    const decoder = new TextDecoder();
    let banner = "";
    const deadline = AbortSignal.timeout(20_000);
    while (!banner.includes("listening")) {
      if (deadline.aborted) throw new Error(`proxy never started; saw: ${banner}`);
      const { value, done } = await reader.read();
      if (done) break;
      banner += decoder.decode(value, { stream: true });
    }
    reader.releaseLock();

    // Seed one account so the listing has something to report.
    const add = await fetch(`${base}/admin/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessToken: "tok_keyless", label: "keyless@example.com" }),
    });
    expect(add.status).toBe(201);

    await Bun.write(probe, probeSource);
    const child = Bun.spawn([process.execPath, "run", probe], {
      cwd: root,
      env: { ...process.env, WARM2API_DATA: pluginData, WARM2API_PORT: String(port) },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(await child.exited).toBe(0);

    const line = stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1);
    if (!line) throw new Error(`probe produced no result: ${stdout}\n${stderr}`);
    const outcome: unknown = JSON.parse(line);
    if (typeof outcome !== "object" || outcome === null || !("notes" in outcome)) {
      throw new Error(`unexpected probe output: ${line}`);
    }

    const notes = (outcome.notes as string[]).join(" ");
    // It saw the account, which means the admin call succeeded with no key.
    expect(notes).toContain("1 account");
    expect(notes).not.toContain("api key");
  } finally {
    proxy.kill();
    await proxy.exited;
    rmSync(workDir, { recursive: true, force: true });
  }
}, 90_000);
