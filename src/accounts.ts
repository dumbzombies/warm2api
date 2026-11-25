// Account pool: every state transition and the whole routing policy live here.
// Nothing else in the process is allowed to write `accounts.state`.

import { randomBytes } from "node:crypto";
import { getDb, parseMicro } from "./db.ts";
import { installDeviceFingerprint } from "./attest.ts";

export type AccountState =
  | "active"
  | "cooling"
  | "retired"
  | "disabled"
  | "needs_verification"
  | "needs_login";

export interface Account {
  id: string;
  label: string;
  accessToken: string;
  expiresAt: number;
  clientFingerprint: string | null;
  deviceFingerprint: string;
  plan: string;
  state: AccountState;
  stateReason: string | null;
  stateUntil: number | null;
  attest: { token: string; seed: string; expiresAt: number; seq: number } | null;
  excludedModels: string[];
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  creditsSpentMicro: number;
}

interface AccountRow {
  id: string;
  label: string;
  access_token: string;
  expires_at: number;
  client_fingerprint: string | null;
  device_fingerprint: string;
  plan: string;
  state: AccountState;
  state_reason: string | null;
  state_until: number | null;
  attest_token: string | null;
  attest_seed: string | null;
  attest_expires_at: number | null;
  attest_seq: number;
  excluded_models: string | null;
  created_at: number;
  last_used_at: number | null;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  credits_spent_micro: number;
}

function toAccount(row: AccountRow): Account {
  let excluded: string[] = [];
  if (row.excluded_models) {
    try {
      const parsed: unknown = JSON.parse(row.excluded_models);
      if (Array.isArray(parsed)) excluded = parsed.filter((m): m is string => typeof m === "string");
    } catch {
      /* a corrupt column must never take the pool down */
    }
  }
  return {
    id: row.id,
    label: row.label,
    accessToken: row.access_token,
    expiresAt: row.expires_at,
    clientFingerprint: row.client_fingerprint,
    deviceFingerprint: row.device_fingerprint,
    plan: row.plan,
    state: row.state,
    stateReason: row.state_reason,
    stateUntil: row.state_until,
    attest:
      row.attest_token && row.attest_seed
        ? {
            token: row.attest_token,
            seed: row.attest_seed,
            expiresAt: row.attest_expires_at ?? 0,
            seq: row.attest_seq,
          }
        : null,
    excludedModels: excluded,
    requests: row.requests,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    creditsSpentMicro: row.credits_spent_micro,
  };
}

export function addAccount(input: {
  label: string;
  accessToken: string;
  expiresAt: number;
  clientFingerprint?: string | null;
  plan?: string;
}): Account {
  // Re-approving the same Warm account must not create a second row: the token
  // identifies the account, and duplicates split the quota shown in the UI.
  const existing = getDb()
    .query<AccountRow, [string]>("SELECT * FROM accounts WHERE access_token = ? ORDER BY created_at ASC LIMIT 1")
    .get(input.accessToken);
  if (existing) {
    const expiresAt = Math.max(existing.expires_at, input.expiresAt);
    getDb().run(
      "UPDATE accounts SET expires_at = ?, client_fingerprint = COALESCE(?, client_fingerprint), label = ? WHERE id = ?",
      [expiresAt, input.clientFingerprint ?? null, input.label, existing.id],
    );
    const refreshed = getAccount(existing.id);
    if (!refreshed) throw new Error(`account ${existing.id} vanished during update`);
    return refreshed;
  }
  const id = `acct_${randomBytes(6).toString("hex")}`;
  getDb().run(
    `INSERT INTO accounts (id, label, access_token, expires_at, client_fingerprint,
       device_fingerprint, plan, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    [
      id,
      input.label,
      input.accessToken,
      input.expiresAt,
      input.clientFingerprint ?? null,
      installDeviceFingerprint(),
      input.plan ?? "unknown",
      Date.now(),
    ],
  );
  const created = getAccount(id);
  if (!created) throw new Error("account insert failed");
  return created;
}

export function listAccounts(): Account[] {
  return getDb()
    .query<AccountRow, []>("SELECT * FROM accounts ORDER BY created_at ASC")
    .all()
    .map(toAccount);
}

export function getAccount(id: string): Account | null {
  const row = getDb().query<AccountRow, [string]>("SELECT * FROM accounts WHERE id = ?").get(id);
  return row ? toAccount(row) : null;
}

export function setAccountState(
  id: string,
  state: AccountState,
  reason: string | null,
  until: number | null,
): void {
  getDb().run("UPDATE accounts SET state = ?, state_reason = ?, state_until = ? WHERE id = ?", [
    state,
    reason,
    until,
    id,
  ]);
}

export function setPlan(id: string, plan: string): void {
  getDb().run("UPDATE accounts SET plan = ? WHERE id = ?", [plan, id]);
}

export function retireAccount(id: string, reason: string, until: number | null): void {
  setAccountState(id, "retired", reason, until);
}

export function reviveAccount(id: string): void {
  setAccountState(id, "active", null, null);
}

export function excludeModel(id: string, model: string): void {
  const account = getAccount(id);
  if (!account || account.excludedModels.includes(model)) return;
  const next = JSON.stringify([...account.excludedModels, model]);
  getDb().run("UPDATE accounts SET excluded_models = ? WHERE id = ?", [next, id]);
}

/** Hard delete: the only operation that erases a credential. */
export function purgeAccount(id: string): boolean {
  const db = getDb();
  // Both deletes must land or neither: a crash midway otherwise leaves quota
  // rows for an account that no longer exists.
  const purge = db.transaction((accountId: string): boolean => {
    db.run("DELETE FROM usage_snapshots WHERE account_id = ?", [accountId]);
    return db.run("DELETE FROM accounts WHERE id = ?", [accountId]).changes > 0;
  });
  return purge(id);
}

/**
 * Replace the account's spend with the upstream's own figure. `recordUsage`
 * accumulates a local estimate; when a snapshot knows the real number, it wins,
 * because the local price table has no entry for most model ids.
 */
export function setCreditsSpent(id: string, micro: number | null): void {
  if (micro === null) return;
  getDb().run("UPDATE accounts SET credits_spent_micro = ? WHERE id = ?", [Math.max(0, Math.trunc(micro)), id]);
}

export function recordUsage(
  id: string,
  u: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    creditsSpentMicro: number;
  },
): void {
  getDb().run(
    `UPDATE accounts SET
       requests = requests + 1,
       input_tokens = input_tokens + ?,
       output_tokens = output_tokens + ?,
       cache_read_tokens = cache_read_tokens + ?,
       credits_spent_micro = credits_spent_micro + ?,
       last_used_at = ?
     WHERE id = ?`,
    [
      Math.max(0, Math.trunc(u.inputTokens)),
      Math.max(0, Math.trunc(u.outputTokens)),
      Math.max(0, Math.trunc(u.cacheReadTokens)),
      Math.max(0, Math.trunc(u.creditsSpentMicro)),
      Date.now(),
      id,
    ],
  );
}

/** Atomic increment-and-read of the attestation sequence counter. */
export function reserveAttestSeq(id: string): number {
  const row = getDb()
    .query<{ attest_seq: number }, [string]>(
      "UPDATE accounts SET attest_seq = attest_seq + 1 WHERE id = ? RETURNING attest_seq",
    )
    .get(id);
  // No row means the account vanished (purged mid-request). Returning 0 would
  // sign the request with an already-used sequence, so fail loudly instead.
  if (!row) throw new Error(`cannot reserve attestation sequence for unknown account ${id}`);
  return row.attest_seq;
}

export function saveAttestSession(
  id: string,
  session: { token: string; seed: string; expiresAt: number } | null,
): void {
  getDb().run(
    "UPDATE accounts SET attest_token = ?, attest_seed = ?, attest_expires_at = ? WHERE id = ?",
    [session?.token ?? null, session?.seed ?? null, session?.expiresAt ?? null, id],
  );
}

// ---------- quota view ----------

export interface QuotaView {
  /** Binding budget's remaining allowance, in micro-dollars. */
  remainingMicro: number;
  limitMicro: number;
  resetsAt: number | null;
  plan: string | null;
  /** The binding budget: a rolling window, or the account's one-time credits. */
  binding: "window" | "lifetime";
  /** Label of the binding window, e.g. "All models · 5-hour usage". */
  bindingLabel: string | null;
  /** The one-time credits pool, when the upstream reports it. */
  lifetime: { remainingMicro: number; limitMicro: number } | null;
  /**
   * Spent this cycle as the *upstream* reports it, in micro-dollars, or null
   * when the snapshot omits it. This is authoritative: a local price table
   * covers only the model families it knows, so it reads 0 for everything else.
   */
  spentMicro: number | null;
  /** Every rolling window, so the UI can show more than the tightest one. */
  windows: {
    id: string | null;
    label: string | null;
    remainingMicro: number;
    limitMicro: number;
    resetsAt: number | null;
  }[];
}

interface WindowLike {
  id?: unknown;
  label?: unknown;
  remaining_usd?: unknown;
  limit_usd?: unknown;
  restores_at?: unknown;
}

/** Sum `remaining_usd`/`limit_usd` over pools, else usage_windows. */
export function quotaFromSnapshot(raw: string): QuotaView | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const root = parsed as {
    plan?: unknown;
    pools?: WindowLike[];
    usage_windows?: WindowLike[];
    lifetime_allowance?: { remaining_usd?: unknown; limit_usd?: unknown };
    period?: { resets_at?: unknown };
  };
  const list =
    Array.isArray(root.pools) && root.pools.length > 0
      ? root.pools
      : Array.isArray(root.usage_windows)
        ? root.usage_windows
        : [];

  const windows = list.map((window) => {
    const restore = window.restores_at ?? root.period?.resets_at;
    const at = typeof restore === "string" ? Date.parse(restore) : Number.NaN;
    return {
      id: typeof window.id === "string" ? window.id : null,
      label: typeof window.label === "string" ? window.label : null,
      remainingMicro: parseMicro(window.remaining_usd),
      limitMicro: parseMicro(window.limit_usd),
      resetsAt: Number.isFinite(at) ? at : null,
    };
  });

  const lifetimeRaw = root.lifetime_allowance;
  const lifetime =
    lifetimeRaw && typeof lifetimeRaw === "object"
      ? {
          remainingMicro: parseMicro(lifetimeRaw.remaining_usd),
          limitMicro: parseMicro(lifetimeRaw.limit_usd),
        }
      : null;

  if (windows.length === 0 && !lifetime) return null;

  // Spent this cycle, in micro-dollars. The authoritative figure is the
  // lifetime pool's `used_usd`, a plain dollar string. `credits_spent` is only
  // a fallback, and its unit varies between deployments — the live gateway
  // reports micro-dollars as an integer ("213"), while older fixtures report
  // dollars with a decimal point — so an integer is read as micro and anything
  // with a point as dollars.
  const spentMicro = ((): number | null => {
    const used = lifetimeRaw && typeof lifetimeRaw === "object" ? (lifetimeRaw as { used_usd?: unknown }).used_usd : undefined;
    if (typeof used === "string" || typeof used === "number") return parseMicro(used);
    const raw = (root as { credits_spent?: unknown }).credits_spent;
    if (typeof raw === "number") return Number.isInteger(raw) ? Math.round(raw) : Math.round(raw * 1_000_000);
    if (typeof raw !== "string") return null;
    const text = raw.trim();
    if (text === "" || !Number.isFinite(Number(text))) return null;
    return text.includes(".") ? parseMicro(text) : Math.round(Number(text));
  })();

  // Three budgets can bind an account: each rolling window, and the one-time
  // credits. Report the tightest *fraction*, because a nearly-empty lifetime
  // pool matters even when the 5-hour window looks healthy.
  const fraction = (remaining: number, limit: number): number =>
    limit > 0 ? remaining / limit : remaining <= 0 ? 0 : 1;

  let binding: { remaining: number; limit: number; resetsAt: number | null; kind: "window" | "lifetime"; label: string | null } | null =
    null;
  const consider = (
    remaining: number,
    limit: number,
    resetsAt: number | null,
    kind: "window" | "lifetime",
    label: string | null,
  ): void => {
    if (limit <= 0) return;
    if (binding && fraction(remaining, limit) >= fraction(binding.remaining, binding.limit)) return;
    binding = { remaining, limit, resetsAt, kind, label };
  };

  for (const window of windows) {
    consider(window.remainingMicro, window.limitMicro, window.resetsAt, "window", window.label);
  }
  if (lifetime) consider(lifetime.remainingMicro, lifetime.limitMicro, null, "lifetime", "One-time credits");

  if (!binding) return null;
  const plan = typeof root.plan === "string" ? root.plan : null;
  return {
    remainingMicro: binding.remaining,
    limitMicro: binding.limit,
    resetsAt: binding.resetsAt,
    plan,
    binding: binding.kind,
    bindingLabel: binding.label,
    lifetime,
    spentMicro,
    windows,
  };
}

export function latestQuota(accountId: string): QuotaView | null {
  const row = getDb()
    .query<{ raw: string }, [string]>(
      "SELECT raw FROM usage_snapshots WHERE account_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1",
    )
    .get(accountId);
  return row ? quotaFromSnapshot(row.raw) : null;
}

/** Snapshots kept per account. The poller writes one a minute; the UI needs one. */
const SNAPSHOTS_PER_ACCOUNT = 120;

/**
 * Store a quota snapshot, then trim the account's history.
 *
 * `latestQuota` reads only the newest row, so an untrimmed table is pure growth:
 * a proxy left running wrote 504 rows in a day and would reach ~180k a year,
 * each holding the full usage JSON. Trimming by row count (not age) keeps a long
 * streak of failures — which record nothing new — from erasing the last good
 * reading.
 */
export function recordSnapshot(accountId: string, raw: string, capturedAt = Date.now()): void {
  const db = getDb();
  const insert = db.transaction((id: string, body: string, at: number): void => {
    db.run("INSERT INTO usage_snapshots (account_id, captured_at, raw) VALUES (?, ?, ?)", [id, at, body]);
    db.run(
      `DELETE FROM usage_snapshots
        WHERE account_id = ?
          AND id NOT IN (
            SELECT id FROM usage_snapshots WHERE account_id = ? ORDER BY captured_at DESC, id DESC LIMIT ?
          )`,
      [id, id, SNAPSHOTS_PER_ACCOUNT],
    );
  });
  insert(accountId, raw, capturedAt);
}

/**
 * Routing policy: active and unexpired, model not excluded, non-zero quota,
 * then least-recently-used first so a pool spreads load. Returns null when no
 * account can serve the model.
 */
export function selectAccount(
  model: string,
  now = Date.now(),
  exclude?: ReadonlySet<string>,
): Account | null {
  const db = getDb();
  const rows = db
    .query<{ id: string; last_used_at: number | null }, []>(
      `SELECT id, last_used_at FROM accounts
        WHERE state = 'active'
          AND expires_at > ?
          AND (state_until IS NULL OR state_until <= ?)`,
    )
    .all(now + 30_000, now);

  const usable: { account: Account; lastUsed: number }[] = [];
  for (const row of rows) {
    if (!row.id || exclude?.has(row.id)) continue;
    const account = getAccount(row.id);
    if (!account || account.excludedModels.includes(model)) continue;
    const quota = latestQuota(account.id);
    // No snapshot yet: treat as usable (remaining = 1); the poller corrects it.
    const remaining = quota ? quota.remainingMicro : 1;
    if (remaining <= 0) continue;
    usable.push({ account, lastUsed: row.last_used_at ?? 0 });
  }

  // Sticky: reuse the account that served the previous request instead of
  // round-robin. Prefix caches are per account, so alternating accounts throws
  // away every cached prefix; one account drains first, the next takes over.
  usable.sort((a, b) => b.lastUsed - a.lastUsed);
  if (usable.length === 0) return null;

  const chosen = usable[0].account;
  db.run("UPDATE accounts SET last_used_at = ? WHERE id = ?", [now, chosen.id]);
  return chosen;
}

export function lastUsedAt(id: string): number | null {
  const row = getDb()
    .query<{ last_used_at: number | null }, [string]>("SELECT last_used_at FROM accounts WHERE id = ?")
    .get(id);
  return row?.last_used_at ?? null;
}
