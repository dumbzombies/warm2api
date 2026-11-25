// HTTP surface. Loopback only by default; every route except /healthz needs the
// local API key, which is compared in constant time.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { CLIENT_VERSION, getConfig, type Config } from "./config.ts";
import { ApiError } from "./errors.ts";
import {
  addAccount,
  getAccount,
  latestQuota,
  listAccounts,
  purgeAccount,
  reviveAccount,
  type Account,
} from "./accounts.ts";
import { fetchModels, mergeUsage, UpstreamError } from "./upstream.ts";
import { openWithRotation, type OpenResult } from "./dispatch.ts";
import { parseJsonResponse, toAnthropicRequest } from "./translate/openai-in.ts";
import { collectOpenAI, sseToOpenAI } from "./translate/openai-out.ts";
import {
  anthropicFrames,
  collectMessage,
  errorFrame,
  estimateTokens,
  prepareAnthropicRequest,
} from "./translate/anthropic.ts";
import { applyEffort, normaliseEffort } from "./translate/effort.ts";
import { modelMeta, resolveModel, seedModels } from "./translate/models.ts";
import { byModel, recordRequest, recent, series, summary } from "./track.ts";
import {
  accountCounts,
  apiState,
  billingSubscription,
  billingUsage,
  uptimeSeconds,
} from "./control.ts";
import { pollOnce } from "./poller.ts";
import { getLogin, startLogin } from "./dashboard.ts";
import UI_HTML from "./ui.html" with { type: "text" };
import type {
  AnthropicEvent,
  AnthropicRequest,
  AnthropicUsage,
  ModelInfo,
  OpenAIChatRequest,
} from "./types.ts";

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const CATALOG_TTL_MS = 60_000;

export interface RunningServer {
  url: string;
  port: number;
  external: boolean;
  stop(): void;
}

/**
 * Browser clients: the OpenAI and Anthropic SDKs run from web pages too, so the
 * inference surface answers preflights. Credentials are not CORS-cookie-based
 * here (the key travels in a header), so a wildcard origin is safe.
 */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, anthropic-version, x-api-key, anthropic-beta",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-max-age": "86400",
};

function corsHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...CORS_HEADERS, ...extra };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders({ "content-type": "application/json" }),
  });
}

function jsonError(status: number, message: string, code: string, type = "invalid_request_error"): Response {
  return json({ error: { message, type, code } }, status);
}

function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) return jsonError(err.status, err.message, err.code, err.type);
  if (err instanceof UpstreamError) {
    const detail = err.detail;
    const status = detail.status >= 400 && detail.status < 600 ? detail.status : 502;
    return jsonError(status, detail.message, detail.code, "api_error");
  }
  console.error("[warm2api] unhandled error:", err);
  return jsonError(500, err instanceof Error ? err.message : "internal error", "internal_error", "api_error");
}

function statusOf(err: unknown): number {
  if (err instanceof ApiError) return err.status;
  if (err instanceof UpstreamError) return err.detail.status;
  return 500;
}

function codeOf(err: unknown): string | null {
  if (err instanceof ApiError) return err.code;
  if (err instanceof UpstreamError) return err.detail.code;
  return null;
}

const AUTH_COOKIE = "warm2api_key";

/** Percent-decode, tolerating malformed escapes instead of throwing URIError. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function cookieValue(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return safeDecode(part.slice(index + 1).trim());
  }
  return null;
}



const DASHBOARD_REALM = 'Basic realm="warm2api", charset="UTF-8"';

/** Compare two secrets without leaking length or content through timing. */
function safeEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Still do the comparison work so a wrong length is not observably faster.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** `Authorization: Basic` credentials, decoded, or null when absent/malformed. */
function basicCredentials(req: Request): { user: string; password: string } | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^basic\s+/i.exec(header);
  if (!match) return null;
  const decoded = Buffer.from(header.slice(match[0].length).trim(), "base64").toString("utf8");
  const index = decoded.indexOf(":");
  if (index < 0) return null;
  return { user: decoded.slice(0, index), password: decoded.slice(index + 1) };
}

/** HttpOnly cookie holding the API key; only issued on a successful unlock. */
function authCookie(apiKey: string): string {
  return `${AUTH_COOKIE}=${encodeURIComponent(apiKey)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`;
}

function authorised(req: Request, apiKey: string): boolean {
  const header = req.headers.get("authorization");
  const bearer = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null;
  const provided = bearer ?? req.headers.get("x-api-key") ?? cookieValue(req, AUTH_COOKIE);
  if (!provided) return false;
  return safeEqual(provided, apiKey);
}

/** Holds the dashboard behind basic auth when the operator configured it. */
function dashboardAuthorised(req: Request, cfg: Config): boolean {
  const expected = cfg.dashboardAuth;
  if (!expected) return true;
  const provided = basicCredentials(req);
  if (!provided) return false;
  // Both halves are compared; `&&` on separate calls keeps the work constant.
  const userOk = safeEqual(provided.user, expected.user);
  const passwordOk = safeEqual(provided.password, expected.password);
  return userOk && passwordOk;
}

function unauthorised(realm: boolean): Response {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (realm) headers["www-authenticate"] = DASHBOARD_REALM;
  return new Response(JSON.stringify({ error: { message: "authentication required", type: "authentication_error", code: "unauthorized" } }), {
    status: 401,
    headers: { ...headers, "content-type": "application/json" },
  });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new ApiError(413, "request body too large", "payload_too_large");
  }
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new ApiError(413, "request body too large", "payload_too_large");
  }
  if (text.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ApiError(400, "request body must be a JSON object", "invalid_json");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, "request body is not valid JSON", "invalid_json");
  }
}

// ---------- model catalog ----------

const catalogCache = new Map<string, { at: number; models: ModelInfo[] }>();

function withDefaultModel(models: ModelInfo[]): ModelInfo[] {
  if (models.some((m) => m.id === "gpt-5.6-luna")) return models;
  return [...models, ...seedModels().filter((seed) => seed.id === "gpt-5.6-luna")];
}

async function liveCatalog(cfg: Config, signal?: AbortSignal, quiet = false): Promise<ModelInfo[]> {
  const cached = catalogCache.get(cfg.apiBaseUrl);
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.models;

  const accounts = listAccounts();
  const account = accounts.find((a) => a.state === "active") ?? accounts[0];
  if (!account) return seedModels();

  try {
    const models = await fetchModels(account, signal);
    if (models.length > 0) {
      const merged = withDefaultModel(models);
      catalogCache.set(cfg.apiBaseUrl, { at: Date.now(), models: merged });
      return merged;
    }
  } catch (err) {
    // A background refresh has nobody to tell and may be cancelled with the
    // request that started it; only a foreground catalog call is worth a log.
    if (!quiet) console.warn(`[warm2api] model catalog unavailable: ${String(err)}`);
  }
  return seedModels();
}

function resetCatalogCache(): void {
  catalogCache.clear();
}

/**
 * Model ids for `/api/state` without waiting on the gateway. A cold cache
 * answers from the seed list and refreshes in the background: the state document
 * is polled by the quota script and the dashboard, so a slow upstream must not
 * turn a quota readout into a multi-second hang. The refresh deliberately takes
 * no request signal — the response ends long before the fetch does.
 */
function catalogIds(cfg: Config): string[] {
  const cached = catalogCache.get(cfg.apiBaseUrl);
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.models.map((model) => model.id);
  void liveCatalog(cfg, undefined, true).catch(() => []);
  return (cached?.models ?? seedModels()).map((model) => model.id);
}

function openAIModelList(models: ModelInfo[]): unknown {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: models.map((m) => {
      const at = m.created_at ? Date.parse(m.created_at) : Number.NaN;
      return {
        id: m.id,
        object: "model",
        created: Number.isFinite(at) ? Math.floor(at / 1000) : created,
        owned_by: "warm",
        context_window: m.context_window ?? modelMeta(m.id).context,
      };
    }),
  };
}

function anthropicModelList(models: ModelInfo[]): unknown {
  const data = models.map((m) => ({
    type: "model",
    id: m.id,
    display_name: m.display_name ?? m.id,
    created_at: m.created_at ?? new Date(0).toISOString(),
  }));
  return {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  };
}

// ---------- streaming plumbing ----------

interface StreamParams {
  open: () => Promise<OpenResult>;
  pipe: (events: AsyncGenerator<AnthropicEvent>, onUsage: (raw: AnthropicUsage) => void) => AsyncGenerator<string>;
  onError: (err: unknown) => string;
  surface: "openai" | "anthropic";
  model: string;
  signal: AbortSignal;
}

function eventStream(params: StreamParams): Response {
  const encoder = new TextEncoder();
  const streamBody = new ReadableStream<Uint8Array>({
    async start(controller) {
      const started = Date.now();
      let accountId: string | null = null;
      let usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };
      let logged = false;

      const finish = (status: number, errorCode: string | null): void => {
        if (logged) return;
        logged = true;
        recordRequest({
          accountId,
          surface: params.surface,
          model: params.model,
          status,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          ms: Date.now() - started,
          errorCode,
        });
      };

      try {
        const opened = await params.open();
        accountId = opened.account.id;
        const frames = params.pipe(opened.events, (raw) => {
          usage = raw;
        });
        for await (const frame of frames) controller.enqueue(encoder.encode(frame));
        finish(200, null);
      } catch (err) {
        // Audit before notifying: the client may see the error frame and query
        // the log immediately.
        finish(statusOf(err), codeOf(err));
        try {
          controller.enqueue(encoder.encode(params.onError(err)));
        } catch {
          /* client already gone */
        }
      } finally {
        finish(200, null);
        try {
          controller.close();
        } catch {
          /* already closed by a disconnect */
        }
      }
    },
  });

  return new Response(streamBody, {
    headers: corsHeaders({
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    }),
  });
}

/** Annotate a passthrough event stream with its final usage totals. */
async function* tapUsage(
  events: AsyncGenerator<AnthropicEvent>,
  onUsage: (raw: AnthropicUsage) => void,
): AsyncGenerator<AnthropicEvent> {
  let usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };
  for await (const event of events) {
    if (event.type === "message_start") {
      usage = mergeUsage(usage, asUsage(event.message));
    } else if (event.type === "message_delta") {
      usage = mergeUsage(usage, asUsage(event.usage));
    }
    yield event;
  }
  onUsage(usage);
}

function asUsage(value: unknown): Partial<AnthropicUsage> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = "usage" in value ? value.usage : value;
  if (!source || typeof source !== "object") return undefined;
  const record = source as Record<string, unknown>;
  const pick = (key: string): number | undefined =>
    typeof record[key] === "number" ? (record[key] as number) : undefined;
  return {
    input_tokens: pick("input_tokens") ?? 0,
    output_tokens: pick("output_tokens") ?? 0,
    cache_read_input_tokens: pick("cache_read_input_tokens") ?? 0,
    cache_creation_input_tokens: pick("cache_creation_input_tokens") ?? 0,
  };
}

// ---------- OpenAI surface ----------

function strengthenNudge(request: AnthropicRequest, nudge: string): AnthropicRequest {
  const line = `This is required. ${nudge}`;
  const system = request.system;
  if (Array.isArray(system)) {
    return { ...request, system: [...system, { type: "text", text: line }] };
  }
  return { ...request, system: system ? `${system}\n\n${line}` : line };
}

function strengthenJson(request: AnthropicRequest, schema: unknown): AnthropicRequest {
  const line = `Your previous answer was not valid JSON. Respond with JSON only, matching this schema: ${JSON.stringify(schema)}`;
  const system = request.system;
  if (Array.isArray(system)) {
    return { ...request, system: [...system, { type: "text", text: line }] };
  }
  return { ...request, system: system ? `${system}\n\n${line}` : line };
}

async function openaiChat(req: Request, cfg: Config): Promise<Response> {
  const body = (await readJson(req)) as OpenAIChatRequest;
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new ApiError(400, "messages is required", "invalid_messages");
  }

  const catalog = await liveCatalog(cfg, req.signal);
  const model = resolveModel(body.model, catalog.map((m) => m.id));
  const { request, nudge, jsonSchema } = toAnthropicRequest(body, model);
  const effort = normaliseEffort(body.reasoning_effort);
  if (effort) applyEffort(request, model, effort);

  const id = randomBytes(8).toString("hex");
  const stream = body.stream === true;

  if (stream) {
    const includeUsage = body.stream_options?.include_usage === true;
    return eventStream({
      open: () => openWithRotation({ model, request, signal: req.signal }),
      pipe: (events, onUsage) =>
        sseToOpenAI(events, { id, model, includeUsage, onUsage: (_usage, raw) => onUsage(raw) }),
      onError: (err) => {
        const payload = {
          error: {
            message: err instanceof Error ? err.message : "upstream error",
            type: "api_error",
            code: codeOf(err) ?? "upstream_error",
          },
        };
        return `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`;
      },
      surface: "openai",
      model,
      signal: req.signal,
    });
  }

  // Non-stream: nudge and JSON-schema emulation each get exactly one retry.
  const started = Date.now();
  let payload = request;
  let result: OpenResult | null = null;
  let response = null as Awaited<ReturnType<typeof collectOpenAI>> | null;
  let usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    result = await openWithRotation({ model, request: payload, signal: req.signal });
    response = await collectOpenAI(result.events, {
      id,
      model,
      onUsage: (_usage, raw) => {
        usage = raw;
      },
    });
    if (attempt > 0) break;

    const noToolCall = !response.choices[0]?.message.tool_calls;
    if (nudge && noToolCall) {
      payload = strengthenNudge(payload, nudge);
      continue;
    }
    if (jsonSchema) {
      const text = response.choices[0]?.message.content ?? "";
      if (!parseJsonResponse(text, jsonSchema).ok) {
        payload = strengthenJson(payload, jsonSchema);
        continue;
      }
    }
    break;
  }

  if (!response || !result) throw new ApiError(502, "no upstream response", "no_usable_account", "api_error");

  recordRequest({
    accountId: result.account.id,
    surface: "openai",
    model,
    status: 200,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    ms: Date.now() - started,
    errorCode: null,
  });

  return json(response);
}

// ---------- Anthropic surface ----------

async function anthropicMessages(req: Request, cfg: Config): Promise<Response> {
  const body = (await readJson(req)) as unknown as AnthropicRequest;
  if (!Array.isArray(body.messages)) {
    throw new ApiError(400, "messages is required", "invalid_messages");
  }

  const catalog = await liveCatalog(cfg, req.signal);
  const model = resolveModel(body.model, catalog.map((m) => m.id));
  const request = prepareAnthropicRequest(body, model);

  if (body.stream === true) {
    return eventStream({
      open: () => openWithRotation({ model, request, signal: req.signal }),
      pipe: (events, onUsage) => anthropicFrames(tapUsage(events, onUsage)),
      onError: (err) =>
        errorFrame({
          type: err instanceof UpstreamError ? err.detail.code : "api_error",
          message: err instanceof Error ? err.message : "upstream error",
        }),
      surface: "anthropic",
      model,
      signal: req.signal,
    });
  }

  const started = Date.now();
  const opened = await openWithRotation({ model, request, signal: req.signal });
  const message = await collectMessage(opened.events, model);
  recordRequest({
    accountId: opened.account.id,
    surface: "anthropic",
    model,
    status: 200,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    ms: Date.now() - started,
    errorCode: null,
  });
  return json(message);
}

async function countTokens(req: Request): Promise<Response> {
  const body = (await readJson(req)) as unknown as AnthropicRequest;
  if (!Array.isArray(body.messages)) {
    throw new ApiError(400, "messages is required", "invalid_messages");
  }
  return json({ input_tokens: estimateTokens(body) });
}

// ---------- admin ----------

function accountView(account: Account): unknown {
  const quota = latestQuota(account.id);
  return {
    id: account.id,
    label: account.label,
    plan: account.plan,
    state: account.state,
    state_reason: account.stateReason,
    state_until: account.stateUntil,
    expires_at: account.expiresAt,
    excluded_models: account.excludedModels,
    remaining_usd: quota ? quota.remainingMicro / 1_000_000 : null,
    limit_usd: quota ? quota.limitMicro / 1_000_000 : null,
    resets_at: quota?.resetsAt ? new Date(quota.resetsAt).toISOString() : null,
    // The binding budget is not always a rolling window: a drained one-time
    // credits pool retires the account too, so the UI must show both.
    binding: quota?.binding ?? null,
    binding_label: quota?.bindingLabel ?? null,
    lifetime_remaining_usd: quota?.lifetime ? quota.lifetime.remainingMicro / 1_000_000 : null,
    lifetime_limit_usd: quota?.lifetime ? quota.lifetime.limitMicro / 1_000_000 : null,
    windows: quota
      ? quota.windows.map((window) => ({
          id: window.id,
          label: window.label,
          remaining_usd: window.remainingMicro / 1_000_000,
          limit_usd: window.limitMicro / 1_000_000,
          resets_at: window.resetsAt ? new Date(window.resetsAt).toISOString() : null,
        }))
      : [],
    requests: account.requests,
    input_tokens: account.inputTokens,
    output_tokens: account.outputTokens,
    cache_read_tokens: account.cacheReadTokens,
    credits_spent_usd: account.creditsSpentMicro / 1_000_000,
  };
}

function healthz(): Response {
  const counts = accountCounts();
  // Same shape as the proxy this repo follows: a probe can tell version, guard
  // mode and pool size from one unauthenticated call.
  return json({
    ok: true,
    version: CLIENT_VERSION,
    mode: getConfig().requireApiKey ? "guarded" : "open",
    dashboard: getConfig().dashboardAuth ? "basic" : "open",
    accounts: counts,
    accounts_total: counts.total,
  });
}

async function adminAccounts(req: Request, cfg: Config, path: string): Promise<Response> {
  if (path === "/admin/accounts") {
    if (req.method === "GET") return json({ accounts: listAccounts().map(accountView) });
    if (req.method === "POST") {
      const body = await readJson(req);
      const token = typeof body.accessToken === "string" ? body.accessToken.trim() : "";
      if (token.length === 0) throw new ApiError(400, "accessToken is required", "invalid_request");
      const expiresAt =
        typeof body.expiresAt === "number"
          ? body.expiresAt
          : Date.now() + (typeof body.expiresIn === "number" ? body.expiresIn : 30 * 24 * 3600) * 1000;
      const account = addAccount({
        label: typeof body.label === "string" && body.label.trim() !== "" ? body.label.trim() : "manual",
        accessToken: token,
        expiresAt,
        clientFingerprint: typeof body.clientFingerprint === "string" ? body.clientFingerprint : null,
        plan: typeof body.plan === "string" ? body.plan : undefined,
      });
      resetCatalogCache();
      return json(accountView(account), 201);
    }
    return jsonError(405, "method not allowed", "method_not_allowed");
  }

  const match = /^\/admin\/accounts\/([^/]+)(\/revive)?$/.exec(path);
  if (!match) return jsonError(404, "unknown route", "not_found");
  const id = safeDecode(match[1]);
  if (!getAccount(id)) return jsonError(404, `no such account: ${id}`, "not_found");

  if (match[2] === "/revive") {
    if (req.method !== "POST") return jsonError(405, "method not allowed", "method_not_allowed");
    reviveAccount(id);
    return json({ ok: true, id, state: "active" });
  }
  if (req.method === "DELETE") {
    purgeAccount(id);
    resetCatalogCache();
    return json({ ok: true, deleted: id });
  }
  return jsonError(405, "method not allowed", "method_not_allowed");
}

function adminUsage(): Response {
  return json({
    accounts: listAccounts().map(accountView),
    last_24h: summary(24),
  });
}

// ---------- router ----------

/**
 * Admission control. Bodies are held in memory up to MAX_BODY_BYTES, so what
 * bounds memory is request bytes in flight, not request count: counting requests
 * would either reject normal traffic (a stream holds its slot for its whole
 * duration) or still allow N x 32 MB. Shed with 503 once the byte budget is gone.
 */
function maxInFlightBytes(): number {
  const raw = Number(process.env.WARM2API_MAX_IN_FLIGHT_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 256 * 1024 * 1024;
}

let inFlightBytes = 0;

/** Only inference is shed; admin, health and billing must stay answerable. */
function isInferencePath(path: string): boolean {
  if (path.startsWith("/v1/dashboard/")) return false;
  return path.startsWith("/v1/") || path === "/v1/messages";
}

async function handle(req: Request, cfg: Config): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;

  if (!isInferencePath(path)) return route(req, cfg, url, path);

  // A chunked body declares nothing, so reserve a conservative floor: without it
  // an unknown-size stream would cost zero and slip past the budget entirely.
  const UNKNOWN_BODY_RESERVE = 1024 * 1024;
  const declared = Number(req.headers.get("content-length") ?? 0);
  const cost = Number.isFinite(declared) && declared > 0 ? declared : UNKNOWN_BODY_RESERVE;
  if (inFlightBytes + cost > maxInFlightBytes()) {
    // Close the connection: a rejected upload must not keep streaming a body the
    // proxy has already refused to read.
    return new Response(
      JSON.stringify({ error: { message: "proxy is at capacity, retry shortly", type: "api_error", code: "overloaded" } }),
      { status: 503, headers: { "content-type": "application/json", "retry-after": "1", connection: "close" } },
    );
  }
  inFlightBytes += cost;
  try {
    return await route(req, cfg, url, path);
  } finally {
    inFlightBytes -= cost;
  }
}



async function route(req: Request, cfg: Config, url: URL, path: string): Promise<Response> {

  try {
    if (path === "/" || path === "/index.html") {
      if (req.method !== "GET") return jsonError(405, "method not allowed", "method_not_allowed");

      // `?dash=0` hides the UI and `?dash=1` forces it, even when the operator
      // disabled it for everyone with WARM2API_DASHBOARD=0. The query wins in
      // both directions so the escape hatch always works.
      const dash = url.searchParams.get("dash");
      const dashOff = dash === "0" || (dash !== "1" && (process.env.WARM2API_DASHBOARD ?? "").trim() === "0");
      if (dashOff) {
        return json({
          ok: true,
          dashboard: "off",
          hint: "add ?dash=1 for one view, or unset WARM2API_DASHBOARD=0 to enable it for good",
          api: ["/v1/chat/completions", "/v1/messages", "/v1/models", "/healthz", "/admin/stats"],
        });
      }

      if (!dashboardAuthorised(req, cfg)) return unauthorised(true);
      const keyParam = url.searchParams.get("key");
      if (keyParam !== null) {
        if (!safeEqual(keyParam, cfg.apiKey)) return jsonError(401, "invalid api key", "invalid_api_key", "authentication_error");
        return new Response(null, {
          status: 302,
          headers: { location: "/", "set-cookie": authCookie(cfg.apiKey), "cache-control": "no-store" },
        });
      }
      return new Response(UI_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (path === "/favicon.ico") return new Response(null, { status: 204 });

    if (path === "/healthz" || path === "/health") {
      if (req.method !== "GET") return jsonError(405, "method not allowed", "method_not_allowed");
      return healthz();
    }

    // Admin surface: the operator's basic-auth credentials guard it whenever
    // configured, and the API key is additionally required when the policy says
    // so (always true on a public bind).
    if (path.startsWith("/admin/")) {
      if (!dashboardAuthorised(req, cfg)) return unauthorised(true);
      const keyOk = authorised(req, cfg.apiKey);
      // A browser that unlocked the dashboard via basic auth still needs the
      // key unless the local policy waives it; a cookie from ?key= satisfies it.
      if (cfg.requireApiKey && !keyOk) {
        return jsonError(401, "invalid api key", "invalid_api_key", "authentication_error");
      }
      return await adminRoute(req, cfg, url, path);
    }

    if (cfg.requireApiKey && !authorised(req, cfg.apiKey)) {
      return jsonError(401, "invalid api key", "invalid_api_key", "authentication_error");
    }

    // Control plane, mirroring the sibling proxy: one state document that the
    // dashboard, the quota script and `hermes usage` all read, plus the one-api
    // billing pair that quota readers already understand. Bare and /v1-prefixed
    // billing paths both exist because consumers disagree about which is real.
    if (path === "/api/state") {
      if (req.method !== "GET") return jsonError(405, "method not allowed", "method_not_allowed");
      return json(apiState(catalogIds(cfg)));
    }

    if (path === "/api/refresh") {
      if (req.method !== "POST") return jsonError(405, "method not allowed", "method_not_allowed");
      resetCatalogCache();
      const results = await pollOnce(cfg);
      return json({ ...apiState(catalogIds(cfg)), polled: results });
    }

    if (path === "/dashboard/billing/subscription" || path === "/v1/dashboard/billing/subscription") {
      if (req.method !== "GET") return jsonError(405, "method not allowed", "method_not_allowed");
      return json(billingSubscription());
    }

    if (path === "/dashboard/billing/usage" || path === "/v1/dashboard/billing/usage") {
      if (req.method !== "GET") return jsonError(405, "method not allowed", "method_not_allowed");
      return json(billingUsage(url.searchParams.get("start_date"), url.searchParams.get("end_date")));
    }

    if (path === "/v1/models") {
      if (req.method !== "GET") return jsonError(405, "method not allowed", "method_not_allowed");
      const models = await liveCatalog(cfg, req.signal);
      return json(req.headers.get("anthropic-version") ? anthropicModelList(models) : openAIModelList(models));
    }

    if (path === "/v1/chat/completions") {
      if (req.method !== "POST") return jsonError(405, "method not allowed", "method_not_allowed");
      return await openaiChat(req, cfg);
    }

    if (path === "/v1/messages") {
      if (req.method !== "POST") return jsonError(405, "method not allowed", "method_not_allowed");
      return await anthropicMessages(req, cfg);
    }

    if (path === "/v1/messages/count_tokens") {
      if (req.method !== "POST") return jsonError(405, "method not allowed", "method_not_allowed");
      return await countTokens(req);
    }

    return jsonError(404, `unknown route: ${path}`, "not_found");
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Admin routes. Reached only through the guards in `route`: basic auth when
 * configured, plus the API key when the policy requires it.
 */
async function adminRoute(req: Request, cfg: Config, url: URL, path: string): Promise<Response> {
if (path === "/admin/stats") {
  if (req.method !== "GET") return jsonError(405, "method not allowed", "method_not_allowed");
  return json({
    now: Date.now(),
    uptime_s: uptimeSeconds(),
    today: summary(24),
    series: series(24, 24),
    by_model: byModel(24, 6),
    recent: recent(12),
  });
}

if (path === "/admin/usage") {
  if (req.method !== "GET") return jsonError(405, "method not allowed", "method_not_allowed");
  return adminUsage();
}

if (path === "/admin/accounts" || path.startsWith("/admin/accounts/")) {
  return await adminAccounts(req, cfg, path);
}

if (path === "/admin/models") {
  if (req.method !== "GET") return jsonError(405, "method not allowed", "method_not_allowed");
  const catalog = await liveCatalog(cfg, req.signal);
  return json({
    models: catalog.map((model) => {
      const meta = modelMeta(model.id);
      const caps = model.capabilities;
      const flag = (key: string, fallback?: unknown): boolean =>
        (typeof caps === "object" && caps !== null && Boolean((caps as Record<string, unknown>)[key])) || fallback === true;
      return {
        id: model.id,
        name: typeof model.display_name === "string" ? model.display_name : model.id,
        context: typeof model.context_window === "number" ? model.context_window : meta.context,
        max_output: typeof model.max_output_tokens === "number" ? model.max_output_tokens : meta.maxOutput,
        thinking: model.thinking === true || model.reasoning === true,
        tools: flag("tools"),
        vision: flag("vision"),
        input_per_m: meta.inPerM ?? null,
        output_per_m: meta.outPerM ?? null,
      };
    }),
  });
}

if (path === "/admin/login") {
  if (req.method !== "POST") return jsonError(405, "method not allowed", "method_not_allowed");
  return json(await startLogin(cfg));
}

if (path.startsWith("/admin/login/")) {
  if (req.method !== "GET") return jsonError(405, "method not allowed", "method_not_allowed");
  const view = getLogin(safeDecode(path.slice("/admin/login/".length)));
  if (!view) return jsonError(404, "no such login", "not_found");
  return json(view);
}

if (path === "/admin/poll") {
  if (req.method !== "POST") return jsonError(405, "method not allowed", "method_not_allowed");
  const results = await pollOnce(cfg);
  return json({ results });
}

  return jsonError(404, `unknown route: ${path}`, "not_found");
}

async function alreadyServing(cfg: Config): Promise<boolean> {
  try {
    const res = await fetch(`http://${cfg.host}:${cfg.port}/healthz`, {
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  }
}

export async function startServer(cfg: Config): Promise<RunningServer> {
  if (await alreadyServing(cfg)) {
    return {
      url: `http://${cfg.host}:${cfg.port}`,
      port: cfg.port,
      external: true,
      stop() {},
    };
  }

  const server = Bun.serve({
    hostname: cfg.host,
    port: cfg.port,
    idleTimeout: 255,
    fetch: (req) => handle(req, cfg),
  });

  const port = server.port ?? cfg.port;
  return {
    url: `http://${cfg.host}:${port}`,
    port,
    external: false,
    stop() {
      server.stop(true);
    },
  };
}

export { resetCatalogCache, handle };
