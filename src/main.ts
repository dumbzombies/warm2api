#!/usr/bin/env bun
// warm2api command line. `serve` is the default so the module can also be used
// as the plugins' in-process server.

import { APP_VERSION, getConfig } from "./config.ts";
import { closeDb, formatMicro, getDb, initDb } from "./db.ts";
import {
  addAccount,
  getAccount,
  latestQuota,
  listAccounts,
  purgeAccount,
  recordSnapshot,
  reviveAccount,
  setPlan,
} from "./accounts.ts";
import { addViaDeviceFlow } from "./login.ts";
import { pollOnce, startPoller } from "./poller.ts";
import { startServer } from "./server.ts";
import { runPaths, serviceEnv, serviceStatus, startService, stopService, tailLog } from "./service.ts";
import { fetchModels, fetchUsageRaw } from "./upstream.ts";

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function usd(micro: number | null): string {
  return micro === null ? "unknown" : formatMicro(micro);
}

function iso(ms: number | null): string {
  return ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) : "-";
}

function printAccounts(): void {
  const accounts = listAccounts();
  if (accounts.length === 0) {
    console.log("no accounts. Add one with: warm2api add");
    return;
  }
  const header = ["id", "label", "plan", "state", "remaining", "resets"];
  const rows = accounts.map((account) => {
    const quota = latestQuota(account.id);
    return [
      account.id,
      account.label,
      account.plan,
      account.state + (account.stateReason ? ` (${account.stateReason})` : ""),
      quota ? usd(quota.remainingMicro) : "unknown",
      iso(quota?.resetsAt ?? account.stateUntil),
    ];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  console.log(header.map((h, i) => pad(h, widths[i])).join("  "));
  for (const row of rows) console.log(row.map((c, i) => pad(c, widths[i])).join("  "));
}

function flag(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

async function cmdAdd(args: string[]): Promise<void> {
  const label = flag(args, "--label");
  const added = await addViaDeviceFlow(getConfig(), {
    onDeviceCode: (info) => {
      console.log(`Open ${info.verificationUriComplete ?? info.verificationUri} and approve.`);
      console.log(`Device code: ${info.userCode}`);
    },
    onProgress: (message) => console.log(`  … ${message}`),
  });
  if (label) {
    getDb().run("UPDATE accounts SET label = ? WHERE id = ?", [label, added.account.id]);
  }
  console.log(`added ${added.account.id} (${label ?? added.label})`);
}

async function cmdToken(args: string[]): Promise<void> {
  const token = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--label");
  if (!token) {
    console.error("usage: warm2api token <bearer> [--label L]");
    process.exitCode = 1;
    return;
  }
  const account = addAccount({
    label: flag(args, "--label") ?? "manual",
    accessToken: token,
    expiresAt: Date.now() + 30 * 24 * 3600_000,
  });
  try {
    const { raw, parsed } = await fetchUsageRaw(account);
    recordSnapshot(account.id, raw);
    if (typeof parsed.plan === "string") setPlan(account.id, parsed.plan);
  } catch (err) {
    console.warn(`added, but the usage lookup failed: ${String(err)}`);
  }
  console.log(`added ${account.id}`);
}

async function cmdUsage(args: string[]): Promise<void> {
  const id = args[0];
  const accounts = id ? listAccounts().filter((a) => a.id === id) : listAccounts();
  if (accounts.length === 0) {
    console.error(id ? `no such account: ${id}` : "no accounts");
    process.exitCode = 1;
    return;
  }
  for (const account of accounts) {
    console.log(`\n${account.id}  ${account.label}  [${account.state}]`);
    try {
      const { raw, parsed } = await fetchUsageRaw(account);
      console.log(JSON.stringify(parsed, null, 2));
      recordSnapshot(account.id, raw);
      if (typeof parsed.plan === "string") setPlan(account.id, parsed.plan);
    } catch (err) {
      console.error(`usage lookup failed: ${String(err)}`);
    }
  }
}

async function cmdDoctor(): Promise<void> {
  const config = getConfig();
  console.log(`data dir       ${config.dataDir}`);
  console.log(`database       ${config.dataDir}/state.db`);
  console.log(`api key        ${config.apiKeyPath} (${config.apiKey.length} chars)`);
  console.log(`listen         http://${config.host}:${config.port}`);
  console.log(`upstream       ${config.apiBaseUrl}`);
  console.log(`attestation    ${config.attestation}`);
  console.log(`poll interval  ${config.pollMs} ms`);
  console.log(`accounts       ${listAccounts().length}`);

  try {
    const res = await fetch(new URL("/v1/models", config.apiBaseUrl), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    console.log(`upstream reachable: HTTP ${res.status}${res.status === 401 ? " (expected without a bearer)" : ""}`);
  } catch (err) {
    console.log(`upstream unreachable: ${String(err)}`);
  }

  const account = listAccounts().find((a) => a.state === "active");
  if (account) {
    try {
      const models = await fetchModels(account);
      console.log(`catalog        ${models.length} models (${models.slice(0, 3).map((m) => m.id).join(", ")})`);
    } catch (err) {
      console.log(`catalog failed ${String(err)}`);
    }
  }
}

async function cmdServe(): Promise<void> {
  const config = getConfig();
  const running = await startServer(config);
  const stopPoller = startPoller(config);
  console.log(`warm2api listening on ${running.url}`);
  console.log(`dashboard ${running.url}/?key=<api key>`);
  console.log(`api key in ${config.apiKeyPath}`);
  console.log(`openai base ${running.url}/v1 — anthropic base ${running.url}`);

  const shutdown = (): void => {
    stopPoller();
    running.stop();
    closeDb();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function cmdStart(args: string[]): Promise<void> {
  const config = getConfig();
  const portFlag = flag(args, "--port");
  const hostFlag = flag(args, "--host");
  const port = portFlag ? Number.parseInt(portFlag, 10) : config.port;
  const host = hostFlag ?? config.host;
  if (port === 0) {
    // `serve` may use 0 (tests do), but a detached child must be probed on a
    // known port; there is no way to learn the ephemeral one after the fork.
    console.error("port 0 is not usable with `start`; pass a real port (e.g. --port 41673)");
    process.exitCode = 2;
    return;
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    console.error(`invalid port: ${portFlag}`);
    process.exitCode = 2;
    return;
  }
  const { record, reused } = await startService({
    port,
    host,
    dataDir: config.dataDir,
    version: APP_VERSION,
    entry: Bun.argv[1] ?? process.execPath,
  });
  if (reused) {
    console.log(`warm2api already running (pid ${record.pid}) — ${record.url}`);
  } else {
    console.log(`warm2api started (pid ${record.pid}) — ${record.url}`);
  }
  const env = serviceEnv(config.dataDir);
  if (env) {
    console.log(`dashboard ${env.dashboard}`);
    console.log(`openai base ${env.openai_base} — anthropic base ${env.anthropic_base}`);
  }
  console.log(`log ${record.log}`);
  if (port !== record.port) console.log(`port ${port} was busy; using ${record.port}`);
  if (args.includes("--open")) {
    const target = serviceEnv(config.dataDir)?.dashboard;
    if (target) await openBrowser(target);
  }
}

async function cmdStop(): Promise<void> {
  const outcome = await stopService({ dataDir: getConfig().dataDir });
  if (outcome === "not-running") {
    console.log("warm2api: not running");
    return;
  }
  if (outcome === "refused") {
    // The recorded pid now belongs to something else. Say so loudly: the user
    // asked for a stop and nothing was stopped.
    console.error("warm2api: the recorded pid now belongs to another process; left it alone and cleared the stale record");
    process.exitCode = 1;
    return;
  }
  console.log(`warm2api ${outcome}`);
}

async function cmdStatus(args: string[]): Promise<void> {
  const config = getConfig();
  const status = await serviceStatus(config.dataDir);
  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          state: status.state,
          healthy: status.healthy,
          detail: status.detail,
          pid: status.record?.pid ?? null,
          port: status.record?.port ?? null,
          url: status.record?.url ?? null,
          started_at: status.record?.started_at ?? null,
          uptime_s: status.record ? Math.round((Date.now() - status.record.started_at) / 1000) : null,
          version: status.record?.version ?? null,
          log: status.record?.log ?? runPaths(config.dataDir).log,
        },
        null,
        2,
      ),
    );
    process.exitCode = status.state === "running" && status.healthy ? 0 : 1;
    return;
  }

  if (status.state === "stopped") {
    console.log("warm2api: stopped");
    console.log(`  start with: warm2api start`);
    process.exitCode = 1;
    return;
  }
  const record = status.record;
  const uptime = record ? Math.round((Date.now() - record.started_at) / 1000) : 0;
  console.log(`warm2api: ${status.healthy ? "running" : status.state}${status.detail ? ` — ${status.detail}` : ""}`);
  if (record) {
    console.log(`  pid       ${record.pid}`);
    console.log(`  url       ${record.url}`);
    console.log(`  uptime    ${uptime}s (started ${new Date(record.started_at).toISOString().replace("T", " ").slice(0, 19)})`);
    console.log(`  log       ${record.log}`);

    // The proxy is reachable, so ask it for the pool rather than guessing from
    // the pidfile: `status` is the command people run to check on quota too.
    try {
      const res = await fetch(`${record.url}/healthz`, { signal: AbortSignal.timeout(2_000) });
      const health: unknown = await res.json();
      if (typeof health === "object" && health !== null && "accounts" in health) {
        const counts = health.accounts as Record<string, number>;
        const summary = Object.entries(counts)
          .filter(([, n]) => n > 0)
          .map(([state, n]) => `${state}=${n}`)
          .join(" ");
        console.log(`  accounts  ${summary || "none"}`);
      }
    } catch {
      /* already reported unhealthy */
    }
    const env = serviceEnv(config.dataDir);
    if (env) {
      console.log(`  dashboard ${env.dashboard}`);
      console.log(`  openai    ${env.openai_base}`);
    }
  }
  process.exitCode = status.healthy ? 0 : 1;
}

function cmdLogs(args: string[]): void {
  const config = getConfig();
  const count = Number.parseInt(flag(args, "--lines") ?? "40", 10);
  const lines = tailLog(config.dataDir, Number.isFinite(count) && count > 0 ? count : 40);
  if (lines.length === 0) {
    console.log(`warm2api: no log at ${runPaths(config.dataDir).log} yet`);
    return;
  }
  for (const line of lines) console.log(line);
  if (args.includes("--follow")) console.log(`  (following is left to: tail -f ${runPaths(config.dataDir).log})`);
}

function cmdEnv(args: string[]): void {
  const config = getConfig();
  const env = serviceEnv(config.dataDir);
  if (!env) {
    console.error("warm2api: not running (no service record). Start it with: warm2api start");
    process.exitCode = 1;
    return;
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(env, null, 2));
    return;
  }
  // Shell-eval friendly so `eval "$(warm2api env)"` just works.
  console.log(`export OPENAI_BASE_URL=${shellQuote(env.openai_base)}`);
  console.log(`export ANTHROPIC_BASE_URL=${shellQuote(env.anthropic_base)}`);
  console.log(`export WARM2API_BASE_URL=${shellQuote(env.url)}`);
  console.log(`export WARM2API_API_KEY=${shellQuote(env.api_key)}`);
  console.log(`# dashboard: ${env.dashboard}`);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(command, { stdio: ["ignore", "ignore", "ignore"], detached: true }).unref();
  } catch {
    /* no desktop: the URL is printed anyway */
  }
}

const USAGE = `warm2api — pool Warm subscriptions behind one OpenAI/Anthropic endpoint

Usage: warm2api <command> [options]

Service:
  start [--port N] [--host H] [--open]   run in the background, wait until healthy
  stop                                   stop it (SIGTERM, then SIGKILL)
  restart [--port N] [--host H]          stop, then start
  status [--json]                        state, pid, URL, dashboard, accounts
  logs [--lines N]                       tail the service log
  env [--json]                           export-ready client variables

Accounts and quota:
  add [--label L]                        approve an account with a device code
  token <bearer> [--label L]             store an existing token
  list                                   every account and its budget
  usage [id]                             live quota from the upstream
  poll                                   one quota polling pass
  purge <id|all-retired>                 delete a credential
  revive <id|all>                        force an account back to active
  doctor                                 config, database and upstream checks

Other:
  serve [--port N] [--host H]            run in the foreground (the supervisor's child)
  version                                print the version
  help                                   this text

Environment: WARM2API_PORT (41673), WARM2API_HOST (127.0.0.1), WARM2API_DATA
(~/.warm2api), WARM2API_API_KEY, WARM2API_API_AUTH, WARM2API_POLL_MS.

Start the service, then point clients at it:
  OpenAI     http://127.0.0.1:41673/v1
  Anthropic  http://127.0.0.1:41673
  Dashboard  warm2api status`;

/** Commands that must not touch the data dir (no key, no database, no mkdir). */
const READ_ONLY_COMMANDS = new Set(["help", "--help", "-h", "version", "--version", "-v"]);

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  // `warm2api --help` on a read-only or full disk used to fail with ENOENT from
  // generating an API key nobody asked for.
  if (READ_ONLY_COMMANDS.has(command)) {
    if (command === "version" || command === "--version" || command === "-v") console.log(APP_VERSION);
    else console.log(USAGE);
    return;
  }
  const config = getConfig();
  initDb(config.dataDir);

  switch (command) {
    case "serve":
      await cmdServe();
      return;
    case "add":
      await cmdAdd(args);
      return;
    case "token":
      await cmdToken(args);
      return;
    case "list":
      printAccounts();
      return;
    case "purge": {
      const target = args[0];
      if (!target) {
        console.error("usage: warm2api purge <id|all-retired>");
        process.exitCode = 1;
        return;
      }
      const victims =
        target === "all-retired" ? listAccounts().filter((a) => a.state === "retired") : listAccounts().filter((a) => a.id === target);
      if (victims.length === 0) {
        console.error("nothing to purge");
        process.exitCode = 1;
        return;
      }
      for (const account of victims) {
        purgeAccount(account.id);
        console.log(`purged ${account.id}`);
      }
      return;
    }
    case "revive": {
      const target = args[0];
      if (!target) {
        console.error("usage: warm2api revive <id|all>");
        process.exitCode = 1;
        return;
      }
      const targets = target === "all" ? listAccounts() : listAccounts().filter((a) => a.id === target);
      if (targets.length === 0) {
        console.error("no matching accounts");
        process.exitCode = 1;
        return;
      }
      for (const account of targets) {
        reviveAccount(account.id);
        console.log(`revived ${account.id}`);
      }
      return;
    }
    case "poll": {
      const results = await pollOnce(config);
      for (const result of results) {
        console.log(
          `${result.accountId}  ok=${result.ok}  plan=${result.plan ?? "-"}  remaining=${usd(result.remainingMicro)}  revived=${result.revived}${result.error ? `  error=${result.error}` : ""}`,
        );
      }
      return;
    }
    case "doctor":
      await cmdDoctor();
      return;
    case "usage":
      await cmdUsage(args);
      return;
    case "start":
      await cmdStart(args);
      return;
    case "stop":
      await cmdStop();
      return;
    case "restart":
      await cmdStop();
      await cmdStart(args);
      return;
    case "status":
      await cmdStatus(args);
      return;
    case "logs":
      cmdLogs(args);
      return;
    case "env":
      cmdEnv(args);
      return;
    case "version":
    case "--version":
    case "-v":
      console.log(APP_VERSION);
      return;
    default:
      console.error(`unknown command: ${command}`);
      console.error(
        "commands: start | stop | restart | status | logs | env | serve | add | token <bearer> | list | purge <id|all-retired> | revive <id|all> | poll | doctor | usage [id]",
      );
      process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

export { main, getAccount };
