// The only place that speaks HTTP to Warm. Every upstream body is normalised
// into a WarmError so routing can decide per code instead of per status.

import { getConfig } from "./config.ts";
import { ensureAttestation, injectSentinel, signRequest } from "./attest.ts";
import { reserveAttestSeq, type Account } from "./accounts.ts";
import type {
  AnthropicEvent,
  AnthropicRequest,
  AnthropicUsage,
  ModelInfo,
  RecentRuns,
  UsageSnapshot,
} from "./types.ts";

export interface WarmError {
  code: string;
  status: number;
  message: string;
  recoverable: boolean;
  retryAfterSeconds?: number;
  restoresAt?: number;
  plan?: string;
  included?: string[];
  requestId?: string;
  body?: string;
}

export class UpstreamError extends Error {
  readonly detail: WarmError;

  constructor(detail: WarmError) {
    super(detail.message);
    this.name = "UpstreamError";
    this.detail = detail;
  }
}

const STREAM_ERRORS: Record<string, { code: string; status: number }> = {
  overloaded_error: { code: "overloaded", status: 529 },
  rate_limit_error: { code: "rate_limit", status: 429 },
  authentication_error: { code: "unauthorized", status: 401 },
  permission_error: { code: "forbidden", status: 403 },
  invalid_request_error: { code: "invalid_request", status: 400 },
  api_error: { code: "upstream_error", status: 500 },
};

function firstOf(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function isoToMs(value: unknown): number | undefined {
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string") {
    const at = Date.parse(value);
    return Number.isFinite(at) ? at : undefined;
  }
  return undefined;
}

/** Turn any upstream failure body into the one error shape routing understands. */
export function mapUpstreamError(status: number, raw: string, retryAfterHeader?: string | null): WarmError {
  let parsed: Record<string, unknown> | null = null;
  try {
    const candidate: unknown = JSON.parse(raw);
    if (candidate && typeof candidate === "object") parsed = candidate as Record<string, unknown>;
  } catch {
    /* plain-text error body */
  }

  const nested =
    parsed && typeof parsed.error === "object" && parsed.error !== null
      ? (parsed.error as Record<string, unknown>)
      : null;

  const codeValue =
    (parsed ? firstOf(parsed, ["code", "error_code"]) : undefined) ??
    (nested ? firstOf(nested, ["code", "type"]) : undefined) ??
    (parsed && typeof parsed.error === "string" ? parsed.error : undefined);
  const code = typeof codeValue === "string" && codeValue.length > 0 ? codeValue : `http_${status}`;

  const messageValue =
    (parsed ? firstOf(parsed, ["detail", "message", "title"]) : undefined) ??
    (nested ? firstOf(nested, ["message", "detail"]) : undefined) ??
    raw.slice(0, 300).trim();
  const message = typeof messageValue === "string" && messageValue.length > 0 ? messageValue : `upstream error ${status}`;

  const retryRaw =
    (parsed ? firstOf(parsed, ["retry_after_seconds", "retry_after", "retryAfterSeconds"]) : undefined) ??
    (nested ? firstOf(nested, ["retry_after_seconds", "retry_after"]) : undefined);
  const retryAfterSeconds =
    typeof retryRaw === "number"
      ? retryRaw
      : typeof retryRaw === "string" && retryRaw.trim() !== ""
        ? Number(retryRaw)
        : retryAfterHeader
          ? Number(retryAfterHeader)
          : undefined;

  const restoresAt =
    isoToMs(parsed ? firstOf(parsed, ["restores_at", "restoresAt", "resets_at"]) : undefined) ?? undefined;
  const plan = (parsed ? firstOf(parsed, ["plan"]) : undefined) ?? undefined;
  const includedRaw = (parsed ? firstOf(parsed, ["included", "models"]) : undefined) ?? undefined;
  const included = Array.isArray(includedRaw) ? includedRaw.filter((m): m is string => typeof m === "string") : undefined;
  const requestIdRaw = (parsed ? firstOf(parsed, ["request_id", "requestId"]) : undefined) ?? undefined;

  return {
    code,
    status,
    message,
    recoverable: code === "overloaded" || code === "network" || status === 529,
    ...(Number.isFinite(retryAfterSeconds) ? { retryAfterSeconds } : {}),
    ...(restoresAt ? { restoresAt } : {}),
    ...(typeof plan === "string" ? { plan } : {}),
    ...(included && included.length > 0 ? { included } : {}),
    ...(typeof requestIdRaw === "string" ? { requestId: requestIdRaw } : {}),
    body: raw.slice(0, 4000),
  };
}

async function errorFromResponse(res: Response): Promise<UpstreamError> {
  const raw = await res.text().catch(() => "");
  return new UpstreamError(mapUpstreamError(res.status, raw, res.headers.get("retry-after")));
}

/** Control-plane calls need only the credential pair; openMessages needs the row. */
export interface Credentials {
  accessToken: string;
  clientFingerprint: string | null;
}

function controlHeaders(account: Credentials): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${account.accessToken}`,
    "x-warm-client": `keelcode-cli/${getConfig().clientVersion}`,
  };
  if (account.clientFingerprint) headers["x-warm-client-fingerprint"] = account.clientFingerprint;
  return headers;
}

function decodeFrame(frame: string): AnthropicEvent | null {
  let data = "";
  for (const line of frame.split("\n")) {
    if (!line.startsWith("data:")) continue;
    data += (data.length > 0 ? "\n" : "") + line.slice(5).trimStart();
  }
  if (data.length === 0 || data === "[DONE]") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new UpstreamError({
      code: "malformed_stream",
      status: 502,
      message: "upstream sent a malformed SSE frame",
      recoverable: false,
      body: data.slice(0, 500),
    });
  }
  if (!parsed || typeof parsed !== "object") return null;
  const event = parsed as AnthropicEvent;
  if (typeof event.type !== "string") return null;

  if (event.type === "error") {
    const err = (event.error ?? {}) as { type?: unknown; message?: unknown };
    const mapped = STREAM_ERRORS[String(err.type ?? "api_error")] ?? STREAM_ERRORS.api_error;
    throw new UpstreamError({
      code: mapped.code,
      status: mapped.status,
      message: typeof err.message === "string" ? err.message : "upstream stream error",
      recoverable: mapped.code === "overloaded",
      body: data.slice(0, 500),
    });
  }
  return event;
}

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<AnthropicEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  /**
   * Split complete frames off the buffer. A CRLF pair may straddle a chunk
   * boundary, so a lone trailing "\r" is held back until its "\n" arrives.
   */
  const takeFrames = (): string[] => {
    const frames: string[] = [];
    for (;;) {
      const lf = buffer.indexOf("\n\n");
      const crlf = buffer.indexOf("\r\n\r\n");
      const useLf = lf !== -1 && (crlf === -1 || lf <= crlf);
      const at = useLf ? lf : crlf;
      if (at === -1) break;
      frames.push(buffer.slice(0, at).replace(/\r\n/g, "\n"));
      buffer = buffer.slice(at + (useLf ? 2 : 4));
    }
    return frames;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const frame of takeFrames()) {
        const event = decodeFrame(frame);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    for (const frame of takeFrames()) {
      const event = decodeFrame(frame);
      if (event) yield event;
    }
    const tail = buffer.trim();
    if (tail.length > 0) {
      const event = decodeFrame(tail.replace(/\r\n/g, "\n"));
      if (event) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

export interface StreamOptions {
  signal: AbortSignal;
  attestation: boolean;
}

/**
 * POST /v1/messages and hand back an event stream. The HTTP exchange is complete
 * before the generator is returned, so a caller may still rotate accounts on a
 * status error without having written a byte to its own client.
 */
/** A gateway that has not answered by now is not going to answer usefully. */
function positiveEnvMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function upstreamHeaderTimeoutMs(): number {
  return positiveEnvMs("WARM2API_UPSTREAM_TIMEOUT_MS", 120_000);
}

/**
 * Control-plane calls (`/v1/models`, `/api/v1/usage`, `/api/v1/me`) are small
 * JSON exchanges, so they get a much shorter bound than a generation. Without
 * one, a wedged gateway pins the request, the caller's socket and — for the
 * catalog refresh — a background promise forever.
 */
export function controlTimeoutMs(): number {
  return positiveEnvMs("WARM2API_CONTROL_TIMEOUT_MS", 15_000);
}

/** Combine the caller's signal with our own deadline. */
function bounded(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function openMessages(
  account: Account,
  request: AnthropicRequest,
  opts: StreamOptions,
): Promise<AsyncGenerator<AnthropicEvent>> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    "anthropic-version": "2023-06-01",
    authorization: `Bearer ${account.accessToken}`,
    "x-warm-client": `keelcode-cli/${getConfig().clientVersion}`,
  };
  if (account.clientFingerprint) headers["x-warm-client-fingerprint"] = account.clientFingerprint;

  let outgoing: AnthropicRequest = { ...request, stream: true };
  let attest = account.attest;

  if (opts.attestation) {
    attest = await ensureAttestation(account, opts.signal);
    if (attest) outgoing = injectSentinel(outgoing);
  }
  if (JSON.stringify(outgoing).includes('"cache_control"')) {
    headers["anthropic-beta"] = "prompt-caching-2024-07-31";
  }

  const body = JSON.stringify(outgoing);
  if (opts.attestation && attest) {
    const seq = reserveAttestSeq(account.id);
    headers["x-warm-attest"] = attest.token;
    headers["x-warm-attest-sig"] = signRequest(
      { ...account, attest },
      seq,
      Date.now(),
      "POST",
      "/v1/messages",
      body,
    );
  }

  // The client's signal is the only abort source today, so a gateway that
  // accepts the connection and then stalls would pin the request, its socket and
  // the selected account forever. Bound the wait for headers; the stream that
  // follows is still governed by the client and by the server's idle timeout.
  const res = await fetch(new URL("/v1/messages", getConfig().apiBaseUrl), {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.any([opts.signal, AbortSignal.timeout(upstreamHeaderTimeoutMs())]),
  }).catch((err: unknown) => {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new UpstreamError({
        code: "upstream_timeout",
        status: 504,
        message: `upstream sent no response within ${upstreamHeaderTimeoutMs() / 1000}s`,
        recoverable: true,
      });
    }
    throw err;
  });
  if (!res.ok) throw await errorFromResponse(res);
  if (!res.body) {
    throw new UpstreamError({
      code: "network",
      status: 502,
      message: "upstream returned no body",
      recoverable: true,
    });
  }
  return parseSse(res.body);
}

export async function fetchModels(account: Credentials, signal?: AbortSignal): Promise<ModelInfo[]> {
  const res = await fetch(new URL("/v1/models", getConfig().apiBaseUrl), {
    headers: controlHeaders(account),
    signal: bounded(signal, controlTimeoutMs()),
  });
  if (!res.ok) throw await errorFromResponse(res);
  const body: unknown = await res.json();
  const list = Array.isArray(body) ? body : modelListField(body);
  return list
    .map((entry) => {
      if (typeof entry === "string") return { id: entry };
      if (!entry || typeof entry !== "object") return null;
      const model = entry as Record<string, unknown>;
      if (typeof model.id !== "string") return null;
      return model as unknown as ModelInfo;
    })
    .filter((m): m is ModelInfo => m !== null);
}

export interface UsageRaw {
  raw: string;
  parsed: UsageSnapshot;
}

export async function fetchUsageRaw(account: Credentials, signal?: AbortSignal): Promise<UsageRaw> {
  const res = await fetch(new URL("/api/v1/usage", getConfig().apiBaseUrl), {
    headers: controlHeaders(account),
    signal: bounded(signal, controlTimeoutMs()),
  });
  if (!res.ok) throw await errorFromResponse(res);
  const raw = await res.text();
  let parsed: UsageSnapshot = {};
  try {
    const candidate: unknown = JSON.parse(raw);
    if (candidate && typeof candidate === "object") parsed = candidate as UsageSnapshot;
  } catch {
    parsed = {};
  }
  return { raw, parsed };
}

export async function fetchUsage(account: Credentials, signal?: AbortSignal): Promise<UsageSnapshot> {
  return (await fetchUsageRaw(account, signal)).parsed;
}

export async function fetchMe(
  account: Credentials,
  signal?: AbortSignal,
): Promise<{ id: string; name: string; email: string }> {
  const res = await fetch(new URL("/api/v1/me", getConfig().apiBaseUrl), {
    headers: controlHeaders(account),
    signal: bounded(signal, controlTimeoutMs()),
  });
  if (!res.ok) throw await errorFromResponse(res);
  const body = (await res.json()) as Partial<{ id: string; name: string; email: string }>;
  return {
    id: typeof body.id === "string" ? body.id : "",
    name: typeof body.name === "string" ? body.name : "",
    email: typeof body.email === "string" ? body.email : "",
  };
}

export async function fetchRecent(account: Credentials, signal?: AbortSignal): Promise<RecentRuns> {
  const res = await fetch(new URL("/api/v1/usage/recent", getConfig().apiBaseUrl), {
    headers: controlHeaders(account),
    signal: bounded(signal, controlTimeoutMs()),
  });
  if (!res.ok) throw await errorFromResponse(res);
  const body = (await res.json()) as unknown;
  return body && typeof body === "object" ? (body as RecentRuns) : {};
}

export async function mergeWindow(
  account: Credentials,
  scope: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const res = await fetch(new URL("/api/v1/usage/windows/merge", getConfig().apiBaseUrl), {
    method: "POST",
    headers: { ...controlHeaders(account), "content-type": "application/json" },
    body: JSON.stringify({ scope }),
    signal: bounded(signal, controlTimeoutMs()),
  });
  if (!res.ok) throw await errorFromResponse(res);
  return res.json();
}

/** Fold one `usage` object into a running anthropic-style total. */
export function mergeUsage(target: AnthropicUsage, update: Partial<AnthropicUsage> | undefined): AnthropicUsage {
  if (!update) return target;
  const pick = (next: unknown, current: number): number =>
    typeof next === "number" && Number.isFinite(next) ? Math.max(current, next) : current;
  return {
    input_tokens: pick(update.input_tokens, target.input_tokens),
    output_tokens: pick(update.output_tokens, target.output_tokens),
    cache_read_input_tokens: pick(update.cache_read_input_tokens, target.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens: pick(
      update.cache_creation_input_tokens,
      target.cache_creation_input_tokens ?? 0,
    ),
  };
}

/** `/v1/models` has been seen as a bare array, `{data}` and `{models}`. */
function modelListField(body: unknown): unknown[] {
  if (!body || typeof body !== "object") return [];
  for (const key of ["data", "models"] as const) {
    if (key in body) {
      const value: unknown = body[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}
