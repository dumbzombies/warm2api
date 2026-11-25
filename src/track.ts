// Per-request accounting. One row per completed request, plus the account
// counters. Cost here is advisory: routing reads the upstream usage snapshot.

import { getDb } from "./db.ts";
import { recordUsage } from "./accounts.ts";
import { costMicro } from "./translate/models.ts";

export interface RequestRecord {
  accountId: string | null;
  surface: "openai" | "anthropic";
  model: string;
  status: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  ms: number;
  errorCode?: string | null;
}

/** Rows kept in `request_log`. Long enough for the dashboard's 7-day view. */
const REQUEST_LOG_LIMIT = 50_000;
/** Cheap enough to run inline, rare enough not to matter: every 256 writes. */
const PRUNE_EVERY = 256;

let writesSincePrune = 0;

/**
 * `request_log` is append-only and queried by time window, so without a cap it
 * grows until the phone runs out of storage. Trim by row count — not by age — so
 * an idle proxy keeps its history while a hammered one stays bounded.
 */
function pruneRequestLog(): void {
  writesSincePrune += 1;
  if (writesSincePrune < PRUNE_EVERY) return;
  writesSincePrune = 0;
  const db = getDb();
  const { n } = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM request_log").get() ?? { n: 0 };
  if (n <= REQUEST_LOG_LIMIT) return;
  db.run(
    `DELETE FROM request_log WHERE id IN (
       SELECT id FROM request_log ORDER BY at ASC LIMIT ?
     )`,
    [n - REQUEST_LOG_LIMIT],
  );
}

export function recordRequest(entry: RequestRecord): void {
  const input = Math.max(0, Math.trunc(entry.inputTokens ?? 0));
  const output = Math.max(0, Math.trunc(entry.outputTokens ?? 0));
  const cacheRead = Math.max(0, Math.trunc(entry.cacheReadTokens ?? 0));
  const cost = costMicro(entry.model, input, output);

  getDb().run(
    `INSERT INTO request_log
       (at, account_id, surface, model, status, input_tokens, output_tokens, cache_read_tokens, cost_micro, ms, error_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Date.now(),
      entry.accountId,
      entry.surface,
      entry.model,
      entry.status,
      input,
      output,
      cacheRead,
      cost,
      Math.max(0, Math.trunc(entry.ms)),
      entry.errorCode ?? null,
    ],
  );

  pruneRequestLog();

  if (entry.accountId) {
    recordUsage(entry.accountId, {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      creditsSpentMicro: cost,
    });
  }
}

export interface LogSummary {
  requests: number;
  failures: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_micro: number;
}

export function summary(hours = 24): LogSummary {
  const since = Date.now() - hours * 3_600_000;
  const row = getDb()
    .query<
      {
        requests: number | null;
        failures: number | null;
        input_tokens: number | null;
        output_tokens: number | null;
        cache_read_tokens: number | null;
        cost_micro: number | null;
      },
      [number]
    >(
      `SELECT COUNT(*) AS requests,
              SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS failures,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cache_read_tokens) AS cache_read_tokens,
              SUM(cost_micro) AS cost_micro
         FROM request_log WHERE at >= ?`,
    )
    .get(since);

  return {
    requests: row?.requests ?? 0,
    failures: row?.failures ?? 0,
    input_tokens: row?.input_tokens ?? 0,
    output_tokens: row?.output_tokens ?? 0,
    cache_read_tokens: row?.cache_read_tokens ?? 0,
    cost_micro: row?.cost_micro ?? 0,
  };
}

/**
 * Counters over the whole retained log (capped at REQUEST_LOG_LIMIT rows), not a
 * rolling window: `/api/state` reports since-start totals the way the vibe proxy
 * does, and the 24 h view stays in `summary()`.
 */
export function lifetime(): LogSummary {
  const row = getDb()
    .query<
      {
        requests: number | null;
        failures: number | null;
        input_tokens: number | null;
        output_tokens: number | null;
        cache_read_tokens: number | null;
        cost_micro: number | null;
      },
      []
    >(
      `SELECT COUNT(*) AS requests,
              SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS failures,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cache_read_tokens) AS cache_read_tokens,
              SUM(cost_micro) AS cost_micro
         FROM request_log`,
    )
    .get();

  return {
    requests: row?.requests ?? 0,
    failures: row?.failures ?? 0,
    input_tokens: row?.input_tokens ?? 0,
    output_tokens: row?.output_tokens ?? 0,
    cache_read_tokens: row?.cache_read_tokens ?? 0,
    cost_micro: row?.cost_micro ?? 0,
  };
}

export interface Bucket {
  /** Bucket start, epoch ms. */
  at: number;
  requests: number;
  failures: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_micro: number;
}

export interface ModelSpend {
  model: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_micro: number;
}

export interface RecentRequest {
  at: number;
  model: string;
  surface: string;
  status: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_micro: number;
  ms: number;
  error_code: string | null;
}

/**
 * Fixed-width time buckets, oldest first, including empty ones. The dashboard
 * draws these as a chart, so a gap must be a zero bar rather than a missing one.
 */
export function series(hours: number, buckets: number): Bucket[] {
  const width = Math.max(1, Math.floor((hours * 3_600_000) / buckets));
  const since = Date.now() - width * buckets;
  const rows = getDb()
    .query<
      {
        bucket: number;
        requests: number;
        failures: number | null;
        input_tokens: number | null;
        output_tokens: number | null;
        cache_read_tokens: number | null;
        cost_micro: number | null;
      },
      [number, number, number]
    >(
      `SELECT (at - ?) / ? AS bucket,
              COUNT(*) AS requests,
              SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS failures,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cache_read_tokens) AS cache_read_tokens,
              SUM(cost_micro) AS cost_micro
         FROM request_log WHERE at >= ?
        GROUP BY bucket ORDER BY bucket`,
    )
    .all(since, width, since);

  const byBucket = new Map(rows.map((row) => [row.bucket, row]));
  return Array.from({ length: buckets }, (_, index) => {
    const row = byBucket.get(index);
    return {
      at: since + index * width,
      requests: row?.requests ?? 0,
      failures: row?.failures ?? 0,
      input_tokens: row?.input_tokens ?? 0,
      output_tokens: row?.output_tokens ?? 0,
      cache_read_tokens: row?.cache_read_tokens ?? 0,
      cost_micro: row?.cost_micro ?? 0,
    };
  });
}

export function byModel(hours = 24, limit = 6): ModelSpend[] {
  const since = Date.now() - hours * 3_600_000;
  return getDb()
    .query<ModelSpend, [number, number]>(
      `SELECT model,
              COUNT(*) AS requests,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cache_read_tokens) AS cache_read_tokens,
              SUM(cost_micro) AS cost_micro
         FROM request_log WHERE at >= ?
        GROUP BY model ORDER BY requests DESC LIMIT ?`,
    )
    .all(since, limit);
}

export function recent(limit = 12): RecentRequest[] {
  return getDb()
    .query<RecentRequest, [number]>(
      `SELECT at, model, surface, status, input_tokens, output_tokens,
              cache_read_tokens, cost_micro, ms, error_code
         FROM request_log ORDER BY at DESC LIMIT ?`,
    )
    .all(limit);
}
