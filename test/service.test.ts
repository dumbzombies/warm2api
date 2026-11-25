// Service lifecycle: `start` binds and records, `status` reads it back,
// `stop` terminates, and a killed child is reported as stale rather than as
// running. These run the real CLI as a child process because the whole point is
// process supervision — an in-process fake would prove nothing.
//
// Each test owns a temp data dir and a port from the reserved test range.

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const entry = join(root, "src", "main.ts");

interface Cli {
  out: string;
  err: string;
  code: number;
}

async function cli(args: string[], env: Record<string, string>): Promise<Cli> {
  const child = Bun.spawn([process.execPath, "run", entry, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, err, code };
}

function workdir(): string {
  return mkdtempSync(join(tmpdir(), "warm2api-svc-"));
}

test("start, status, env and stop drive a real child process", async () => {
  const data = workdir();
  const env = { WARM2API_DATA: data, WARM2API_PORT: "41995" };
  try {
    const started = await cli(["start"], env);
    expect(started.code).toBe(0);
    expect(started.out).toContain("warm2api started");
    expect(started.out).toContain("http://127.0.0.1:41995");

    const status = await cli(["status", "--json"], env);
    expect(status.code).toBe(0);
    const state = JSON.parse(status.out) as { state: string; healthy: boolean; pid: number; port: number; url: string };
    expect(state.state).toBe("running");
    expect(state.healthy).toBe(true);
    expect(state.port).toBe(41995);
    expect(state.url).toBe("http://127.0.0.1:41995");
    // The pid it recorded is a live process.
    expect(() => process.kill(state.pid, 0)).not.toThrow();

    // `env` is shell-eval friendly and carries the key the proxy generated.
    const envOut = await cli(["env"], env);
    expect(envOut.code).toBe(0);
    expect(envOut.out).toContain("export OPENAI_BASE_URL='http://127.0.0.1:41995/v1'");
    expect(envOut.out).toMatch(/export WARM2API_API_KEY='[0-9a-f]{64}'/);

    const stopped = await cli(["stop"], env);
    expect(stopped.code).toBe(0);
    expect(stopped.out).toContain("stopped");

    const after = await cli(["status"], env);
    expect(after.code).toBe(1);
    expect(after.out).toContain("stopped");
    expect(() => process.kill(state.pid, 0)).toThrow();
  } finally {
    // A leaked child would hold the port for the next run.
    await cli(["stop"], env);
    rmSync(data, { recursive: true, force: true });
  }
}, 60_000);

test("start is idempotent and a killed child reads as stale", async () => {
  const data = workdir();
  const env = { WARM2API_DATA: data, WARM2API_PORT: "41996" };
  try {
    expect((await cli(["start"], env)).code).toBe(0);
    const again = await cli(["start"], env);
    expect(again.code).toBe(0);
    expect(again.out).toContain("already running");

    const record = JSON.parse(readFileSync(join(data, "run", "warm2api.json"), "utf8")) as { pid: number };
    process.kill(record.pid, "SIGKILL");
    // Wait for the kernel to reap it, not a fixed sleep: the assertion below is
    // exactly "the pid is gone".
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        process.kill(record.pid, 0);
      } catch {
        break;
      }
      await Bun.sleep(50);
    }

    const stale = await cli(["status"], env);
    expect(stale.code).toBe(1);
    expect(stale.out).toContain("stale");

    // A stale record must not block the next start.
    const restarted = await cli(["start"], env);
    expect(restarted.code).toBe(0);
    expect(restarted.out).toContain("warm2api started");
  } finally {
    await cli(["stop"], env);
    rmSync(data, { recursive: true, force: true });
  }
}, 60_000);

test("a busy port moves to the next one and says so", async () => {
  const data = workdir();
  const squatter = Bun.spawn(
    [
      process.execPath,
      "-e",
      "Bun.serve({ hostname: '127.0.0.1', port: 41997, fetch: () => new Response('x') });",
    ],
    { env: { ...process.env, WARM2API_DATA: data }, stdout: "ignore", stderr: "ignore" },
  );
  try {
    // Wait for the squatter to hold the port.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await fetch("http://127.0.0.1:41997/", { signal: AbortSignal.timeout(200) });
        break;
      } catch {
        await Bun.sleep(50);
      }
    }
    const started = await cli(["start"], { WARM2API_DATA: data, WARM2API_PORT: "41997" });
    expect(started.code).toBe(0);
    expect(started.out).toContain("was busy; using 41998");
    expect(started.out).toContain("127.0.0.1:41998");
  } finally {
    await cli(["stop"], { WARM2API_DATA: data });
    squatter.kill();
    await squatter.exited;
    rmSync(data, { recursive: true, force: true });
  }
}, 60_000);

test("status reports a stopped service with a non-zero exit", async () => {
  const data = workdir();
  try {
    const status = await cli(["status"], { WARM2API_DATA: data, WARM2API_PORT: "41999" });
    expect(status.code).toBe(1);
    expect(status.out).toContain("warm2api: stopped");

    const json = await cli(["status", "--json"], { WARM2API_DATA: data, WARM2API_PORT: "41999" });
    const state = JSON.parse(json.out) as { state: string; healthy: boolean };
    expect(state.state).toBe("stopped");
    expect(state.healthy).toBe(false);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
