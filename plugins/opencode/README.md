# warm2api plugin for opencode

Self-contained: `plugins/warm2api.ts` (starts the proxy) plus `dist/warm2api.mjs`
(the whole proxy), a provider block, and a quota command.

Install:

```sh
./install.sh
```

It copies three things (honouring `OPENCODE_CONFIG_DIR`, `WARM_QUOTA_BIN`,
`WARM2API_PORT`):

| Path | Purpose |
| --- | --- |
| `~/.config/opencode/plugins/warm2api.ts` | starts the bundled proxy at module load |
| `~/.config/opencode/command/warm-quota.md` | `/warm-quota` TUI command |
| `~/.local/bin/warm-quota` | the shared quota script |

and merges this block into `opencode.jsonc` (backup `.bak-warm2api`):

```json
"warm": {
  "npm": "@ai-sdk/openai-compatible",
  "name": "Warm",
  "options": { "baseURL": "http://127.0.0.1:41673/v1", "apiKey": "local" },
  "models": { "gpt-5.6-luna": { "...": "..." } }
}
```

**Why a static block:** this opencode build loads plugin modules (the proxy
starts, matching `mistral-vibe.ts`) but never calls their `config`/`server`
hooks — a plugin-injected provider never reaches the model list. The installer
writes the config itself, exactly as `plugins/opencode/install.sh` does for
Mistral Vibe. Re-run it after a catalog change; `opencode.jsonc.example` is the
block it merges.
