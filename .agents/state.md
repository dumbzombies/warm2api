# state

## Goal

`warm2api`: a local Bun proxy that pools Warm subscriptions behind
OpenAI-compatible (`/v1/chat/completions`, `/v1/models`) and Anthropic-compatible
(`/v1/messages`, `/v1/messages/count_tokens`) endpoints, tracks usage per
account, retires exhausted accounts and revives them when quota refills.

## Progress

Complete and verified. Live service on **http://127.0.0.1:41673**
(dashboard: `http://127.0.0.1:41673/?key=<api key>`).

- `src/` implements config (lazy), SQLite store, accounts/routing, gateway client
  with SSE decoding and error mapping, failure→action table with rotation,
  OpenAI ↔ Anthropic translation (text, tools, parallel tools, thinking,
  prompt caching, JSON schema), poller with revival, device login, CLI.
- Routing is sticky (MRU) rather than LRU, so upstream prefix caches keep
  hitting; account cards show cached tokens when present.
- Percent-decoding is defensive (`safeDecode`): malformed cookies/ids yield 401 or
  404, never a 500 with a stack trace.
- The SSE parser splits frames on `\n\n` **and** `\r\n\r\n`, so a CRLF pair
  straddling a TCP chunk boundary no longer merges frames.
- Quota views report the **binding budget** across all three upstream budgets:
  the rolling `usage_windows` (5-hour + weekly) **and** `lifetime_allowance`
  (one-time credits). A drained lifetime pool retires the account even when the
  rolling windows are healthy. Live accounts read `lifetime $3.999 of $4.0000`.
- **`src/control.ts` is the control plane**: `poolSummary()`, `accountCounts()`,
  `apiState(models)`, `billingSubscription()`, `billingUsage()`, `uptimeSeconds()`.
  Money crosses the wire in dollars divided from integer micro-dollars.
- **`GET /api/state`** (auth as the API) returns `ok`, `version`, `mode`,
  `dashboard`, `uptime_s`, `accounts` (per-state counts + `list` + `total`),
  `pool` (`accounts`, `limit_usd`, `remaining_usd`, `used_usd`, `used_percent`,
  `binding`, `binding_label`, `resets_at`), `requests` (lifetime totals, cache
  hit %, 24 hourly `buckets`), `models` (ids), `log` (20 rows).
  **`POST /api/refresh`** re-polls the gateway and returns the same document plus
  `polled`. Billing: `GET /dashboard/billing/{subscription,usage}` and the
  `/v1/...` twins, one-api shapes, `total_usage` in **cents**.
- The pool counts accounts that can still serve (active/cooling/retired) with a
  snapshot; unpolled rows and disabled/logged-out ones are excluded, so capacity
  only grows once a budget was actually measured. No snapshot at all ⇒ `null`,
  never `0%`.
- `catalogIds()` keeps `/api/state` non-blocking: a cold catalog answers from
  `seedModels()` and refreshes in the background (no request signal, no log).
  Measured 81 ms cold, 76 ms warm; before the fix the script timed out at 4 s.
- `summary()`/`lifetime()` now select `cache_read_tokens` — the omission fed
  `/admin/stats` `undefined` (cache chart always 0) and `/api/state`
  `cache_hit_pct: null`. Live reads 37.3%.
- `addAccount` is idempotent on `access_token`; `purgeAccount` is one
  transaction; attestation failures are classified (only an explicit
  "unsupported" disables it pool-wide).
- Dashboard is `src/ui.html` (49 087 B asset, dark, mobile-first, no external
  assets), imported with `with { type: "text" }` so plugins inline it. Tabs
  **Overview / Activity / Models**; cookie unlock via `/?key=`; add through
  `POST /admin/login` + `GET /admin/login/:id`; polls `/api/state` every 5 s
  (one document, so cards and hero cannot disagree) and `/admin/poll` on Refresh.
  **Hero reports the pool** — live reads `$4.9991 of $5.0000 across 2 accounts`,
  `Pool remaining · One-time credits`, 7d reset — matching `warm-quota` exactly.
  Falls back to the tightest single account, then to 24 h spend.
- CORS: `OPTIONS` → 204 before auth; `json()`/SSE carry
  `access-control-allow-origin: *`; `/healthz` and `/health` return `version`,
  `mode`, `dashboard`, per-state counts; `?dash=0` hides the UI.
- **Auth follows the bind address** — `resolveAuthPolicy(host, user, pass,
  apiAuth)`; loopback open by default, non-loopback refuses to start without
  credentials + API auth.
- Admission control is byte-based (`WARM2API_MAX_IN_FLIGHT_BYTES`, 256 MiB);
  billing paths are exempt from shedding so a quota readout survives load.
  Upstream stalls are bounded by `WARM2API_UPSTREAM_TIMEOUT_MS` (120 s) →
  `upstream_timeout` → rotate.
- **Plugins live in `plugins/`** (renamed from `plugin/`), matching the
  mistral-vibe template's shape:
  - `plugins/README.md` — the toolkit overview (shared script + three hosts).
  - `plugins/shared/warm-quota.sh` — quota script, proxy-first via `/api/state`,
    `--json` for the raw document, SQLite last-snapshot fallback labelled
    `[stale]`, exit 1 when neither exists. `$WARM2API_PROXY` overrides the URL.
  - `plugins/omp` — extension; `warm` provider, `/warm [accounts|add|purge|
    revive|refresh|usage]`, `/warm-quota`. Installer -> `$OMP_AGENT_DIR/extensions/warm2api`.
  - `plugins/opencode` — `plugins/warm2api.ts` (starts the proxy at module load),
    `commands/warm-quota.md`, `opencode.jsonc.example`. Installer merges the
    static `provider.warm` block (backup `.bak-warm2api`), copies the command and
    `~/.local/bin/warm-quota`.
  - `plugins/hermes` — model provider with `fetch_account_usage` reading
    `/api/state` (returns `None`, not 0%, before the first snapshot).
  - Each ships `dist/warm2api.mjs` (162 589 B from `bun run build:plugins`).
- Tests: `bun test` → **96 pass, 1 skipped (live), 0 fail across 22 files**
  (~46 s). New files: `test/control.test.ts` (state/billing shapes, null pool,
  refresh, 405s, preflight), `test/quota-script.test.ts` (runs the real script:
  human + `--json`, unknown-budget wording, dead-proxy fallback + exit code).
  `test/plugins.test.ts` asserts both commands and the opencode example block.
  Official `openai@6` and `@anthropic-ai/sdk@0.68` clients drive both surfaces.
- Dashboard verified in Lightpanda at default width: hero `$4.9991 of $5.0000`,
  0 horizontal overflow, 2 account cards, 160 chart rects, 8 model rows,
  12 activity rows, all three tabs switch panels.

- **Published**: https://github.com/dumbzombies/warm2api (public, `main`, MIT).
  One-shot installers at the repo root compile a single self-contained binary:
  `install.sh` (Termux + Linux) and `install.ps1` (Windows). Both put `warm2api`
  on PATH and re-run as the upgrade path.
- **CLI (9router-shaped)**: `start [--port N] [--host H] [--open]`, `stop`,
  `restart`, `status [--json]`, `logs [--lines N]`, `env [--json]`, `serve`,
  `version`, `help`, plus the account commands. Bare `warm2api` prints help.
  `src/service.ts` owns supervision: detached spawn, `/healthz` gate (30 s),
  port fallback, pidfile + `<data>/run/warm2api.json`, SIGTERM then SIGKILL
  after 5 s, stale-pid detection, bounded log tail. Verified for a source
  checkout *and* a `bun build --compile` binary.
- `APP_VERSION` (0.7.0, ours) is split from `CLIENT_VERSION` (0.6.0, the value
  impersonated in `x-warm-client` and sent upstream); `/healthz`, `/api/state`
  and `warm2api version` report the former.
- Tests: `bun test` → **100 pass, 1 skipped, 0 fail across 23 files** (~20 s),
  including `test/service.test.ts` (real child processes: start/status/env/stop,
  idempotent start, kill -9 → stale → restart, busy-port fallback).
- Installer verified from the published URL on this device: clone → compile →
  `warm2api start` → `status` → `stop`.

- **Adversarial pass (2026-11-25) fixed 15 defects**, each with a regression
  test in `test/regressions.test.ts` or `test/cli-regressions.test.ts`:
  - **No schema migration**: an upgraded database kept the pre-`cache_read_tokens`
    shape, so every `recordUsage`/`recordRequest` threw. `db.ts` now adds missing
    columns (`ADDED_COLUMNS`) and sets `user_version=1`.
  - **`start --host` was dropped**: the child inherited the parent's loopback
    `WARM2API_HOST` while the record claimed the public URL, and the public-bind
    auth guard never ran for the address actually used (`0.0.0.0` served open).
    The host is now forwarded and `assertBindable()` runs before the fork.
  - **`stop` could kill an unrelated process**: a recycled pid got SIGTERM/SIGKILL.
    `looksLikeOurs()` checks `/proc/<pid>/cmdline` first. Note `process.platform`
    is **"android"** under Termux, not "linux" — gate on `/proc`, not the name.
  - **`stop(true)` truncated in-flight responses** on a normal `warm2api stop`;
    now graceful (`server.stop()`), with SIGKILL as the supervisor's fallback.
  - **Attestation failed the request**: a transient handshake error was rethrown,
    burning every rotation (3 calls → 9 handshakes, 0 completions). It now
    returns unsigned and a 60 s backoff actually applies.
  - **Unbounded control-plane fetches**: `/v1/models`, `/api/v1/usage`,
    `/api/v1/me` had no deadline, so `/api/refresh` never returned and the poll
    chain stalled. `WARM2API_CONTROL_TIMEOUT_MS` (15 s default).
  - **Catalog fan-out leak**: a cold cache made every `/api/state` caller start
    its own fetch (6 polls → 6 permanent sockets). One in-flight promise per
    base URL.
  - **`cache_hit_pct: 0`** on an unmeasured proxy → `null`, and both consumers
    (quota script, omp plugin) handle null.
  - **`readJson` buffered before rejecting** and counted UTF-16 units; it now
    streams with a byte cap, and admission reserves the real worst case.
  - **500s on malformed messages**: `messages: [null]` reached `msg.role` on all
    three POST routes; now validated as 400 `invalid_messages`.
  - **Buffered failures were never logged** (the streaming path was); both
    surfaces now record them, so `/admin/stats` error counts are honest.
  - **Snapshots grew without bound** (504 rows/day, ~180k/year): newest 120 per
    account are kept.
  - **Spend read 0 for every model** outside the local price table. The snapshot's
    own figure is authoritative: `used_usd` from `lifetime_allowance`, falling
    back to `credits_spent` (micro-integer live, dollar string in fixtures).
    **`credits_spent` is micro-dollars, not dollars** — `parseMicro` would
    double-scale it.
  - **`alreadyServing` accepted any `{ok:true}`** server, so a foreign process on
    the port made `serve` exit having served nothing; it now matches
    `APP_VERSION`.
  - **`env` exported an empty key** when `WARM2API_KEY` supplied it; it now reads
    env first and reports `api_key_source`.
  - **`start --port 0`** spawned a child on an ephemeral port, probed port 0 for
    30 s, failed, and left the child running unrecorded. Refused up front.
  - **`--help`/`version` created the data dir and an API key** (ENOENT on a
    read-only path); both are now side-effect free.

## Blockers

None.

## Next actions

- Derive spend from the upstream `used_usd` / `credits_spent` so `cost_micro`
  stops being `0` for every non-Claude model (the dashboard's cost figures and
  `billing.used_usd` currently come from quota deltas, not per-request prices).
- Durability under `kill -9` is untested: the harness serves in-process, so WAL
  survival needs a separately spawned server.
- Re-check `WARM2API_UPSTREAM_TIMEOUT_MS` (120 s) against a legitimately slow
  200 k-token prompt.
- If attestation is ever enabled upstream, re-check `handshake()` (currently 404).
- Optional: install the plugins into `~/.omp` and `~/.hermes` permanently
  (opencode is installed and verified; the other two are not).
- The Windows installer is written but untested (no Windows host here); its
  Bun install path and PATH registration follow Bun's own docs.
