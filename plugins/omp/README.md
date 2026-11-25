# warm2api plugin for pi / omp

Self-contained: `src/index.ts` plus `dist/warm2api.mjs` (the whole proxy).
There is nothing to start by hand and no dependency on this repo.

Install:

```sh
./install.sh    # omp: $OMP_AGENT_DIR/extensions/warm2api (default ~/.omp/agent)
```

For **pi-bolt** (and pi), the same directory shape works — Pi discovers
`<agent>/extensions/*/index.ts` or a directory with a `pi.extensions` manifest:

```sh
dest=~/.pi/agent/extensions/warm2api
mkdir -p "$dest"
cp src/index.ts "$dest/"
cp -R dist "$dest/"
printf '%s\n' '{"name":"warm2api","version":"0.7.0","type":"module","pi":{"extensions":["./index.ts"]}}' > "$dest/package.json"
```

**The provider needs a non-empty `apiKey`.** Pi treats a provider that declares
`oauth` but no `apiKey` as "not authenticated" and omits it from
`--list-models` and the model picker — silently, with no error. The extension
therefore sets a placeholder (`apiKey() || "local"`) and keeps the oauth flow
for `/login`. The local proxy is what authenticates upstream; the placeholder
only satisfies the host's readiness check.

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
