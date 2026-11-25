// Control-plane views: one pool summary, one `/api/state` payload and the
// one-api billing projection. The shapes follow the mistral-vibe proxy this repo
// is a sibling of, so the same quota script, agent plugins and `hermes usage`
// hook read either proxy without special-casing.
//
// Money crosses the wire in dollars; internally it stays integer micro-dollars,
// so every figure here is a division of an integer, never accumulated float.

import { latestQuota, listAccounts, type Account } from "./accounts.ts";
import { APP_VERSION, getConfig } from "./config.ts";
import { lifetime, recent, series } from "./track.ts";

const startedAt = Date.now();

/** Process uptime, shared by `/healthz`-adjacent routes and `/admin/stats`. */
export function uptimeSeconds(): number {
  return Math.round((Date.now() - startedAt) / 1000);
}

const dollars = (micro: number): number => micro / 1_000_000;
const round = (value: number, places: number): number => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** States that can still serve a request, or will after a refill. */
function reportsQuota(account: Account): boolean {
  return account.state !== "disabled" && account.state !== "needs_login" && account.state !== "needs_verification";
}

export interface PoolSummary {
  /** Accounts with a quota snapshot that the pool may draw on. */
  accounts: number;
  limit_usd: number | null;
  remaining_usd: number | null;
  used_usd: number | null;
  used_percent: number | null;
  /** Which budget binds the pool: a rolling window, or one-time credits. */
  binding: "window" | "lifetime" | null;
  binding_label: string | null;
  /** Earliest moment any counted account's binding budget refills. */
  resets_at: string | null;
}

/**
 * Sum every usable account's binding budget. Retired accounts are counted on
 * purpose — they will be revived, and their spent capacity is the pool's spent
 * capacity. Disabled and logged-out accounts are excluded: they cannot serve.
 */
export function poolSummary(): PoolSummary {
  let remainingMicro = 0;
  let limitMicro = 0;
  let counted = 0;
  let binding: "window" | "lifetime" | null = null;
  let resetsAt: number | null = null;

  for (const account of listAccounts()) {
    if (!reportsQuota(account)) continue;
    const quota = latestQuota(account.id);
    // No snapshot means no known budget: counting it as zero remaining would
    // report a spent pool that was never measured.
    if (!quota) continue;
    counted += 1;
    remainingMicro += quota.remainingMicro;
    limitMicro += quota.limitMicro;
    if (quota.binding === "lifetime") binding = "lifetime";
    else binding ??= "window";
    if (quota.resetsAt !== null && (resetsAt === null || quota.resetsAt < resetsAt)) resetsAt = quota.resetsAt;
  }

  if (counted === 0) {
    return {
      accounts: 0,
      limit_usd: null,
      remaining_usd: null,
      used_usd: null,
      used_percent: null,
      binding: null,
      binding_label: null,
      resets_at: null,
    };
  }

  return {
    accounts: counted,
    limit_usd: dollars(limitMicro),
    remaining_usd: dollars(remainingMicro),
    used_usd: dollars(Math.max(0, limitMicro - remainingMicro)),
    used_percent: limitMicro > 0 ? round(((limitMicro - remainingMicro) / limitMicro) * 100, 2) : null,
    binding,
    binding_label: binding === "lifetime" ? "One-time credits" : "Rolling usage windows",
    resets_at: iso(resetsAt),
  };
}

export interface AccountStateView {
  id: string;
  label: string;
  plan: string;
  state: string;
  state_reason: string | null;
  state_until: string | null;
  remaining_usd: number | null;
  limit_usd: number | null;
  binding: "window" | "lifetime" | null;
  binding_label: string | null;
  resets_at: string | null;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  /** Upstream-reported spend this cycle, or null when no snapshot carries it. */
  spent_usd: number | null;
  /** Local counter, kept for continuity; may read 0 for unpriced models. */
  credits_spent_usd: number;
}

function accountStateView(account: Account): AccountStateView {
  const quota = latestQuota(account.id);
  return {
    id: account.id,
    label: account.label,
    plan: account.plan,
    state: account.state,
    state_reason: account.stateReason,
    state_until: iso(account.stateUntil),
    remaining_usd: quota ? dollars(quota.remainingMicro) : null,
    limit_usd: quota ? dollars(quota.limitMicro) : null,
    binding: quota?.binding ?? null,
    binding_label: quota?.bindingLabel ?? null,
    resets_at: quota ? iso(quota.resetsAt) : null,
    requests: account.requests,
    input_tokens: account.inputTokens,
    output_tokens: account.outputTokens,
    cache_read_tokens: account.cacheReadTokens,
    spent_usd: quota?.spentMicro === null || quota?.spentMicro === undefined ? null : dollars(quota.spentMicro),
    credits_spent_usd: dollars(account.creditsSpentMicro),
  };
}

const STATE_KEYS = ["active", "cooling", "retired", "disabled", "needs_verification", "needs_login"] as const;

export function accountCounts(): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(STATE_KEYS.map((key) => [key, 0]));
  let total = 0;
  for (const account of listAccounts()) {
    counts[account.state] = (counts[account.state] ?? 0) + 1;
    total += 1;
  }
  return { ...counts, total };
}

/**
 * The control-plane payload. `/api/state` serves it, the dashboard's quota view
 * and `hermes usage` read it, and `plugins/shared/warm-quota.sh` prints it.
 * `models` is passed in because the caller owns the catalog cache.
 */
export function apiState(models: readonly string[]): Record<string, unknown> {
  const cfg = getConfig();
  const totals = lifetime();
  // Anthropic reports `input_tokens` as the *uncached* reminder of the prompt;
  // the parts served from cache are separate. So the prompt total — what OpenAI
  // calls `prompt_tokens`, and what a reader means by "tokens in" — is the sum.
  const promptTokens = totals.input_tokens + totals.cache_read_tokens;
  return {
    ok: true,
    version: APP_VERSION,
    mode: cfg.requireApiKey ? "guarded" : "open",
    dashboard: cfg.dashboardAuth ? "basic" : "open",
    uptime_s: uptimeSeconds(),
    accounts: { ...accountCounts(), list: listAccounts().map(accountStateView) },
    pool: poolSummary(),
    requests: {
      total: totals.requests,
      errors: totals.failures,
      tokens_in: promptTokens,
      tokens_out: totals.output_tokens,
      tokens_cached: totals.cache_read_tokens,
      // No tokens measured yet is "unknown", not "0% cached": the same rule the
      // pool figures follow, so a reader cannot mistake an idle proxy for a
      // proxy whose cache never hits. The denominator is the full prompt, or a
      // heavily cached workload reports more than 100% (`74240/58497` = 127%).
      cache_hit_pct: promptTokens > 0 ? round((totals.cache_read_tokens / promptTokens) * 100, 1) : null,
      buckets: series(24, 24),
    },
    models: [...models],
    log: recent(20),
  };
}

export interface BillingNumbers {
  limit_usd: number | null;
  used_usd: number | null;
  remaining_usd: number | null;
  used_percent: number | null;
  resets_at: string | null;
}

export function billingNumbers(): BillingNumbers {
  const pool = poolSummary();
  return {
    limit_usd: pool.limit_usd,
    used_usd: pool.used_usd,
    remaining_usd: pool.remaining_usd,
    used_percent: pool.used_percent,
    resets_at: pool.resets_at,
  };
}

/**
 * one-api's `/dashboard/billing/subscription`. Readers pick any one of the three
 * hard limits, so all three carry the pool capacity (the upstream reports a
 * single spending ceiling per account, summed here across the pool).
 */
export function billingSubscription(): unknown {
  const n = billingNumbers();
  const until = n.resets_at === null ? 0 : Math.floor(Date.parse(n.resets_at) / 1000);
  return {
    object: "billing_subscription",
    has_payment_method: true,
    hard_limit_usd: n.limit_usd ?? 0,
    soft_limit_usd: n.limit_usd ?? 0,
    system_hard_limit_usd: n.limit_usd ?? 0,
    access_until: Number.isFinite(until) ? until : 0,
    remaining_usd: n.remaining_usd,
    used_usd: n.used_usd,
    currency: "USD",
    cycle: "account",
  };
}

/**
 * one-api's `/dashboard/billing/usage`. `total_usage` is CENTS — readers divide
 * by 100. The upstream reports cycle totals, not a daily breakdown, so
 * `daily_costs` stays empty rather than inventing a series.
 */
export function billingUsage(startDate: string | null, endDate: string | null): unknown {
  const n = billingNumbers();
  return {
    object: "list",
    total_usage: Math.round((n.used_usd ?? 0) * 100),
    daily_costs: [],
    remaining_usd: n.remaining_usd,
    used_usd: n.used_usd,
    limit_usd: n.limit_usd,
    used_percent: n.used_percent,
    resets_at: n.resets_at,
    period: { start: startDate, end: endDate },
  };
}
