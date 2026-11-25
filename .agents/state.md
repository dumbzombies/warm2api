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
- Optional: install the plugins into `~/.omp`, `~/.config/opencode`,
  `~/.hermes` permanently (opencode is installed and verified; omp and hermes are
  not).
