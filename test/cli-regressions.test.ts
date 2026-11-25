// Supervisor and CLI contract. These drive the real binary as a child process
// because the behaviour under test is process lifecycle: signaling, port
// ownership and what the record on disk claims.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const entry = join(root, "src", "main.ts");

const dirs: string[] = [];

function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "warm2api-cli-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function cli(args: string[], env: Record<string, string> = {}): Promise<{ out: string; err: string; code: number }> {
  const child = Bun.spawn([process.execPath, "run", entry, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, err, code };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("supervisor pid safety", () => {
  // A recorded pid may be recycled by an unrelated process. `stop` used to
  // SIGTERM/SIGKILL whatever now owns it, which can kill an editor or a database.
  test("stop refuses to signal a pid that is not a warm2api process", async () => {
    const data = workdir();
    mkdirSync(join(data, "run"), { recursive: true });
    const victim = Bun.spawn(["sleep", "120"], { stdio: ["ignore", "ignore", "ignore"] });
    try {
      writeFileSync(
        join(data, "run", "warm2api.json"),
        JSON.stringify({
          pid: victim.pid,
          port: 41673,
          url: "http://127.0.0.1:41673",
          started_at: Date.now(),
          version: "0.7.0",
          log: join(data, "warm2api.log"),
        }),
      );

      const stopped = await cli(["stop"], { WARM2API_DATA: data });
      expect(stopped.code).toBe(1);
      expect(stopped.err).toContain("another process");
      // The unrelated process is untouched, and the stale record is gone so the
      // next `start` is not blocked.
      expect(alive(victim.pid)).toBe(true);
      await expect(cli(["status"], { WARM2API_DATA: data })).resolves.toMatchObject({ code: 1 });
    } finally {
      if (alive(victim.pid)) victim.kill();
      await victim.exited;
    }
  }, 30_000);
});

describe("start argument handling", () => {
  // `start --port 0` spawned a child on an ephemeral port, then probed port 0
  // for 30 s and failed — leaving the child running and unrecorded.
  test("--port 0 is refused before a child is spawned", async () => {
    const data = workdir();
    const started = await cli(["start", "--port", "0"], { WARM2API_DATA: data, WARM2API_PORT: "0" });
    expect(started.code).toBe(2);
    expect(started.err).toContain("port 0 is not usable");
    // Nothing was started, so nothing was left behind either.
    await expect(cli(["status"], { WARM2API_DATA: data })).resolves.toMatchObject({ code: 1 });
  }, 30_000);

  // `--host` was accepted and then dropped: the child inherited the parent's
  // WARM2API_HOST (loopback), while the record claimed the public address and
  // the public-bind auth guard was never consulted for the address in use.
  test("a public --host is refused when no credentials guard it", async () => {
    const data = workdir();
    const started = await cli(["start", "--host", "0.0.0.0"], {
      WARM2API_DATA: data,
      WARM2API_PORT: "41989",
      WARM2API_API_AUTH: "on",
    });
    expect(started.code).not.toBe(0);
    expect(started.err).toContain("refusing to bind 0.0.0.0");
  }, 30_000);

  test("--host is forwarded to the child and reported truthfully", async () => {
    const data = workdir();
    const env = {
      WARM2API_DATA: data,
      WARM2API_PORT: "41991",
      WARM2API_DASHBOARD_USER: "u",
      WARM2API_DASHBOARD_PASS: "p",
      WARM2API_API_AUTH: "on",
    };
    try {
      const started = await cli(["start", "--host", "127.0.0.1"], env);
      expect(started.code).toBe(0);
      const status = await cli(["status", "--json"], env);
      const record = JSON.parse(status.out) as { url: string; port: number };
      expect(record.url).toBe("http://127.0.0.1:41991");
      expect(record.port).toBe(41991);
    } finally {
      await cli(["stop"], env);
    }
  }, 60_000);
});

describe("credentials in `env`", () => {
  // `serviceEnv` only read `<data>/api-key`, so a key supplied through
  // WARM2API_KEY produced `export WARM2API_API_KEY=''` for a guarded proxy and
  // every client configured from it got 401.
  test("a key from the environment is exported, not an empty string", async () => {
    const data = workdir();
    const env = { WARM2API_DATA: data, WARM2API_PORT: "41993", WARM2API_KEY: "env-key-abcdef123456", WARM2API_API_AUTH: "on" };
    try {
      const started = await cli(["start"], env);
      expect(started.code).toBe(0);

      const exported = await cli(["env"], env);
      expect(exported.out).toContain("export WARM2API_API_KEY='env-key-abcdef123456'");

      const asJson = JSON.parse((await cli(["env", "--json"], env)).out) as { api_key: string; api_key_source: string };
      expect(asJson.api_key).toBe("env-key-abcdef123456");
      expect(asJson.api_key_source).toBe("env");

      const res = await fetch("http://127.0.0.1:41993/api/state", {
        headers: { authorization: "Bearer env-key-abcdef123456" },
      });
      expect(res.status).toBe(200);
      await res.text();
    } finally {
      await cli(["stop"], env);
    }
  }, 60_000);
});

describe("read-only commands", () => {
  // `--help` and `version` resolved the config, which generates an API key and
  // creates the data directory: they failed on a read-only path and wrote files
  // nobody asked for.
  test("help and version work without touching the data directory", async () => {
    const unwritable = "/proc/does-not-exist";
    const help = await cli(["--help"], { WARM2API_DATA: unwritable });
    expect(help.code).toBe(0);
    expect(help.out).toContain("warm2api — pool Warm subscriptions");

    const version = await cli(["version"], { WARM2API_DATA: unwritable });
    expect(version.code).toBe(0);
    expect(version.err).toBe("");
    expect(version.out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  }, 30_000);
});

describe("stale records", () => {
  test("a pidfile-only record from an older build still reports running", async () => {
    const data = workdir();
    mkdirSync(join(data, "run"), { recursive: true });
    const pid = Bun.spawn(["sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });
    try {
      writeFileSync(join(data, "run", "warm2api.pid"), `${pid.pid}\n`);
      const status = await cli(["status", "--json"], { WARM2API_DATA: data });
      const parsed = JSON.parse(status.out) as { state: string };
      expect(parsed.state).toBe("running");
      expect(readFileSync(join(data, "run", "warm2api.pid"), "utf8").trim()).toBe(String(pid.pid));
    } finally {
      pid.kill();
      await pid.exited;
    }
  }, 30_000);
});
