# warm2api plugin for pi / omp

Self-contained: `src/index.ts` plus `dist/warm2api.mjs` (the whole proxy).
There is nothing to start by hand and no dependency on this repo.

Install:

```sh
./install.sh    # -> $OMP_AGENT_DIR/extensions/warm2api (default ~/.omp/agent)
```

The extension registers an OpenAI-completions provider called `warm` (base URL
`http://127.0.0.1:41673/v1`) and two commands:

```
/warm [status|accounts|add|purge <id>|revive <id|all>|refresh|usage [id]]
/warm-quota        # pool % used, $ left, reset date, cache hit rate
```

`/warm refresh` re-polls the gateway (`POST /api/refresh`) and prints the quota.
`/warm add` walks the device-code approval through the local dashboard API, so
first use is `/warm add`; `login` in the provider's OAuth flow does the same.

Because the bundled proxy keeps polling after the agent exits, quota stays
fresh between sessions; `WARM2API_PORT` / `WARM2API_DATA` relocate it.
