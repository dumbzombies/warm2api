// Rotation. One client request may consume several accounts; the policy is the
// difference between "quota exhausted" and "wedged pool", so it lives alone.

import { ApiError } from "./errors.ts";
import { attestationEnabled } from "./attest.ts";
import { openMessages, UpstreamError, type WarmError } from "./upstream.ts";
import {
  excludeModel,
  retireAccount,
  selectAccount,
  setAccountState,
  type Account,
} from "./accounts.ts";
import type { AnthropicEvent, AnthropicRequest } from "./types.ts";

const MAX_ROTATIONS = 3;
const SAME_ACCOUNT_ATTEMPTS = 3;

export interface OpenResult {
  account: Account;
  events: AsyncGenerator<AnthropicEvent>;
}

function networkDetail(err: unknown): WarmError {
  const message = err instanceof Error ? err.message : String(err);
  return { code: "network", status: 502, message, recoverable: true };
}

type Decision = { error: ApiError } | { rotate: boolean; retry: boolean };

/**
 * Apply the client's own failure→action table to one upstream error, and report
 * whether this request should retry the same account, rotate, or stop.
 */
export function applyAccountAction(detail: WarmError, accountId: string | null, model: string): Decision {
  const now = Date.now();
  switch (detail.code) {
    case "usage_window_exceeded":
      if (accountId) retireAccount(accountId, detail.code, detail.restoresAt ?? null);
      return { rotate: true, retry: false };
    case "rate_limit":
      if (accountId) {
        setAccountState(
          accountId,
          "cooling",
          detail.code,
          now + (detail.retryAfterSeconds && detail.retryAfterSeconds > 0 ? detail.retryAfterSeconds : 60) * 1000,
        );
      }
      return { rotate: true, retry: false };
    case "account_disabled":
      if (accountId) setAccountState(accountId, "disabled", detail.code, null);
      return {
        error: new ApiError(403, detail.message, "account_disabled", "permission_error"),
      };
    case "access_reverification_required":
      if (accountId) setAccountState(accountId, "needs_verification", detail.message, null);
      return {
        error: new ApiError(403, detail.message, "access_reverification_required", "permission_error"),
      };
    case "model_not_on_plan":
      if (accountId) excludeModel(accountId, model);
      return { rotate: true, retry: false };
    case "client_update_required":
      return {
        error: new ApiError(502, "upstream Warm client is outdated", "upstream_client_outdated", "api_error"),
      };
    case "context_overflow":
      return { error: new ApiError(400, detail.message, "context_length_exceeded") };
    case "overloaded":
    case "network":
    case "upstream_timeout":
      // A stalled gateway is indistinguishable from a broken one: another account
      // (or another attempt) is the only way to serve the caller.
      return { rotate: true, retry: true };
    default:
      break;
  }

  if (detail.status === 401) {
    if (accountId) setAccountState(accountId, "needs_login", detail.code, null);
    return { rotate: true, retry: false };
  }
  // A 400 is the caller's bug; rotating would silently burn accounts.
  if (detail.status === 400) {
    return { error: new ApiError(400, detail.message, detail.code) };
  }
  if (detail.status === 429) {
    if (accountId) {
      setAccountState(accountId, "cooling", detail.code, now + (detail.retryAfterSeconds ?? 60) * 1000);
    }
    return { rotate: true, retry: false };
  }
  return {
    error: new ApiError(
      detail.status >= 400 && detail.status < 600 ? detail.status : 502,
      detail.message,
      detail.code,
      "api_error",
    ),
  };
}

async function* prepend(
  first: IteratorResult<AnthropicEvent>,
  rest: AsyncGenerator<AnthropicEvent>,
): AsyncGenerator<AnthropicEvent> {
  try {
    if (!first.done) yield first.value;
    for await (const event of rest) yield event;
  } finally {
    await rest.return(undefined);
  }
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export interface OpenOptions {
  model: string;
  request: AnthropicRequest;
  signal: AbortSignal;
}

/**
 * Open one upstream message stream, rotating accounts per the policy. The HTTP
 * exchange and first event are completed before returning, so failure here never
 * leaves a half-written response.
 */
export async function openWithRotation(opts: OpenOptions): Promise<OpenResult> {
  const tried = new Set<string>();
  let rotations = 0;

  for (;;) {
    const account = selectAccount(opts.model, Date.now(), tried);
    if (!account) break;
    tried.add(account.id);

    for (let attempt = 0; attempt < SAME_ACCOUNT_ATTEMPTS; attempt += 1) {
      try {
        const events = await openMessages(account, opts.request, {
          signal: opts.signal,
          attestation: attestationEnabled(),
        });
        const first = await events.next();
        return { account, events: prepend(first, events) };
      } catch (err) {
        if (opts.signal.aborted) throw err;
        const detail = err instanceof UpstreamError ? err.detail : networkDetail(err);
        const decision = applyAccountAction(detail, account.id, opts.model);
        if ("error" in decision) throw decision.error;
        if (decision.retry && attempt < SAME_ACCOUNT_ATTEMPTS - 1) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        break;
      }
    }

    rotations += 1;
    if (rotations > MAX_ROTATIONS) break;
  }

  throw new ApiError(502, "no usable Warm account", "no_usable_account", "api_error");
}
