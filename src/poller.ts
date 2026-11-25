// Quota poller: snapshot every account's `/api/v1/usage`, then apply the refresh
// rule — a retired account whose window refilled goes back to active.

import type { Config } from "./config.ts";
import {
  listAccounts,
  quotaFromSnapshot,
  recordSnapshot,
  reviveAccount,
  setPlan,
  type Account,
} from "./accounts.ts";
import { fetchUsageRaw, UpstreamError } from "./upstream.ts";

export interface PollResult {
  accountId: string;
  ok: boolean;
  plan: string | null;
  remainingMicro: number | null;
  revived: boolean;
  error?: string;
}

const reportedExhaustion = new Set<string>();
const inFlight = new Set<string>();

async function pollAccount(account: Account, cfg: Config, now: number): Promise<PollResult> {
  try {
    const { raw, parsed } = await fetchUsageRaw(account);
    recordSnapshot(account.id, raw, now);

    const plan = typeof parsed.plan === "string" ? parsed.plan : null;
    if (plan) setPlan(account.id, plan);

    const quota = quotaFromSnapshot(raw);
    const remaining = quota ? quota.remainingMicro : null;

    // Refresh rule: refilled ⇒ active. `disabled`/`needs_login` need a human.
    if (account.state === "retired" && remaining !== null && remaining > 0) {
      reviveAccount(account.id);
      reportedExhaustion.delete(account.id);
      return { accountId: account.id, ok: true, plan, remainingMicro: remaining, revived: true };
    }
    if (account.state === "retired" || account.state === "cooling") {
      const untilPassed = account.stateUntil !== null && account.stateUntil <= now;
      if (remaining === 0 && untilPassed) {
        if (!reportedExhaustion.has(account.id)) {
          reportedExhaustion.add(account.id);
          console.warn(
            `[warm2api] ${account.id} still exhausted after its window reset; keeping it retired`,
          );
        }
      }
      if (remaining !== 0 && untilPassed) {
        reviveAccount(account.id);
        reportedExhaustion.delete(account.id);
        return { accountId: account.id, ok: true, plan, remainingMicro: remaining, revived: true };
      }
    }

    return { accountId: account.id, ok: true, plan, remainingMicro: remaining, revived: false };
  } catch (err) {
    const message = err instanceof UpstreamError ? `${err.detail.code}: ${err.detail.message}` : String(err);
    console.warn(`[warm2api] usage poll failed for ${account.id}: ${message}`);
    // A poll failure never flips state by itself.
    return { accountId: account.id, ok: false, plan: null, remainingMicro: null, revived: false, error: message };
  }
}

/** One synchronous polling pass. Exported so tests and `warm2api usage` can drive it. */
export async function pollOnce(cfg: Config): Promise<PollResult[]> {
  const now = Date.now();
  const accounts = listAccounts().filter(
    (a) => a.state === "active" || a.state === "retired" || a.state === "cooling",
  );
  const results: PollResult[] = [];
  for (const account of accounts) {
    if (inFlight.has(account.id)) continue;
    inFlight.add(account.id);
    try {
      results.push(await pollAccount(account, cfg, now));
    } finally {
      inFlight.delete(account.id);
    }
  }
  return results;
}

/** setTimeout chain (±20 % jitter) so a slow upstream cannot stack requests. */
export function startPoller(cfg: Config): () => void {
  let stopped = false;
  let handle: Timer | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await pollOnce(cfg);
    } catch (err) {
      console.warn(`[warm2api] poll pass failed: ${String(err)}`);
    }
    if (stopped) return;
    const jitter = 0.8 + Math.random() * 0.4;
    handle = setTimeout(tick, Math.round(cfg.pollMs * jitter));
  };

  void tick();
  return () => {
    stopped = true;
    clearTimeout(handle);
    handle = null;
  };
}
