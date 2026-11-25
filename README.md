# warm2api

One local proxy that turns any number of Warm (`@warm-ai/warm` / keelcode)
subscriptions into OpenAI- and Anthropic-compatible endpoints. Accounts are
pooled, usage is tracked per account, and an exhausted account steps aside until
its free window refills.

Runtime: Bun ≥ 1.1 (uses `Bun.serve`, `bun:sqlite`). No other dependencies.

## Install

```sh
cd ~/projects/warm2api
bun install                     # dev deps only (SDK clients for the tests)
```

## Add an account

```sh
bun run src/main.ts add         # device flow: prints a URL and a code
bun run src/main.ts token <bearer> --label work    # paste an existing token
```

`add` performs the RFC 8628 device approval, looks up the account identity and
stores the first quota snapshot. Tokens live in `~/.warm2api/state.db`; the
proxy's own API key is generated on first start into `~/.warm2api/api-key`
(mode 0600).

## Serve

```sh
bun run src/main.ts serve       # or: bun run start
```

```
OpenAI     http://127.0.0.1:41673/v1      (Bearer <api key>)
Anthropic  http://127.0.0.1:41673         (x-api-key: <api key>)
```

Endpoints:

| Path | Surface |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI, streaming and non-streaming |
| `GET /v1/models` | catalog (OpenAI shape, or Anthropic shape with `anthropic-version`) |
| `POST /v1/messages` | Anthropic, streaming and non-streaming |
| `POST /v1/messages/count_tokens` | local token estimate |
| `GET /healthz` | liveness + account-state counts, no auth |
| `GET /api/state` | pool budget, per-account state, request counters, model ids |
| `POST /api/refresh` | re-poll the gateway, then return the same state |
| `GET /dashboard/billing/subscription`, `GET /dashboard/billing/usage` | one-api quota shapes (also at `/v1/...`) |
| `GET /admin/accounts`, `DELETE /admin/accounts/:id`, `POST /admin/accounts/:id/revive` | account upkeep |
| `GET /admin/usage?hours=24` | request log summary |

Point any OpenAI SDK at `http://127.0.0.1:41673/v1`, or the Anthropic SDK at
`http://127.0.0.1:41673`.

`/api/state` is the control plane every other surface reads: the dashboard's
pool view, `plugins/shared/warm-quota.sh`, the omp `/warm-quota` command and
Hermes's `fetch_account_usage`. It sums each serving account's *binding* budget
(a rolling window or one-time credits), reports money in dollars derived from
integer micro-dollars, and says `null` — never `0%` — when nobody has measured a
pool yet. It answers from cache, so a cold model catalog never turns a quota
readout into a multi-second hang. `total_usage` in the billing-usage reply is
**cents**, as one-api's readers expect.

## Dashboard

Open `http://127.0.0.1:41673/?key=<contents of ~/.warm2api/api-key>` once: the
proxy sets an HttpOnly cookie and redirects to the clean URL. Afterwards
`http://127.0.0.1:41673/` just works, including pasting the key into the unlock
card. The page is a single self-contained document (no external assets), built
mobile-first: account cards with a remaining-quota bar, reset countdown, status
pills, one-tap **Add** (device code shown large with a copy button), Revive,
Remove, and **Refresh quotas** which runs the poller immediately. It polls the
account list every 5 s while visible.

| Path | Purpose |
| --- | --- |
| `GET /` | dashboard (unauthenticated shell; data calls need the key) |
| `GET /?key=<key>` | store the key in a cookie and redirect to `/` |
| `POST /admin/login` | start a device approval; returns the code and a session id |
| `GET /admin/login/:id` | poll that approval (`pending` / `complete` / `error`) |
| `POST /admin/poll` | run one quota poll now and return per-account results |
| `GET /admin/models` | catalog with context, output cap, capabilities and price |

## Agent plugins

Three plugins ship the proxy as a single 160 KB bundle (`bun run build:plugins`
writes `dist/warm2api.mjs` into each) and start it themselves when the agent
loads — nothing to launch by hand, no repo checkout required at install time.
See `plugins/README.md` for the full story.

| Agent | Install | What it gives you |
| --- | --- | --- |
| pi / omp | `./plugins/omp/install.sh` → `$OMP_AGENT_DIR/extensions/warm2api` | `warm` provider plus `/warm [accounts\|add\|purge\|revive\|refresh\|usage]` and `/warm-quota` |
| opencode | `./plugins/opencode/install.sh` | `warm` provider block in `opencode.jsonc`, `/warm-quota` command, shared quota script |
| Hermes | `./plugins/hermes/install.sh` → `$HERMES_HOME/model-providers/warm2api` | `warm2api` model provider and a `fetch_account_usage` hook |

Each plugin probes `127.0.0.1:${WARM2API_PORT:-41673}/healthz`, reuses a proxy
that is already up, otherwise spawns the bundled `serve` detached (log in
`~/.warm2api/plugin.log`), and registers the provider at the live URL with the
key from `~/.warm2api/api-key`. Model lists come from `/admin/models`, with a
small offline fallback so the provider exists before the first account is added.
`WARM2API_DATA` and `WARM2API_PORT` are honoured everywhere.

One host-specific constraint is worth stating plainly: this opencode build
evaluates plugin modules but never calls their `config`/`server` hooks, so the
opencode installer writes the provider block into `opencode.jsonc` itself and the
plugin only keeps the proxy running. Same for the omp extension, which registers
commands through pi's API and therefore works as-is.

### Quota, one source of truth

`plugins/shared/warm-quota.sh` is the shell surface (`warm-quota`, `--json`).
It asks `/api/state` first and prints `% used`, dollars left, the reset date, the
binding budget, per-state account counts and the prefix-cache hit rate. With the
proxy down it falls back to the last snapshot per account in
`~/.warm2api/state.db` and labels the output `[stale]`; with neither, it exits 1
rather than inventing figures. `$WARM2API_PROXY` overrides the URL.

## Routing and prompt cache

Account selection is sticky: the account that served the last request keeps
serving until its shortest quota window is spent, then the next takes over.
Alternating accounts would be round-robin (what the LRU sort did) and every
prefix cache would be cold on arrival. Warm's upstream caches prompt prefixes
per account; replaying a 4k-token prefix billed 34 credits cold and 7 credits
warm, and answered in ~27 s instead of ~35 s. Keep system prompts and tool
definitions stable across turns and the static prefix keeps hitting.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `WARM2API_PORT` | `41673` | listen port (`0` = ephemeral) |
| `WARM2API_HOST` | `127.0.0.1` | listen host |
| `WARM2API_DATA` | `~/.warm2api` | database, API key, device id |
| `WARM2API_API_BASE` | `https://api.keelcode.ai` | upstream gateway |
| `WARM2API_POLL_MS` | `60000` | quota poll interval |
| `WARM2API_ATTEST` | `auto` | client attestation: `auto`, `on`, `off` |
| `WARM2API_KEY` | generated | override the local API key |
| `WARM2API_DASHBOARD_USER` | unset | dashboard basic-auth user (set with the password) |
| `WARM2API_DASHBOARD_PASS` | unset | dashboard basic-auth password (set with the user) |
| `WARM2API_API_AUTH` | policy | `on`/`off`; local default is `off`, public forces `on` |
| `WARM2API_DASHBOARD` | on | set `0` to hide the UI (`?dash=1` still shows it once) |

### Dashboard and plugin install

The UI lives in `src/ui.html` and is read once at startup — edit it and restart,
no rebuild. `WARM2API_DASHBOARD=0` hides it for everyone (`?dash=0` does the same
per request, `?dash=1` overrides either).

`/healthz` and `/health` return the same unauthenticated probe payload:
`ok`, `version`, `mode` (`open`/`guarded`), `dashboard` (`open`/`basic`) and the
per-state account counts, so a monitor can tell a healthy proxy from a
misconfigured one.

Browser clients work: `OPTIONS` preflights answer `204` without credentials and
every JSON/SSE inference response carries `access-control-allow-origin: *`
(the API key travels in a header, not a cookie, so a wildcard is safe).

Install the agent plugins — each ships the proxy itself, so no repo checkout or
manually started server is needed:

```sh
./plugins/omp/install.sh        # -> $OMP_AGENT_DIR/extensions/warm2api
./plugins/opencode/install.sh   # -> plugin + provider block + /warm-quota
./plugins/hermes/install.sh     # -> $HERMES_HOME/model-providers/warm2api
```

Each installer honours a directory override (`OMP_AGENT_DIR`,
`OPENCODE_PLUGIN_DIR`, `HERMES_HOME`) and re-copies the bundle, so re-running it
after `bun run build:plugins` is the upgrade path.

### Who can reach it

The policy follows the bind address, because that is the actual security
boundary. Nothing is guessed at request time.

**Loopback (`127.0.0.1`, `::1`, `localhost`) — the default.** A personal tool:
the dashboard and the API are both open, so `curl` and SDKs work with no key.
Set `WARM2API_DASHBOARD_USER`/`WARM2API_DASHBOARD_PASS` to close both — a local
proxy is either open or wholly guarded, never half. `WARM2API_API_AUTH=on`
requires the key on the API while leaving the dashboard open.

**Any other bind (`0.0.0.0`, a LAN address, a hostname).** The process refuses
to start unless both are true:

1. `WARM2API_DASHBOARD_USER` and `WARM2API_DASHBOARD_PASS` are set (HTTP Basic
   on the dashboard, its `?key=` unlock link, and every `/admin/*` route).
2. `WARM2API_API_AUTH` is not `off` (the API key stays required).

```sh
# refused: no dashboard credentials
WARM2API_HOST=0.0.0.0 bun run src/main.ts serve
# refusing to bind 0.0.0.0: set WARM2API_DASHBOARD_USER and WARM2API_DASHBOARD_PASS...

# refused: API would be an open relay
WARM2API_HOST=0.0.0.0 WARM2API_DASHBOARD_USER=ada WARM2API_DASHBOARD_PASS=secret \
  WARM2API_API_AUTH=off bun run src/main.ts serve
# refusing to bind 0.0.0.0 with API auth disabled: a public proxy without the
# API key is an open relay.

# correct: both guards on
WARM2API_HOST=0.0.0.0 WARM2API_DASHBOARD_USER=ada WARM2API_DASHBOARD_PASS=secret \
  bun run src/main.ts serve
```

Basic auth only protects the dashboard; inference still needs the API key.
Serving a public proxy over plain HTTP exposes both the password and the key to
anyone on the path — put it behind TLS (a reverse proxy or a tunnel) first.

## Accounts and retirement

Routing prefers the least recently used account whose quota window still has
room. A failing account is handled by the failure, not by the request:

- `usage_window_exceeded` → **retired** until `restores_at`
- `rate_limit` and other 429s → **cooling** for the advertised delay
- `account_disabled` → **disabled** (never auto-revived)
- `model_not_on_plan` → account keeps serving other models; the model is excluded
- `overloaded` / network → retried twice on the same account, then rotated
- caller errors (400 from a bad request) → never rotated

The poller re-checks every retired or cooling account and **revives** it as soon
as its snapshot shows remaining quota again. Only `purge` deletes a credential:

```sh
bun run src/main.ts list
bun run src/main.ts revive <id|all>
bun run src/main.ts purge <id|all-retired>
bun run src/main.ts usage [id]      # live quota from upstream
bun run src/main.ts poll            # one polling pass, prints a table
bun run src/main.ts doctor          # config, DB, upstream reachability
```

## Compatibility notes

- `tool_choice: "required"` and a named function are emulated with a system
  prompt nudge (the gateway has no `tool_choice`). `"none"` drops the tools.
- Thinking levels: `reasoning_effort` of `low|medium|high|xhigh|max` maps to a
  `budget_tokens` on most models and `output_config.effort` on the Claude 5 /
  Opus 4.7+ families; `minimal`/`none` disable thinking. Streaming exposes the
  reasoning as `delta.reasoning_content`.
- `response_format: {type: "json_schema"}` becomes a system instruction plus a
  structural validation with one retry.
- `n`, `logprobs`, `top_logprobs`, `seed`, `audio`, `modalities`, `strict` and
  `response_format: {type: "json_object"}` are rejected with
  `unsupported_parameter` instead of being silently ignored.
- `count_tokens` is a local estimate (ASCII/4, non-ASCII/2 plus per-message and
  tool overhead); it never calls upstream.
- Money is stored as integer micro-dollars; the receipt in `/admin/usage` is
  advisory only.
- Attestation ships complete but self-disabling: the upstream handshake answers
  404 before authentication, so the first attempt backs off for 24 hours.

## Plugins

- `plugins/omp` — pi/omp extension: starts or reuses the proxy, registers the
  `warm` provider, adds `/warm [...]` and `/warm-quota`.
- `plugins/opencode` — opencode plugin that keeps the proxy up; the provider
  block ships as config (see `plugins/opencode/README.md`).
- `plugins/hermes` — Hermes model provider with a `fetch_account_usage` hook.
- `plugins/shared/warm-quota.sh` — quota script for agents and humans.

## Tests

```sh
bun test                       # fake upstream + real OpenAI/Anthropic SDKs
WARM2API_LIVE=1 bun test       # additionally exercises one real completion
```
