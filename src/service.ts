// Supervised background service: `warm2api start|stop|restart|status|logs|env`.
//
// One implementation for every host. The 9router-style launcher is a shell
// script per platform only because its app is a Next build with a `node` CLI;
// here the whole proxy is Bun, so the lifecycle lives in Bun and the installers
// stay thin shims. Nothing in this file is POSIX-specific: detached spawn,
// signals, pidfile reads and file tails behave the same on Termux, Linux,
// macOS and Windows under Bun.
//
// State lives beside the database (`<data dir>/run`):
//   warm2api.pid   the supervised child's pid
//   warm2api.port  the port it actually bound (may differ from the request)
//   warm2api.json  { pid, port, url, started_at, version, log }
//   warm2api.log   its stdout+stderr (appended across restarts)

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveAuthPolicy } from "./config.ts";

export interface RunPaths {
  dir: string;
  pid: string;
  port: string;
  record: string;
  log: string;
}

export function runPaths(dataDir?: string): RunPaths {
  const data = dataDir ?? process.env.WARM2API_DATA?.trim() ?? join(homedir(), ".warm2api");
  const dir = join(data, "run");
  return {
    dir,
    pid: join(dir, "warm2api.pid"),
    port: join(dir, "warm2api.port"),
    record: join(dir, "warm2api.json"),
    log: join(data, "warm2api.log"),
  };
}

export interface ServiceRecord {
  pid: number;
  port: number;
  url: string;
  started_at: number;
  version: string;
  log: string;
}

export type ServiceState = "running" | "stale" | "stopped";

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * True when a process with this pid exists. `kill(pid, 0)` throws ESRCH for a
 * gone process and EPERM for one owned by another user — EPERM still means it
 * is there, so only ESRCH counts as absent. Windows under Bun maps this the
 * same way.
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface ServiceStatus {
  state: ServiceState;
  record: ServiceRecord | null;
  /** Alive on the recorded port and/or answering /healthz. */
  healthy: boolean;
  /** Set when the record exists but the listening socket does not answer. */
  detail: string | null;
}

/** Read what is on disk and probe it; never mutates state. */
export async function serviceStatus(dataDir?: string): Promise<ServiceStatus> {
  const paths = runPaths(dataDir);
  const record = readJson<ServiceRecord>(paths.record);
  if (!record) {
    const pid = readJson<number>(paths.pid);
    if (typeof pid === "number" && pidAlive(pid)) {
      return { state: "running", record: null, healthy: false, detail: "pidfile only: written by an older build" };
    }
    return { state: "stopped", record: null, healthy: false, detail: null };
  }
  if (!pidAlive(record.pid)) {
    return { state: "stale", record, healthy: false, detail: "pid is gone (crashed or killed)" };
  }
  const healthy = await probe(record.url);
  return {
    state: "running",
    record,
    healthy,
    detail: healthy ? null : "process alive but /healthz does not answer yet",
  };
}

async function probe(base: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body: unknown = await res.json();
    return typeof body === "object" && body !== null && "ok" in body && body.ok === true;
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Raise a clear error when the bind address is public but nothing guards it.
 *
 * The policy normally runs inside `loadConfig`, i.e. in the process that binds.
 * A detached child started with `start --host` would otherwise read
 * `WARM2API_HOST` from the environment it inherited — not from the flag — and
 * bind loopback while the record claims otherwise, or bind publicly with the
 * policy resolved for loopback. Both are decided here, before forking, so the
 * child's environment and the recorded URL always agree.
 */
function assertBindable(host: string): void {
  resolveAuthPolicy(
    host,
    process.env.WARM2API_DASHBOARD_USER,
    process.env.WARM2API_DASHBOARD_PASS,
    process.env.WARM2API_API_AUTH,
  );
}

function serveArgv(entry: string): string[] {
  // A `bun build --compile` binary's entry lives in Bun's embedded filesystem
  // (`/$bunfs/root/warm2api` on POSIX, `B:\~BUN\root\warm2api.exe` on Windows)
  // and `process.execPath` *is* the program, so re-running it needs no script.
  const embedded = entry.startsWith("/$bunfs") || entry.includes("~BUN");
  if (embedded || !entry || entry === process.execPath) return [process.execPath, "serve"];
  return [process.execPath, entry, "serve"];
}

/** True when the port can be bound. `Bun.serve` throws synchronously on failure. */
function portFree(host: string, port: number): boolean {
  let server: Server | null = null;
  try {
    server = Bun.serve({ hostname: host, port, fetch: () => new Response(null, { status: 204 }) });
    return true;
  } catch {
    return false;
  } finally {
    server?.stop(true);
  }
}

/**
 * Start the proxy detached and wait until it answers. A port already in use is
 * not an error: the pool moves to the next free one and records what it bound,
 * so `status` and the dashboard link stay truthful.
 */
export async function startService(options: {
  port: number;
  host: string;
  dataDir?: string;
  version: string;
  /** Path of the program to re-launch, normally `Bun.argv[1]`. */
  entry: string;
  timeoutMs?: number;
}): Promise<{ record: ServiceRecord; reused: boolean }> {
  const paths = runPaths(options.dataDir);
  const current = await serviceStatus(options.dataDir);
  if (current.state === "running" && current.healthy && current.record) {
    return { record: current.record, reused: true };
  }
  // A stale pidfile must not block the next start.
  if (current.state === "stale") rmSync(paths.record, { force: true });

  mkdirSync(paths.dir, { recursive: true });
  const log = openSync(paths.log, "a");
  assertBindable(options.host);

  let port = options.port;
  let child: Bun.Subprocess | null = null;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;

  // Windows reserves ranges and a busy port surfaces as a rejection from the
  // child's own bind; trying a few ports is cheaper than parsing its stderr.
  for (let attempt = 0; attempt < 6 && child === null; attempt += 1) {
    if (portFree(options.host, port)) {
      child = Bun.spawn(serveArgv(options.entry), {
        // The child must bind exactly what `status`/`env` will report, so the
        // resolved host travels with it instead of being re-read from the
        // parent's environment (which `--host` never touched).
        env: {
          ...process.env,
          WARM2API_PORT: String(port),
          WARM2API_HOST: options.host,
          WARM2API_DATA: options.dataDir ?? process.env.WARM2API_DATA ?? "",
        },
        stdio: ["ignore", log, log],
        detached: true,
      });
      child.unref();
    } else {
      port += 1;
    }
  }
  if (!child) throw new Error(`no free port in ${options.port}-${options.port + 6}`);

  const url = `http://${options.host}:${port}`;
  while (Date.now() < deadline) {
    if (await probe(url, 800)) {
      const record: ServiceRecord = {
        pid: child.pid,
        port,
        url,
        started_at: Date.now(),
        version: options.version,
        log: paths.log,
      };
      writeFileSync(paths.record, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      try {
        chmodSync(paths.record, 0o600);
      } catch {
        /* Windows without POSIX modes */
      }
      writeFileSync(paths.pid, `${child.pid}\n`);
      writeFileSync(paths.port, `${port}\n`);
      return { record, reused: false };
    }
    if (!pidAlive(child.pid)) {
      throw new Error(`the proxy exited during startup; see ${paths.log}`);
    }
    await sleep(150);
  }
  try {
    process.kill(child.pid);
  } catch {
    /* already gone */
  }
  throw new Error(`the proxy did not answer /healthz within ${Math.round(timeoutMs / 1000)}s; see ${paths.log}`);
}

export type StopOutcome = "stopped" | "not-running" | "forced" | "refused";

/**
 * A recorded pid may have been recycled by an unrelated process. Signals are
 * irreversible, so confirm the live process is ours before killing it: a
 * warm2api child runs `serve` (script form) or is the compiled binary itself.
 * Unreadable command lines count as ours — the check is a guard against
 * obviously foreign pids, not a security boundary.
 */
function looksLikeOurs(pid: number): boolean {
  // `process.platform` is "android" under Termux, not "linux", so keying off
  // "linux" silently disabled this guard on the primary target. Gate on /proc
  // being readable instead of on a platform name.
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    if (cmdline.length === 0) return true; // kernel thread or a zombie: nothing to signal
    return cmdline.includes("warm2api") || cmdline.includes("main.ts") || cmdline.endsWith(" serve");
  } catch {
    // No /proc (macOS, Windows) or no permission: assume it is ours.
    return true;
  }
}

/**
 * SIGTERM, then SIGKILL if it lingers. The proxy's own handler closes the
 * listener and the database, so the graceful path is the normal one; the force
 * path exists because a `serve` stuck in a wedged upstream fetch would
 * otherwise hold the port.
 */
export async function stopService(options: { dataDir?: string; graceMs?: number } = {}): Promise<StopOutcome> {
  const paths = runPaths(options.dataDir);
  const record = readJson<ServiceRecord>(paths.record);
  const pid = record?.pid ?? readJson<number>(paths.pid);
  const cleanup = (): void => {
    for (const path of [paths.record, paths.pid, paths.port]) rmSync(path, { force: true });
  };
  if (typeof pid !== "number" || !pidAlive(pid)) {
    cleanup();
    return "not-running";
  }
  if (!looksLikeOurs(pid)) {
    // Leave the process alone and clear only the stale record, so the next
    // `start` is not blocked by a pid we refuse to touch.
    cleanup();
    return "refused";
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    cleanup();
    return "not-running";
  }
  const deadline = Date.now() + (options.graceMs ?? 5_000);
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) {
      cleanup();
      return "stopped";
    }
    await sleep(100);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* raced with the exit */
  }
  for (let attempt = 0; attempt < 30 && pidAlive(pid); attempt += 1) await sleep(100);
  cleanup();
  return "forced";
}

/** Last N lines of the service log, for `warm2api logs`. */
export function tailLog(dataDir: string | undefined, lines = 40): string[] {
  const paths = runPaths(dataDir);
  if (!existsSync(paths.log)) return [];
  const size = statSync(paths.log).size;
  // Read a bounded window rather than the whole file: a long-lived proxy can
  // accumulate megabytes of request banners.
  const window = Math.min(size, 256 * 1024);
  const buffer = Buffer.alloc(window);
  const fd = openSync(paths.log, "r");
  try {
    readSync(fd, buffer, 0, window, size - window);
  } finally {
    closeSync(fd);
  }
  return buffer
    .toString("utf8")
    .split("\n")
    .filter((line, index, all) => line.length > 0 || index < all.length - 1)
    .slice(-lines);
}

export interface ServiceEnv {
  url: string;
  openai_base: string;
  anthropic_base: string;
  dashboard: string;
  api_key: string;
  /** Where `api_key` came from: a file this command can read, or the environment. */
  api_key_source: "file" | "env" | "unknown";
  data_dir: string;
  log: string;
}

/**
 * Everything a client needs to point at the service, key included.
 *
 * The key is not always on disk: `WARM2API_KEY` overrides the generated file and
 * is passed to the child only through the environment. Reading just the file
 * would print `export WARM2API_API_KEY=''` for a guarded proxy, and every client
 * configured from that output would 401.
 */
export function serviceEnv(dataDir?: string): ServiceEnv | null {
  const paths = runPaths(dataDir);
  const record = readJson<ServiceRecord>(paths.record);
  if (!record) return null;
  const resolvedDir = dataDir ?? process.env.WARM2API_DATA?.trim() ?? join(homedir(), ".warm2api");
  let apiKey = (process.env.WARM2API_KEY ?? "").trim();
  let source: ServiceEnv["api_key_source"] = apiKey ? "env" : "unknown";
  if (!apiKey) {
    try {
      apiKey = readFileSync(join(resolvedDir, "api-key"), "utf8").trim();
      source = apiKey ? "file" : "unknown";
    } catch {
      /* generated on first start; absent until then */
    }
  }
  const suffix = apiKey ? `/?key=${encodeURIComponent(apiKey)}` : "/";
  return {
    url: record.url,
    openai_base: `${record.url}/v1`,
    anthropic_base: record.url,
    dashboard: `${record.url}${suffix}`,
    api_key: apiKey,
    api_key_source: source,
    data_dir: resolvedDir,
    log: record.log,
  };
}
