# memory

## 2026-11-24 — Architecture and the single translation spine

Every request is normalized into an Anthropic-shaped request (`toAnthropicRequest`
for OpenAI callers; Anthropic callers pass through `prepareAnthropicRequest`),
sent to `/v1/messages` with `stream: true`, and re-encoded into either OpenAI
chat chunks (`openai-out.ts`) or Anthropic SSE frames (`anthropic.ts`). The
Anthropic surface is therefore the upstream protocol, and OpenAI is the
translation — not the reverse.

`openMessages` returns `Promise<AsyncGenerator>`, not `async function*`: the HTTP
status must be validated before any client byte is written so rotation stays
possible. The first event is prefetched and re-yielded by `prepend()`.

`eventStream()` in `server.ts` writes the `request_log` row **before** enqueuing
the error frame. That ordering is load-bearing: the Anthropic SDK throws as soon
as it sees the error event, and `test/anthropic-sdk.test.ts` asserts the audit
row exists right after that throw.

## 2026-11-24 — Config is lazy by necessity

`src/config.ts` resolves on first `getConfig()`; `setConfig`/`resetConfig` exist
for tests and plugins. A module-level `export const config` broke everything:
ESM imports hoist, so the test harness's `WARM2API_*` env vars (set after import)
were ignored and modules cached the real `api.keelcode.ai`. Never reintroduce an
import-time constant. `WARM2API_PORT=0` is accepted (ephemeral port) because
parallel test files must not collide; `portEnv` allows 0 while other numeric envs
require > 0.

## 2026-11-24 — SDK and Bun test gotchas

- `@anthropic-ai/sdk` 0.68: `messages.create({stream:true})` must be awaited
  before iterating; the un-awaited APIPromise is not async-iterable.
- Bun's `expect(...).rejects` does not work on the OpenAI SDK's `APIPromise`
  (it reports "promise that resolved"). Use a try/catch helper returning the
  thrown `status` instead.
- Stream fixtures are replayed by `test/fake-upstream.ts`; `behaviour.failures`
  is a per-request queue consumed by `/v1/messages`, `alwaysFail` after it.
- The fake handshake answers 404, so attestation self-disables and caches a 24 h
  back-off; the harness calls `resetAttestationState()` to keep tests isolated.

## 2026-11-24 — Contracts that must not drift

- Money is integer micro-dollars (`parseMicro`/`formatMicro`); `costMicro` is
  tokens × USD-per-1M = micro-USD, advisory only.
- Retirement: `usage_window_exceeded` → `retired` until `restores_at`; 429 →
  `cooling`; `account_disabled` → terminal `disabled`; a 400 is never rotated.
  Only `purge` deletes a credential; the poller revives anything with quota.
- Aliases apply only when the requested id is absent from a non-empty catalog,
  so a real staff-only model id is never redirected.
- `tool_choice` is emulated with a system-prompt nudge; `"none"` drops tools.
  `openai-out` tool-call indexes count tool calls only, skipping text blocks.
- `count_tokens` is a local estimate and never calls upstream.
- `Bun.serve({idleTimeout: 255})` — the max Bun accepts; long SSE turns rely on it.

## 2026-11-24 — Unverified against the real gateway

`mergeWindow` (`POST /api/v1/usage/windows/merge`) and `fetchRecent`
(`/api/v1/usage/recent`) were coded from the reverse-engineering notes and have
never been exercised by a live account. They are unused by tests and must be
confirmed before anyone relies on them.

## 2026-11-24 — Dashboard surface and the browser auth shortcut

`GET /` serves one self-contained HTML document from `src/dashboard.ts` (no
external assets, mobile-first, dark/light via `prefers-color-scheme`). It is
unauthenticated on purpose: it contains no data. Every data call needs the key,
accepted as `Authorization: Bearer`, `x-api-key`, or the `warm2api_key` HttpOnly
cookie. `GET /?key=<key>` verifies the key, sets that cookie (SameSite=Strict,
30 days) and redirects to `/`, so the key never stays in the URL bar. The page
attempts `load()` immediately even without a localStorage key — otherwise a
cookie-authenticated visit shows the unlock gate for a full polling cycle.

Device login is stateful in-process: `POST /admin/login` starts
`addViaDeviceFlow` and blocks until the device code arrives (or 10 s), then the
page polls `GET /admin/login/:id` until `pending` → `complete`/`error`.
`POST /admin/poll` runs the poller synchronously for the Refresh button.
Sessions live 15 min and die with the process — no schema change.

## 2026-11-24 — Bun escapes non-ASCII inside template literals

`DASHBOARD_HTML` must be a `String.raw` template (the inline JS contains regex
escapes), but Bun's transpiler rewrites non-ASCII source characters to `\uXXXX`
escapes *before* `String.raw` sees them, so a raw `—` in HTML text renders as the
literal text `\u2014`. Keep HTML text ASCII: use `&mdash;`/`...` entities.
Non-ASCII inside JS string literals is fine — the browser interprets the escape.

Also: `.sub` uses `white-space: nowrap` for card subtitles, so hint paragraphs
must use `.hint` (wrapping) or the long `?key=...` example overflows on a 390 px
viewport.

## 2026-11-24 — Catalog view reads the upstream fields, not guesses

`GET /admin/models` preferred the local `modelMeta` table, which only prices the
Claude family; everything else showed a dash. The live `/v1/models` payload
carries `context_window`, `max_output_tokens`, `thinking`/`reasoning` and
`capabilities.{tools,vision}` — the route now prefers those and falls back to
`modelMeta` only for prices. Cost of that call is a real gateway round trip
(~5 s cold), served behind the existing 60 s catalog cache; the dashboard shows
`Loading…` and fetches lazily on first visit to the Models tab.

Removal is no longer state-gated: the dashboard offers Remove on every card and
relies on `DELETE /admin/accounts/:id` plus a browser confirm. `purgeAccount`
deletes the row and credential; nothing revives it.

## 2026-11-24 — Upstream prefix cache: measured, and routing made sticky

The gateway caches prompt prefixes automatically; no `cache_control` needed.
`usage.prompt_tokens_details.cached_tokens` reports the matched span, aligned in
~3k chunks (a 3,293-token prompt hit 3,072). Billing deltas at 4k tokens: 34
credits cold vs 7 credits on a warm replay; wall time ~35 s cold vs ~27 s warm.

`selectAccount` sorted by `last_used_at` ascending — pure round-robin, which
guaranteed a different account (and therefore a cold cache pool) on every call.
It now sorts descending: one account drains until its shortest window reads
zero, then the next is used. Consequence: with several accounts the first one
carries most traffic; that is intended, quota is per account and the switch is
automatic.

Measurement gotcha: `credits_spent` updates lag one request, so a probe's
delta belongs to the previous call. `credits_spent` is an integer credit count
(1 credit = $0.000001); `parseMicro` on it is wrong by 1e6 — read
`limit_usd`/`used_usd` fields for USD.

## 2026-11-24 — Plugins ship the proxy instead of importing the repo

`plugin/{omp,opencode,hermes}` used to `import "../../../src/..."`, which tied
them to a checkout. They now bundle the CLI (`bun build src/main.ts
--target=bun --outfile=<plugin>/dist/warm2api.mjs`, 113 KB, `bun:sqlite` stays
external) and talk to it over HTTP only: probe `/healthz`, spawn
`<runtime> dist/warm2api.mjs serve` detached when nothing is up (log
`<data dir>/plugin.log`, mkdir first — a fresh WARM2API_DATA is the common
first-run failure), register `http://127.0.0.1:${WARM2API_PORT:-8787}/v1`.
`process.execPath` is the agent's own Bun, so no PATH dependency for omp and
opencode; Hermes uses `shutil.which("bun")`.

Hermes contract (from hermes-agent docs, not guesswork): a model-provider
plugin registers at import with
`ProviderProfile(name, display_name, base_url, env_vars, auth_type,
fallback_models)` then `register_provider(profile)`; the same code works as a
filesystem plugin under `$HERMES_HOME/plugins/model-providers/<name>/` or as a
`hermes_agent.plugins` entry point taking no arguments. Copy the key from
`~/.warm2api/api-key` into `WARM2API_API_KEY` at import, because the profile
only names env vars.

`test/plugins.test.ts` runs the plugins in a child process (env must be set
before import) against a booted harness server and asserts they reuse it and
register `gpt-5.6-luna`; the spawn path was verified by starting both plugins
on empty ports and reading `/healthz` and the registered catalog.

## 2026-11-24 — Bug hunt: four real defects found and fixed

1. **CRLF chunk splits merged SSE frames** (`src/upstream.ts` `parseSse`). The
   parser normalised `\r\n` per chunk, so a `\r` ending one read and the `\n`
   starting the next never paired; `\n\n` was not found and two frames were
   decoded as one, throwing `malformed_stream` and dropping every event. A fuzz
   over all 199 two-chunk splits of a 3-frame body failed at 2 points; the parser
   now scans for both separators on the accumulated buffer and strips CRLF per
   frame, leaving a lone trailing `\r` for the next read. Fuzz is clean.
   Regression: `test/sse.test.ts` (splits, byte-at-a-time, truncated tail must
   throw rather than silently drop).
2. **Quota pools were summed** (`src/accounts.ts` `quotaFromSnapshot`). Pools are
   alternative windows; summing let a drained 5-hour window read as 50 % left, so
   `selectAccount` routed to an account that could not serve. Now the binding
   window (lowest remaining fraction) is reported, including its reset time.
   Regression: `test/quota.test.ts`.
3. **Malformed percent-escapes produced 500s** (`src/server.ts`). A bad cookie
   killed the request before auth ran; bad ids in `DELETE /admin/accounts/:id`
   and `GET /admin/login/:id` threw `URIError` out of the router. `safeDecode`
   now tolerates garbage, so these degrade to 401/404. Regression in
   `test/dashboard.test.ts`.
4. **Cost is always 0 for gateway models** (`src/translate/models.ts`
   `costMicro`): `modelMeta` only prices the Claude family, so luna/deepseek/glm
   rows record `cost_micro = 0` and `credits_spent_usd` stays 0 even with real
   token usage. Not fixed — a truthful number would need per-model prices the
   gateway does not publish. Reported, not guessed.

Earlier suspicion of a double `recordRequest` in `eventStream` was **rejected**:
`let logged` makes `finish()` idempotent. Lesson recorded: an isolated repro that
bypasses the wrapper proves nothing about the wrapper.

## 2026-11-24 — Second hunt: duplicates, purge atomicity, attestation blast radius

1. **Duplicate accounts were structural, not a fluke** (`src/accounts.ts`
   `addAccount`). Nothing deduped on token: `POST /admin/accounts` twice with the
   same token produced two ids and split quota. This is how the earlier
   `<account>` pair appeared. `addAccount` now looks up
   `access_token` first and updates that row (max expiry, refreshed label), so
   dashboard retries and plugin `/warm add` are idempotent. No schema change was
   needed; an existing DB with duplicates keeps them until purged by hand.
2. **`purgeAccount` was two statements with no transaction** and
   `usage_snapshots` has no FK, so a crash between them orphaned quota rows that
   `latestQuota()` still served for a deleted account. Now one transaction.
3. **One transient handshake error disabled attestation for 24 h pool-wide.**
   `ensureAttestation` treated every throw as "upstream does not support
   attestation". An `ECONNREFUSED` on one account made `attestationEnabled()`
   false for all accounts, silently downgrading every request to unsigned. Only a
   real "unsupported" reply sets the global flag now; errors keep support
   `unknown` and back off 60 s.
4. **`reserveAttestSeq` returned 0 for an unknown account**, which would sign with
   an already-used sequence (replay). It throws now.

Test-first lesson re-confirmed: my first idempotency patch used
`MAX(expires_at, ?)` in SQL and returned `toAccount(getAccount(id)!)`; the test
caught `expiresAt === NaN`. Replaced with explicit `Math.max` plus a null check.

## 2026-11-24 — Production hardening: measured, not asserted

User asked whether the proxy is "110% production ready and ready for hammering".
Answer was **no**, for four concrete reasons, all now fixed and measured.

1. **No upstream timeout.** `openMessages` passed only `req.signal`, so a gateway
   that accepts the TCP connection and never answers pinned the request, the
   socket and the selected account forever (proved: only a client-side 10 s abort
   ended it). Now `AbortSignal.any([client, timeout])` with
   `WARM2API_UPSTREAM_TIMEOUT_MS` (default 120 s) → `upstream_timeout` → rotation.
   Stalled gateway now returns 502 in 1.9 s with a 120 ms test budget.
2. **Unbounded `request_log`.** Append-only, queried by time window, never pruned:
   a hammered proxy fills the phone's storage. Trims to 50 000 rows every 256
   writes. Cost 0.10 ms `COUNT(*)` per 256 writes — noise next to a 0.24 ms insert.
3. **Unbounded memory under concurrency.** 32 MiB body cap with no admission
   control: 64 concurrent max-size prompts ≈ 2 GB on a 1.7 GB-free device.
   A request *count* cap was wrong (a stream holds its slot ~27 s → 32 slots ≈ 1.2
   req/s); the invariant is **bytes in flight**. Budget 256 MiB, unknown-length
   (chunked) bodies reserve a 1 MiB floor, rejections send `connection: close` so
   a refused upload cannot keep streaming.
4. **Verified non-issues** (checked, so they don't get "fixed" later): fds rise to
   143 and stay flat across five 256-request rounds — bounded Keep-Alive pool, not
   a leak; RSS plateaus at ~68-77 MB; `parseMicro`, quota binding-window and the
   SSE splitter all held under fuzz and load.

Effective throughput: 575 req/s at concurrency 64 on the fake upstream, buffered
and streamed, no unintended 503s. Real gateway latency (~24 s per call) is
upstream-side and unchanged by the proxy.

**Gotcha, twice:** a module-level `Number(process.env.X ?? default)` is frozen at
import, so a test fixture that sets env *before* importing the module still saw
the old value — the timeout and the byte budget both silently ignored the env var
until converted to functions read per call. `test/hardening.test.ts` spawns
`test/fixtures/{stall,shed}-probe.ts` as child processes for exactly this reason.

**Termux measurement trap:** a load probe that launches N concurrent max-size
bodies (60 × 8 MB) starves the phone — the shell call timed out at 300 s and
left RAM near the limit. Measure one property per probe, keep totals under the
configured budget, and prefer `test/fixtures/*-probe.ts` child processes over
ad-hoc scratch scripts in `$HOME/tmp`; the fixtures are committed, repeatable and
self-cleaning.

## 2026-11-24 — Dashboard rebuilt to the freepi-proxy standard

User: make the dashboard "actually proper, and fancy just like
~/projects/freepi-proxy". Read that `src/ui.html` (1368 lines) and matched its
design language: dark-only palette (`#0a0a0b` bg, `#2dd4bf` accent,
`--surface`/`--border` ramp), 236 px sidebar with a mark tile, pill tabs with an
accent rail on the active one, hero metric using `clamp()` plus a transitioning
track bar, a `statrow` of uppercase micro-labels, hand-drawn SVG bars, and three
breakpoints (980 / 640 / reduced-motion). Still one self-contained document: no
fonts, no CDN, no images.

Backend gap: the fancy layout needs data the proxy did not expose. Added
`GET /admin/stats` and `series(hours, buckets)`, `byModel(hours, limit)`,
`recent(limit)` in `src/track.ts`. `series` gap-fills every bucket so a quiet
hour draws a zero bar instead of leaving a hole in the chart.

**Bug I introduced, caught by an existing test:** I rewrote `startLogin` from
memory so it awaited the whole device flow before returning, making
`POST /admin/login` answer `complete` instead of `pending` and breaking the
dashboard's polling contract. `test/dashboard.test.ts` failed on
`expect(session.status).toBe("pending")`. Restored the original head verbatim
from a saved copy. Lesson: when replacing a large template literal, split the
file at the export boundary and keep the non-template code byte-identical.

**Rendering bugs only the browser showed** (tests were green throughout): the
add panel was visible on load because `setUnlocked(true)` unhid it, and the hero
rendered a row of em-dashes for accounts with no quota snapshot yet. Fixed: the
add panel is opt-in, the hero falls back to 24 h spend with its own label and
unit. Also deduplicated model rows where the gateway returns the id as the
display name, and made `#statModels` populate on first paint rather than on
first visit to the Models tab.

**Termux note:** headless Chromium will not stay up here (zygote dies), so
visual checks ran through Lightpanda (`goto` → `markdown` → `evaluate`), whose
`evaluate` wants `{script: "..."}`. Use Lightpanda first next time — see the
machine-wide note in `~/.agents/memory.md`. Verified at 390 px: zero horizontal
overflow, 48 + 72 chart rects drawn, all three tabs populated, live service
showing `$0.9995 USD left` against the real gateway with 8 models.

## 2026-11-24 — The dashboard hid most of the balance: lifetime credits

User spotted it: the proxy said every account had $1, the Warm website said
<account> had $4 in one-time credits. Both were right about
different budgets, and the proxy only knew about one.

`/api/v1/usage` returns **three** budgets:

- `pools` — usually empty
- `usage_windows` — rolling rate limits: `short` (5-hour, $1) and `long`
  (weekly, $1)
- `lifetime_allowance` — the one-time credit pool: `{limit_usd: 4.000000,
  used_usd: 0.000840, remaining_usd: 3.999160}`

`quotaFromSnapshot` read only the first two, so every view showed `$1.0000`
while `$4.00` of real balance sat unused. Two consequences: the dashboard
under-reported the balance by 75%, and — worse — a drained lifetime pool would
never have retired the account, so routing would keep selecting an account the
upstream rejects.

Fix: `QuotaView` now models all three (`binding: "window" | "lifetime"`,
`bindingLabel`, `lifetime`, `windows[]`) and picks the tightest **fraction**
across every budget. `/admin/accounts` exposes the lifetime pool and the window
list; cards render `one-time credits $3.9992 of $4.0000` with a
`binding` / `not binding` note.

Lesson: when a number disagrees with the vendor's own UI, dump the raw payload
before theorising. The data was in `usage_snapshots.raw` the whole time — one
sqlite query and a JSON dump settled it in a minute. Also note the existing
quota test used `toEqual` on the whole object, so it broke on the new fields;
rewritten to assert the fields that matter plus a drained-lifetime case.

## 2026-11-24 — Port moved off 8787 to 41673

8787 sits inside the range plenty of dev servers pick, so the proxy was
colliding with whatever else ran. Default is now **41673** in one place —
`portEnv("WARM2API_PORT", 41673)` in `src/config.ts` — with `WARM2API_PORT`
still overriding it. The three plugins had the port hard-coded as a fallback
(`plugin/omp/src/index.ts`, `plugin/opencode/src/index.ts`,
`plugin/hermes/__init__.py`) and the READMEs quoted the URL, so all five were
updated and the bundles rebuilt (`bun run build:plugins`); the dist still
carries the old baked-in value otherwise.

There is no config file for the port — `~/.warm2api/` holds only `api-key`,
`device.json` and `state.db`, so nothing persisted needs migrating. Verified:
old port refuses connections, new port serves `/`, `/healthz`, `/admin/*`, and
one real inference call returned 200 in 23 s.

## 2026-11-24 — Auth policy follows the bind address

User asked for optional dashboard user/password (default off on localhost),
no API auth on localhost, but auth mandatory when public. Implemented as
`resolveAuthPolicy(host, user, pass, apiAuth)` in `src/config.ts` — a pure
function, so the matrix is unit-testable without binding a real interface — and
enforced in `src/server.ts`.

Matrix actually shipped and measured:

| bind | creds | anon `/` | anon `/admin` | anon `/v1/models` |
|---|---|---|---|---|
| 127.0.0.1 | none | 200 | 200 | 200 |
| 127.0.0.1 | set | 401 | 401 | 401 |
| 127.0.0.1 | set + key | — | 200 | 200 |
| 0.0.0.0 | none | **refuses to start** | — | — |
| 0.0.0.0 | creds, `API_AUTH=off` | **refuses to start** | — | — |

Decisions worth keeping:
- **Loopback + password closes the API too**, on purpose. A half-guarded local
  proxy (password on the dashboard, open inference) is a state nobody asks for
  and easy to leave behind; `WARM2API_API_AUTH=on` exists for anyone who really
  wants exactly that.
- **Refusal happens at startup**, in `loadConfig`, so a misconfigured public
  bind never opens a socket. The error names the env vars to set.
- The `?key=` unlock link and the `set-cookie` hop sit behind Basic too,
  otherwise the link would leak the API key to an unauthenticated caller.
- `safeEqual` compares both halves of the credentials and still performs the
  comparison work on a length mismatch, so a wrong length is not observably
  faster. `sameKey`/`authorised` reuse it.

Test fallout: three existing tests asserted 401 for unauthenticated calls and
started failing because the harness inherited the new loopback-open default.
Fixed by having `test/harness.ts` set `WARM2API_API_AUTH=on` (it models a
guarded proxy) rather than weakening the assertions, and adding
`test/auth-policy.test.ts` (pure matrix) plus `test/auth-http.test.ts`
(end-to-end 401/200 over real HTTP). Suite 70 -> 79.

## 2026-11-24 — Browser verification on this device: Lightpanda, not Chromium

Headless Chromium does not survive here. `chromium-browser --headless=new
--remote-debugging-port=…` starts, prints DBus/UPower noise, then dies with
`Failed to send GetTerminationStatus message to zygote`; the DevTools endpoint
never answers, so the attempt costs a minute before falling through anyway.

Use Lightpanda for any visual or DOM check: `goto` → `markdown` / `tree` /
`evaluate`. Notes that cost time to learn:
- `evaluate` takes `{script: "..."}`, **not** `expression`. A bare trailing
  expression returns its value; `await`/`return` work at top level; objects come
  back as JSON, so no `JSON.stringify` wrapper.
- `screenshot` accepts only a **relative** path and writes against the session
  cwd — it once dropped `dash.png` into an unrelated project directory. Check
  where it landed.
- It renders computed text layout, not pixels: right for "did the DOM populate",
  "is anything overflowing" (`scrollWidth - clientWidth` inside `evaluate`),
  wrong for colour or font fidelity.
- Images are not viewable in this session at all, so a screenshot is evidence
  for the user, never for me — assert through `evaluate` instead.

## 2026-11-24 — Conventions this repo keeps tripping over

Collected so the next session does not rediscover them:

- **`String.raw` + non-ASCII.** `DASHBOARD_HTML` is a `String.raw` template, and
  Bun escapes non-ASCII in template literals *before* `String.raw` sees it, so
  HTML text must use entities (`&mdash;`, `&hellip;`). Inline JS strings use
  `\u2013`-style escapes.
- **Splitting a big template file.** Replace `DASHBOARD_HTML` by locating
  `s.index("export const DASHBOARD_HTML")` and keeping everything before it
  byte-identical. Rewriting the head from memory silently changed `startLogin`
  from "returns pending immediately" to "returns complete", and only the
  existing test caught it.
- **Module-level env reads freeze at import.** `const X = Number(process.env
  .FOO ?? default)` is evaluated when the module loads, so a test fixture that
  sets the variable *before importing* still sees the old value. Both the
  upstream timeout and the in-flight byte budget were silently ignoring their
  env vars for this reason; make such settings functions read per call.
- **Child-process fixtures.** For anything that needs a different
  `WARM2API_*` environment or its own database, spawn
  `test/fixtures/*-probe.ts` via `Bun.spawn` and print one JSON line. Sharing a
  process across `setConfig`/`closeDb` corrupts later tests ("database not
  initialised").
- **Test assertions on whole objects break on new fields.** The quota test used
  `toEqual` on the entire `QuotaView`; adding `binding`/`lifetime`/`windows`
  failed it. Assert the fields that carry meaning instead.
- **Do not weaken a failing assertion to match new behavior.** Three tests
  failed because the harness inherited the loopback-open default; the fix was
  to make the harness declare `WARM2API_API_AUTH=on` (it models a guarded
  proxy), not to relax the 401 expectations.
- **`/tmp` is not writable on this device.** Scratch lives in `$HOME/tmp`;
  `mkdtempSync(tmpdir())` works because Node resolves to the Termux tmp.
- **Big probes starve the phone.** 60 concurrent 8 MB bodies hit swap and
  timed out a 300 s call. One property per probe, totals under the configured
  budget.

## 2026-11-24 — Aligned with the mistral-vibe template

Read `~/projects/mistral-vibe` (core.js 1123 lines + server.js 78 + ui.html 619)
and adopted its **structure**, not just its looks.

Adopted:
1. **UI as an asset file, not a template literal.** `src/ui.html` now holds the
   dashboard; `src/dashboard.ts` keeps only the login-session logic. This kills
   the old `String.raw` + non-ASCII-entity constraint entirely (the HTML is no
   longer inside a TS template), and editing the UI needs only a restart.
2. **CORS.** We had none, so no browser-page SDK could call the proxy.
   `OPTIONS` now answers `204` *before* auth (a browser never sends credentials
   on a preflight), and `json()` / the SSE response carry
   `access-control-allow-origin: *`. Wildcard is safe here because the key rides
   in a header, not a cookie.
3. **Richer `/healthz` plus a `/health` alias**: `version`, `mode`
   (`open`/`guarded`), `dashboard` (`open`/`basic`), per-state account counts.
4. **`?dash=0` / `?dash=1` escape hatch**, mirroring the template's
   `?dash` handling, plus `WARM2API_DASHBOARD=0` to disable the UI globally.
5. **Plugin installers** (`plugin/{omp,opencode,hermes}/install.sh`) with
   `OMP_AGENT_DIR` / `OPENCODE_PLUGIN_DIR` / `HERMES_HOME` overrides — the
   template ships these and we had none, so a bundle-only plugin had no install
   path. Verified each into a temp dir: correct file lands, bundle included.
6. Unified the two duplicate timing-safe comparators (`sameKey` was redundant
   once `safeEqual` existed).

**The bug this surfaced, and the fix.** Replacing `readFileSync(new URL(...))`
with a plain read made the *source* path work while the *bundle* served the
284-byte fallback: `bun build` does not inline a runtime `readFileSync`, so
`dist/warm2api.mjs` had no `ui.html` beside it. Worse, my first verification
passed because the stale bundle still contained the HTML from the old template
literal — the bundle size (149 323 → 105 513 B) was the tell.

Working fix: `import UI_HTML from "./ui.html" with { type: "text" }` — a static
text import, the same shape `cfwork/worker.js` uses (`import ui from
"../src/ui.html"`). Bun resolves it at load for `bun run src/main.ts` and inlines
it at build time for the plugins, so one source serves both. Bundle is now
154 133 B and the bundled proxy serves all 49 087 bytes.

`test/bundle.test.ts` now builds a bundle into a temp dir, spawns it, and asserts
the served HTML exceeds 30 KB — proven by reverting to `readFileSync` and
watching it fail with 23 bytes. It waits on the child's own `listening` banner
rather than sleeping.

Also fixed twice-over while aligning: `corsHeaders()` was referenced by `json()`
before its declaration (TDZ, 30 tests failed) and a `.toContain(x).toBe(false)`
assertion compared the assertion object instead of the HTML.

## 2026-11-24 — Aligned as a sibling of mistral-vibe: control plane + plugins/

The user asked for warm2api to read like part of the same toolkit as
`~/projects/mistral-vibe`. That means an API surface the shared quota script can
read, and a plugin layout with the same names and the same self-contained rule.

**Control plane (`src/control.ts`, `/api/state`, `/api/refresh`, one-api
billing).** The vibe proxy exposes `/api/state` and the one-api billing pair;
every plugin and script it ships reads those. warm2api now serves the same
shapes, driven by the pool rather than by one account:

- `poolSummary()` sums each *serving* account's **binding** budget (rolling
  window or one-time credits). Retired accounts count (they revive); disabled
  and logged-out accounts and rows without a snapshot do not — capacity must not
  grow from an unmeasured account.
- `used_percent: null` when nothing is measured. Reporting `0` would tell every
  consumer the whole budget is unspent; the script prints
  `budget unknown — no quota snapshot yet` for it.
- `billing.usage.total_usage` is **cents** (one-api readers divide by 100);
  `daily_costs: []` because the upstream reports a cycle total, not a daily
  breakdown. Inventing a series would be worse than an empty array.
- Both bare and `/v1`-prefixed billing paths exist: consumers disagree about
  which is real, and one-api registers both.

**Two defects the live smoke found, both invisible to the old tests.**

1. `/api/state` called `liveCatalog()` inline, so a cold model catalog made the
   quota script hang until its own 4 s timeout printed `[stale — proxy down]`
   against a healthy proxy. Fix: `catalogIds()` answers from cache/seed and
   refreshes in the background with no request signal and no log line. 81 ms
   cold, 76 ms warm. *Rule: `/api/state` is polled by dashboards and shells — it
   must never wait on the network.*
2. `summary()` never selected `cache_read_tokens`, so `/admin/stats` handed the
   dashboard `undefined` (cache chart silently 0) and `/api/state` reported
   `cache_hit_pct: null`. Adding the column fixed both; live reads 37.3%.

**Surface agreement.** The dashboard hero used the tightest single account
(`$3.9992 of $4`) while the script reported the pool (`$4.9991 of $5`). Two
correct-but-different numbers is the failure mode, so the dashboard now loads
`/api/state` (one document: cards + pool) and prints the pool; the tightest
account survives only as the fallback when no pool exists. Verified in
Lightpanda: both surfaces read `$4.9991 of $5`.

**`plugins/` instead of `plugin/`,** with `plugins/shared/warm-quota.sh` and a
`plugins/README.md`, mirroring the template. Installers copy the bundle, so
`bun run build:plugins` + re-run is the upgrade path.

**The opencode constraint, measured three ways.** This opencode build (2.3.2)
*evaluates* plugin modules but never calls their hooks:

- `export default async (input) => ({config})` — module loads, hook never runs,
  provider never appears (`opencode models | grep '^warm/'` = 0).
- `export default {id, server: async () => ({config})}` — same, and the log says
  `PluginModule.LoadError ... Expected object at ["default"]`.
- `export default {id, async setup()}` — setup *is* called (probe wrote its log),
  but `config` still never reaches the model list.
- A static `provider.warm` block in `opencode.jsonc` *does* surface models.

So the installer writes the block itself (as the vibe installer does) and the
plugin's only job is keeping the proxy up. Plugin directories (`plugins/x/`) are
**not** scanned on this build; flat files in `~/.config/opencode/plugins/` are.

**Test-harness gotcha:** the harness serves in-process, so `Bun.spawnSync` in a
test deadlocks — the child's request can never be answered by the frozen event
loop, and curl reports `000`/timeout. `test/quota-script.test.ts` uses async
`Bun.spawn` for that reason.

**Naming:** the shared script is `warm-quota` (not `vibe-quota`), the omp command
is `/warm-quota`, and `WARM2API_PROXY` mirrors `VIBE_PROXY` — same shape, warm
prefix, so a reader of either repo recognizes both.

## 2026-11-24 — Published, with a 9router-shaped service command

Public repo: `github.com/dumbzombies/warm2api` (MIT, `main`). The user asked for
one-shot installers on Linux/Termux/Windows that register a `warm2api` command
with `start`/`stop`/`status` subcommands, like `9router`.

**The lifecycle is TypeScript, not shell.** 9router's launcher is a 633-line
bash script because its app is a Next build driven by a `node` CLI. Here the
proxy is already Bun, and Bun's process API is identical on Termux, Linux, macOS
and Windows, so `src/service.ts` owns supervision once and the installers stay
thin. Three platform scripts would have meant three places to fix a pidfile bug.

**Two argv traps, both found by running it.**

1. `Bun.argv[0]` is the *runtime* (`…/bin/bun`), not the script; the script is
   `Bun.argv[1]`. Spawning `[execPath, "serve"]` makes Bun treat `serve` as a
   script path → `error: Script not found "serve"`.
2. `import.meta.path` inside `service.ts` is *service.ts*, not the entry point.
   The entry has to be threaded in from the CLI (`Bun.argv[1]`).
3. A `bun build --compile` binary reports `Bun.argv = ["bun", "/$bunfs/root/warm2api", …]`
   and `process.execPath` *is* the program, so its child is `[execPath, "serve"]`
   with no script. `serveArgv()` detects the embedded path (`/$bunfs`, `~BUN`).

**`Bun.serve` throws synchronously on a busy port** — a probe must `try { … }
finally { server.stop(true) }`, not await a rejection.

**Start must be a supervisor, not a spawn.** The child is detached, but its pid
is recorded only after `/healthz` answers; a failed start removes nothing so the
log survives, and a `kill -9`'d child reads back as `stale` (pid gone) instead of
`running`, which also stops a stale record from blocking the next start. Port
fallback (`41673 busy; using 41674`) is recorded in the state file so `status`
and `env` stay truthful.

**Version split.** `CLIENT_VERSION` is the version we *impersonate* on the wire
(`x-warm-client: keelcode-cli/0.6.0`) and must not follow the package version;
`APP_VERSION` (0.7.0) is what `/healthz`, `/api/state` and `warm2api version`
report. Conflating them would have silently changed how the gateway treats
requests.

**Installers** fetch the repo (git, else the codeload tarball), run
`bun build --compile`, and place one ~90 MB binary on PATH — no registry, no
runtime deps, no root. Re-running is the upgrade path. Termux uses `pkg install
bun`; others use bun.sh's installer. Windows registers `%USERPROFILE%\.local\bin`
in the *User* PATH (no admin).

**Publishing hygiene:** `node_modules/`, `plugins/*/dist/` (installers compile
their own), and any real account identifiers are excluded/scrubbed; `bundle.test.ts`
builds its own bundle so ignoring `dist/` is safe. `git ls-files` total 648 K.

## 2026-11-25 — Adversarial pass: 15 defects, and what they have in common

Method: every finding was reproduced against a running process or a synthetic
database before it was believed, then fixed, then pinned by a test in
`test/regressions.test.ts` / `test/cli-regressions.test.ts` (`bun test` →
118 pass, 1 skip, 0 fail).

**The four that would have bitten a real user first**

1. *No migration path.* `CREATE TABLE IF NOT EXISTS` is a no-op on an existing
   table, so `cache_read_tokens` was absent on any upgraded install and **every
   request write threw**. The proxy would serve and then fail to record, and the
   error surfaced as a generic 500. Fix: additive `ALTER TABLE` driven by
   `ADDED_COLUMNS` + `PRAGMA user_version`. Any future column must be added there
   too; `SCHEMA` alone only helps fresh installs.
2. *`start --host` was a security hole.* The supervisor spawned the child with
   the parent's environment, which `--host` never touched — so the child bound
   loopback while `status` advertised the flag, **and the public-bind guard never
   saw the address in use**. `start --host 0.0.0.0` produced an unauthenticated
   proxy. The host is now forwarded explicitly and `assertBindable()` runs before
   the fork, in the process that has the flag.
3. *`stop` could kill an unrelated process.* Pids get recycled; a day-old record
   pointed at whatever took that pid and `stop` sent SIGTERM then SIGKILL. Now
   `/proc/<pid>/cmdline` must look like warm2api, otherwise the record is
   cleared and the command exits 1. **Termux reports `process.platform ===
   "android"`**, so the first version of this guard silently disabled itself —
   gate on whether `/proc` is readable, never on a platform name.
4. *Attestation could take the whole pool down.* A transient handshake failure
   was rethrown while `attestationEnabled()` stayed true, so three client calls
   became nine handshakes and zero completions. It now degrades to unsigned (what
   the real client does) and the 60 s backoff is actually consulted.

**Latency, measured not assumed.** A 1-token completion took 26 s. Direct to
`api.keelcode.ai` it was also 26 s (16.8 s TTFB), so this is the gateway, not the
proxy; `/v1/models` answers in 0.13 s. Don't "optimize" the proxy for this.

**Smaller but real:** unbounded control fetches (a wedged gateway pinned
`/api/refresh` forever), catalog fan-out (six cold `/api/state` calls → six
sockets), `cache_hit_pct: 0` for no data, `readJson` buffering before rejecting
and measuring UTF-16 units, `messages:[null]` → 500 on all three POST routes,
buffered failures missing from the request log while streamed ones were logged,
snapshots never trimmed (504/day), spend always 0 because the local price table
covers only Claude ids, `alreadyServing` trusting any `{ok:true}`, `env`
exporting an empty key when `WARM2API_KEY` supplied it, `start --port 0` leaving
an orphan child, and `--help` creating a data dir.

**Unit trap worth remembering.** The upstream's `credits_spent` is a
**micro-dollar integer** ("213" next to `used_usd: "0.000213"`), but the test
fixtures write dollars ("0.120000"). `parseMicro` scales by 1e6 and must not be
applied to the integer form. `used_usd` is preferred because it is unambiguous;
the fallback is integers-as-micro, dotted strings-as-dollars.
