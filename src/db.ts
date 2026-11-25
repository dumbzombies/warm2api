// SQLite storage. One file under the data dir, WAL mode, all money as integer
// micro-dollars so no float ever touches a quota figure.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id                 TEXT PRIMARY KEY,
  label              TEXT NOT NULL,
  access_token       TEXT NOT NULL,
  expires_at         INTEGER NOT NULL,
  client_fingerprint TEXT,
  device_fingerprint TEXT NOT NULL,
  plan               TEXT NOT NULL DEFAULT 'unknown',
  state              TEXT NOT NULL DEFAULT 'active',
  state_reason       TEXT,
  state_until        INTEGER,
  attest_token       TEXT,
  attest_seed        TEXT,
  attest_expires_at  INTEGER,
  attest_seq         INTEGER NOT NULL DEFAULT 0,
  excluded_models    TEXT,
  created_at         INTEGER NOT NULL,
  last_used_at       INTEGER,
  requests           INTEGER NOT NULL DEFAULT 0,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  credits_spent_micro INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS usage_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    TEXT NOT NULL,
  captured_at   INTEGER NOT NULL,
  raw           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snap_acct ON usage_snapshots(account_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS request_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           INTEGER NOT NULL,
  account_id   TEXT,
  surface      TEXT NOT NULL,
  model        TEXT NOT NULL,
  status       INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micro   INTEGER NOT NULL DEFAULT 0,
  ms           INTEGER NOT NULL DEFAULT 0,
  error_code   TEXT
);
CREATE INDEX IF NOT EXISTS idx_log_at ON request_log(at DESC);
`;

/** `"1.000000"` → `1000000`. Never float math: split on the dot. */
export function parseMicro(value: unknown): number {
  if (typeof value === "number") return Math.round(value * 1_000_000);
  if (typeof value !== "string") return 0;
  const text = value.trim();
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(text);
  if (!match) {
    const asNumber = Number(text);
    return Number.isFinite(asNumber) ? Math.round(asNumber * 1_000_000) : 0;
  }
  const sign = match[1] === "-" ? -1 : 1;
  const whole = Number.parseInt(match[2], 10);
  const frac = (match[3] ?? "").padEnd(6, "0").slice(0, 6);
  return sign * (whole * 1_000_000 + (frac ? Number.parseInt(frac, 10) : 0));
}

/** `1000000` → `"1.000000"`. */
export function formatMicro(micro: number): string {
  const negative = micro < 0;
  const abs = Math.abs(Math.trunc(micro));
  const whole = Math.floor(abs / 1_000_000);
  const frac = String(abs % 1_000_000).padStart(6, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/**
 * Columns added after the first release. `CREATE TABLE IF NOT EXISTS` does
 * nothing to a table that already exists, so an upgraded install would keep the
 * old shape and every write naming a new column would fail — `recordUsage` and
 * `recordRequest` both do. Add them in place instead of demanding a reset, which
 * would throw away the stored tokens.
 */
const ADDED_COLUMNS: Array<{ table: string; column: string; definition: string }> = [
  { table: "accounts", column: "cache_read_tokens", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "accounts", column: "credits_spent_micro", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "request_log", column: "cache_read_tokens", definition: "INTEGER NOT NULL DEFAULT 0" },
];

function migrate(db: Database): void {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
    if (columns.some((existing) => existing.name === column)) continue;
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

let active: Database | null = null;

export function openDatabase(dataDir: string): Database {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new Database(join(dataDir, "state.db"), { create: true });
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA busy_timeout=5000;");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(SCHEMA);
  migrate(db);
  db.exec("PRAGMA user_version=1;");
  return db;
}

/** Open (once) and register the process-wide handle. */
export function initDb(dataDir: string): Database {
  if (active) return active;
  active = openDatabase(dataDir);
  return active;
}

export function getDb(): Database {
  if (!active) throw new Error("database not initialised: call initDb(dataDir) first");
  return active;
}

export function setDb(db: Database | null): void {
  active = db;
}

export function closeDb(): void {
  active?.close();
  active = null;
}
