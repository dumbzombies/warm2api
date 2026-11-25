# AGENTS.md — warm2api

Local Bun proxy that exposes Warm subscriptions as OpenAI- and
Anthropic-compatible HTTP endpoints. Read `.agents/state.md` then
`.agents/memory.md` before working.

## Stack

Bun ≥ 1.1 on Termux/aarch64. No runtime dependencies: `Bun.serve`, `bun:sqlite`,
`node:http` for the fake upstream. Dev deps: `openai@^6`,
`@anthropic-ai/sdk@^0.68`, `@types/bun`.

## Layout

- `src/config.ts` — lazy config (`getConfig`/`setConfig`), env contract, API key.
- `src/db.ts` — schema, micro-dollar helpers, connection.
- `src/accounts.ts` — account rows, quota snapshots, routing (`selectAccount`).
- `src/upstream.ts` — gateway calls, SSE decode, error mapping.
- `src/dispatch.ts` — failure→action table, rotation.
- `src/server.ts` — HTTP routes, auth, stream recording.
- `src/control.ts` — `/api/state`, `/api/refresh`, one-api billing views.
- `src/service.ts` — `start`/`stop`/`status` supervision, pidfile, log tail.
- `src/translate/*` — OpenAI ↔ Anthropic translation, effort, model table.
- `src/poller.ts` — quota polling + revival.
- `src/login.ts`, `src/main.ts` — device flow and CLI.
- `test/fake-upstream.ts` + `test/fixtures/*.sse` — deterministic upstream.
- `plugins/omp`, `plugins/opencode`, `plugins/hermes` — host integrations;
  `plugins/shared/warm-quota.sh` is the shared quota script.

## Commands

```sh
bun test                       # fake upstream + real OpenAI/Anthropic SDKs
bun run src/main.ts start|stop|restart|status|logs|env   # service lifecycle
bun run src/main.ts serve                                # foreground
bun run src/main.ts add|list|revive <id|all>|purge <id|all-retired>|poll|doctor|usage [id]
```

`start` spawns `serve` detached and waits for `/healthz`; the supervisor lives in
`src/service.ts` and is host-agnostic (Termux, Linux, macOS, Windows). Installers
(`install.sh`, `install.ps1`) compile `src/main.ts` with `bun build --compile`.

## Conventions

- Money is integer micro-dollars; never float arithmetic.
- `bun test` must stay green; new behaviour needs a deterministic test.
- Never let tests reach the real gateway; `test/live.test.ts` is gated on
  `WARM2API_LIVE=1`.
- No recursive `grep` via bash on this machine (use ripgrep).
