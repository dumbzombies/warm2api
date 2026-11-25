# Warm plugin

Adds **Warm** as a provider in both agents and a quota command that reports the
pool's spend against the accounts' budgets. Both agents talk to the local
warm2api proxy on `127.0.0.1:41673`, which pools every Warm subscription behind
one OpenAI- and Anthropic-compatible surface.

```
plugins/
  shared/warm-quota.sh      quota script (proxy first, SQLite snapshot fallback)
  omp/                      provider + /login entry + /warm + /warm-quota
  opencode/                 provider config + /warm-quota command
  hermes/                   custom provider + usage hook
```

Each plugin ships `dist/warm2api.mjs` (the whole proxy, built by
`bun run build:plugins`) and starts it themselves when the agent loads — nothing
to launch by hand and no repo checkout needed at install time. The proxy's API
key is generated on first start into `~/.warm2api/api-key`; a loopback proxy runs
open by default, so the key is optional for local use.

## omp

```bash
./plugins/omp/install.sh        # copies the extension into $OMP_AGENT_DIR/extensions/warm2api
```

- Registers the `warm` provider (`http://127.0.0.1:41673/v1`) with the live
  catalog from `/admin/models`, plus `/warm-quota`.
- `/warm [status|accounts|add|purge <id>|revive <id|all>|refresh|usage [id]]`
  manages the pool; `add` walks the device approval and `/login` lists the
  provider.
- `/warm-quota` prints `% used`, dollars left, the reset date and the cache hit
  rate, read from `/api/state`.

## opencode

```bash
./plugins/opencode/install.sh   # plugin file + provider block + /warm-quota
```

- `~/.config/opencode/plugins/warm2api.ts` starts the bundled proxy at module
  load. This opencode build evaluates plugin modules but never calls their hooks,
  so `install.sh` writes the static `provider.warm` block into `opencode.jsonc`
  (backup `.bak-warm2api`); the plugin's only job is keeping the proxy up.
- `/warm-quota` shells out to `~/.local/bin/warm-quota`.

## hermes

```bash
./plugins/hermes/install.sh     # -> $HERMES_HOME/model-providers/warm2api
```

- Registers provider `warm2api` (base URL `http://127.0.0.1:41673/v1`) and
  implements `fetch_account_usage` from `/api/state`, so `hermes usage` shows the
  pool gauge.

## Notes

- `apiKey: local` is fine against the local proxy; `install.sh` substitutes the
  real key when one exists.
- `WARM2API_PORT`, `WARM2API_DATA` and `WARM2API_PROXY` are honoured everywhere.
- The fallback path in `warm-quota.sh` reads the last snapshot per account out of
  `~/.warm2api/state.db` and marks the output `[stale]`.
