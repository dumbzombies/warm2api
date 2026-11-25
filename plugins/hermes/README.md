# warm2api plugin for Hermes

Registers the local warm2api proxy as a Hermes model provider and reports pool
usage through `fetch_account_usage`, so `hermes usage` and `/usage` show it.

Install:

```sh
./install.sh    # -> $HERMES_HOME/model-providers/warm2api (default ~/.hermes)
```

`dist/warm2api.mjs` is the whole proxy; on import the plugin reuses one that is
already listening, or starts the bundle detached (logging to
`<data dir>/plugin.log`) and then registers provider `warm2api` at
`http://127.0.0.1:41673/v1`.

`fetch_account_usage` reads `GET /api/state` and reports the pool's `% used`, the
dollar limit and the reset date. No snapshot yet ⇒ it returns `None` rather than
claiming 0% spent. The `agent.account_usage` import stays inside that method: a
module-level import makes provider discovery hit a circular import and silently
drop the plugin.
