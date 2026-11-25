import { expect, test } from "bun:test";
import { join } from "node:path";
import { boot } from "./harness.ts";

interface Report {
  provider: string;
  baseUrl: string;
  ompModels: string[];
  ompCommands: string[];
  opencodeId: string;
  opencodeBaseUrl: string;
  opencodeModels: string[];
  pluginLog: boolean;
}

test("the omp and opencode plugins reuse a running proxy and advertise it", async () => {
  const h = await boot({ accounts: 1 });
  const port = new URL(h.server.url).port;
  const probe = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "plugin-probe.ts")], {
    env: { ...process.env, WARM2API_PORT: port, WARM2API_DATA: h.config.dataDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(probe.stdout).text(),
    new Response(probe.stderr).text(),
    probe.exited,
  ]);
  expect(code).toBe(0);

  const report = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Report;
  expect(report.provider).toBe("warm");
  expect(report.baseUrl).toBe(`${h.server.url}/v1`);
  // The shipped example points at loopback; install.sh rewrites the port.
  expect(report.opencodeBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  expect(report.ompModels).toContain("gpt-5.6-luna");
  expect(report.opencodeModels).toContain("gpt-5.6-luna");
  // Both quota surfaces are registered on omp.
  expect(report.ompCommands).toContain("warm");
  expect(report.ompCommands).toContain("warm-quota");
  expect(report.opencodeId).toBe("warm2api.opencode");
  // Reusing an already-running proxy must not spawn a second one.
  expect(report.pluginLog).toBe(false);
  expect(stderr).toBe("");
});
