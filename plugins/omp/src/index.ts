// pi/omp extension: run the local warm2api proxy (bundled with this package, no
// repo checkout or manual launch required) and register it as an
// OpenAI-completions provider, plus a /warm command for account upkeep.

import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface OAuthCallbacks {
  onDeviceCode?(info: { userCode: string; verificationUri: string; verificationUriComplete?: string | null }): void;
  onAuth?(info: { url: string; instructions?: string }): void;
  onProgress?(message: string): void;
  signal?: AbortSignal;
}

interface OAuthCredentials {
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
}

interface ProviderModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

interface ProviderConfig {
  name?: string;
  baseUrl?: string;
  api?: string;
  models?: ProviderModel[];
  oauth?: {
    name: string;
    login(callbacks: OAuthCallbacks): Promise<OAuthCredentials>;
    refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
    getApiKey(credentials: OAuthCredentials): string;
  };
}

interface CommandCtx {
  ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
}

interface PiApi {
  registerProvider(name: string, config: ProviderConfig): void;
  registerCommand(
    name: string,
    options: {
      description?: string;
      input?: { hint?: string };
      getArgumentCompletions?(prefix: string): Array<{ value: string; label: string }> | null;
      handler(args: string, ctx: CommandCtx): unknown;
    },
  ): void;
  on(event: string, handler: (...args: unknown[]) => unknown): void;
}

interface CatalogModel {
  id: string;
  name: string;
  context: number;
  max_output: number;
  thinking: boolean;
  vision: boolean;
}

interface AccountView {
  id: string;
  label: string;
  state: string;
  remaining_usd?: number | null;
  limit_usd?: number | null;
  resets_at?: string | null;
}

interface LoginView {
  id: string;
  status: "pending" | "complete" | "error";
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  account_id?: string;
  label?: string;
  message?: string;
}

/** The subset of `/api/state` the quota readout uses. */
interface StateView {
  version: string;
  uptime_s: number;
  accounts: { total: number; list: AccountView[] };
  pool: {
    accounts: number;
    limit_usd: number | null;
    remaining_usd: number | null;
    used_usd: number | null;
    used_percent: number | null;
    binding_label: string | null;
    resets_at: string | null;
  };
  requests: { total: number; errors: number; tokens_in: number; tokens_out: number; tokens_cached: number; cache_hit_pct: number | null };
  models: string[];
}

/** Models to advertise before anything is known about the gateway catalog. */
const FALLBACK_MODELS: CatalogModel[] = ["gpt-5.6-luna", "deepseek-v4-pro", "deepseek-v4-flash"].map((id) => ({
  id,
  name: id,
  context: 200_000,
  max_output: 32_000,
  thinking: true,
  vision: id === "gpt-5.6-luna",
}));

const PORT = Number(process.env.WARM2API_PORT ?? 41673);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = process.env.WARM2API_DATA?.trim() || join(homedir(), ".warm2api");
const KEY_PATH = join(DATA_DIR, "api-key");

function bundlePath(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [join(here, "..", "dist", "warm2api.mjs"), join(here, "dist", "warm2api.mjs")];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error(`warm2api bundle missing (looked in ${candidates.join(", ")}); run bun run build:plugins`);
  return found;
}

async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(600) });
    return res.ok;
  } catch {
    return false;
  }
}

let starting: Promise<void> | null = null;

/** Reuse a listening proxy, otherwise start the bundled one in the background. */
async function ensureServer(): Promise<string> {
  if (await healthy()) return BASE;
  starting ??= (async () => {
    mkdirSync(DATA_DIR, { recursive: true });
    const log = openSync(join(DATA_DIR, "plugin.log"), "a");
    const child = Bun.spawn([process.execPath, bundlePath(), "serve"], {
      env: { ...process.env, WARM2API_PORT: String(PORT) },
      stdio: ["ignore", log, log],
      detached: true,
    });
    child.unref();
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (await healthy()) return;
      await Bun.sleep(120);
    }
    throw new Error(`warm2api did not become healthy on ${BASE}; see ${join(DATA_DIR, "plugin.log")}`);
  })().catch((err: unknown) => {
    starting = null;
    throw err;
  });
  await starting;
  return BASE;
}

/**
 * The local API key, or an empty string when none exists. A loopback proxy runs
 * open by default, so a missing key is not an error: admin calls that need it
 * send nothing and succeed, and a guarded proxy answers 401.
 */
function apiKey(): string {
  if (!existsSync(KEY_PATH)) return "";
  return readFileSync(KEY_PATH, "utf8").trim();
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  await ensureServer();
  const headers = new Headers(init.headers);
  const key = apiKey();
  if (key) headers.set("x-api-key", key);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const body = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  return body;
}

async function catalogModels(): Promise<CatalogModel[]> {
  try {
    const body = await api<{ models: CatalogModel[] }>("/admin/models");
    return body.models.length > 0 ? body.models : FALLBACK_MODELS;
  } catch {
    return FALLBACK_MODELS;
  }
}

function toProviderModels(models: CatalogModel[]): ProviderModel[] {
  return models.map((model) => ({
    id: model.id,
    name: model.name ?? model.id,
    reasoning: model.thinking === true,
    input: model.vision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.context,
    maxTokens: model.max_output ?? 32_000,
  }));
}

const money = (value: number | null | undefined): string => (typeof value === "number" ? `$${value.toFixed(4)}` : "?");

function describe(account: AccountView): string {
  const window = typeof account.remaining_usd === "number" ? `${money(account.remaining_usd)} of ${money(account.limit_usd)}` : "no quota yet";
  const resets = account.resets_at ? new Date(account.resets_at).toISOString().slice(0, 16).replace("T", " ") : "-";
  return `${account.id} ${account.label} [${account.state}] ${window} resets ${resets}`;
}

async function accounts(): Promise<AccountView[]> {
  return (await api<{ accounts: AccountView[] }>("/admin/accounts")).accounts;
}

async function addAccount(ctx: CommandCtx, i: number, signal?: AbortSignal): Promise<string> {
  const login = await api<LoginView>("/admin/login", { method: "POST" });
  const url = login.verification_uri_complete ?? login.verification_uri ?? "";
  ctx.ui.notify(`Approve at ${url} — code ${login.user_code ?? "?"}`, "info");
  for (let attempt = 0; attempt < 240 && !signal?.aborted; attempt += 1) {
    await Bun.sleep(250 * attempt + 500);
    const view = await api<LoginView>(`/admin/login/${login.id}`);
    if (view.status === "error") throw new Error(view.message ?? "device login failed");
    if (view.status === "complete") return view.account_id ?? view.label ?? "account";
  }
  throw new Error("device login timed out");
}

/**
 * `/warm-quota` readout. Reads `/api/state`, the same document the dashboard,
 * the shared shell script and Hermes use, so every surface reports one set of
 * numbers. A pool with no snapshot says so instead of claiming $0 spent.
 */
function quotaText(state: StateView): string {
  const pool = state.pool;
  const lines = ["Warm quota"];
  if (pool.limit_usd === null || pool.remaining_usd === null) {
    lines.push("budget unknown: no quota snapshot yet (run /warm refresh)");
  } else {
    lines.push(
      `used ${pool.used_percent?.toFixed(2) ?? "?"}% of ${money(pool.limit_usd)} (approx ${money(pool.used_usd)})`,
      `left ${money(pool.remaining_usd)} across ${pool.accounts} account${pool.accounts === 1 ? "" : "s"}`,
      `resets ${pool.resets_at ? pool.resets_at.slice(0, 10) : "unknown"}`,
      `binding ${pool.binding_label ?? "-"}`,
    );
  }
  lines.push(
    `accounts ${state.accounts.total}`,
    `requests ${state.requests.total} total, ${state.requests.errors} errors`,
    state.requests.cache_hit_pct === null
      ? `no prompt tokens measured yet`
      : `cache ${state.requests.cache_hit_pct}% of ${state.requests.tokens_in} prompt tokens`,
    `models ${state.models.length} available`,
    `proxy ${state.version} up ${state.uptime_s}s`,
  );
  return lines.join("\n");
}

async function handleWarm(args: string, ctx: CommandCtx): Promise<void> {
  const [verb = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
  try {
    if (verb === "" || verb === "status") {
      const list = await accounts();
      if (list.length === 0) {
        ctx.ui.notify("warm2api: no accounts. Use /warm add.", "info");
        return;
      }
      const states = new Map<string, number>();
      for (const account of list) states.set(account.state, (states.get(account.state) ?? 0) + 1);
      const summary = [...states.entries()].map(([state, n]) => `${state}=${n}`).join(" ");
      ctx.ui.notify(`warm2api: ${list.length} account(s) — ${summary}`, "info");
      return;
    }
    if (verb === "accounts" || verb === "usage") {
      const list = await accounts();
      ctx.ui.notify(list.length === 0 ? "no accounts" : list.map(describe).join("\n"), "info");
      return;
    }
    if (verb === "add") {
      const id = await addAccount(ctx, 0);
      ctx.ui.notify(`warm2api: added ${id}`, "info");
      return;
    }
    if (verb === "purge") {
      const target = rest[0];
      if (!target) {
        ctx.ui.notify("usage: /warm purge <id|all-retired>", "warning");
        return;
      }
      const list = await accounts();
      const victims = target === "all-retired" ? list.filter((a) => a.state === "retired") : list.filter((a) => a.id === target);
      if (victims.length === 0) {
        ctx.ui.notify("nothing to purge", "warning");
        return;
      }
      for (const account of victims) await api(`/admin/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
      ctx.ui.notify(`purged ${victims.map((a) => a.id).join(", ")}`, "info");
      return;
    }
    if (verb === "revive") {
      const target = rest[0] ?? "all";
      const list = await accounts();
      const victims = target === "all" ? list : list.filter((a) => a.id === target);
      if (victims.length === 0) {
        ctx.ui.notify("no matching accounts", "warning");
        return;
      }
      for (const account of victims) await api(`/admin/accounts/${encodeURIComponent(account.id)}/revive`, { method: "POST" });
      ctx.ui.notify(`revived ${victims.map((a) => a.id).join(", ")}`, "info");
      return;
    }
    if (verb === "refresh") {
      const state = await api<StateView>("/api/refresh", { method: "POST" });
      ctx.ui.notify(quotaText(state), "info");
      return;
    }
    const match = (await accounts()).find((a) => a.id === verb);
    ctx.ui.notify(match ? describe(match) : "usage: /warm [accounts|add|purge <id>|revive <id|all>|refresh|usage [id]]", match ? "info" : "warning");
  } catch (err) {
    ctx.ui.notify(`warm2api: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

export default async function warm2apiPlugin(pi: PiApi): Promise<void> {
  await ensureServer().catch(() => BASE);
  pi.registerProvider("warm", {
    name: "Warm",
    baseUrl: `${BASE}/v1`,
    // A provider that declares `oauth` but no `apiKey` is treated as
    // "not yet authenticated" and Pi omits it from `--list-models` and the
    // model picker entirely — the plugin then looks installed-but-broken, and
    // `/warm add` is unreachable because its models never appear. The local
    // proxy is what authenticates upstream; the key here only satisfies the
    // host's readiness check, and the oauth flow still runs for `/login`.
    apiKey: apiKey() || "local",
    api: "openai-completions",
    models: toProviderModels(await catalogModels()),
    oauth: {
      name: "Warm account",
      async login(callbacks: OAuthCallbacks): Promise<OAuthCredentials> {
        const login = await api<LoginView>("/admin/login", { method: "POST" });
        const url = login.verification_uri_complete ?? login.verification_uri ?? "";
        if (callbacks.onDeviceCode) {
          callbacks.onDeviceCode({
            userCode: login.user_code ?? "?",
            verificationUri: login.verification_uri ?? url,
            verificationUriComplete: login.verification_uri_complete ?? null,
          });
        } else {
          callbacks.onAuth?.({ url, instructions: `Device code: ${login.user_code ?? "?"}` });
        }
        for (let attempt = 0; attempt < 240; attempt += 1) {
          if (callbacks.signal?.aborted) throw new Error("login cancelled");
          await Bun.sleep(250 * attempt + 500);
          const view = await api<LoginView>(`/admin/login/${login.id}`);
          if (view.status === "error") throw new Error(view.message ?? "device login failed");
          if (view.status === "complete") {
            return {
              refresh: view.account_id ?? "account",
              access: apiKey(),
              expires: Date.now() + 30 * 24 * 3600_000,
              accountId: view.account_id,
            };
          }
        }
        throw new Error("device login timed out");
      },
      async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        return { ...credentials, access: apiKey(), expires: Date.now() + 30 * 24 * 3600_000 };
      },
      getApiKey(credentials: OAuthCredentials): string {
        return credentials.access;
      },
    },
  });

  pi.registerCommand("warm", {
    description: "Manage Warm accounts behind the local proxy",
    input: { hint: "[accounts|add|purge <id>|revive <id|all>|refresh|usage [id]]" },
    getArgumentCompletions(prefix: string) {
      const verbs = ["accounts", "add", "purge", "revive", "refresh", "usage"];
      const matches = verbs.filter((verb) => verb.startsWith(prefix));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: (args: string, ctx: CommandCtx) => handleWarm(args, ctx),
  });

  pi.registerCommand("warm-quota", {
    description: "Show Warm quota (pool % used, $ left, reset date, cache hit rate)",
    handler: async (_args: string, ctx: CommandCtx) => {
      try {
        ctx.ui.notify(quotaText(await api<StateView>("/api/state")), "info");
      } catch (err) {
        ctx.ui.notify(`warm2api: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.on("session_start", async () => {
    await ensureServer().catch(() => BASE);
  });
}
