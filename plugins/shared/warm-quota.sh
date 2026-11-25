#!/data/data/com.termux/files/usr/bin/bash
# Warm quota, proxy-first. Used by both agent plugins and by hand.
#   warm-quota          human-readable
#   warm-quota --json   raw /api/state (proxy) or the local snapshot rows
#
# The proxy is the only source of truth for quota: it owns the account pool and
# polls the gateway. When nothing answers, the latest SQLite snapshots still give
# a per-account reading, flagged as [stale] so nobody mistakes it for live data.
set -u

DATA="${WARM2API_DATA:-$HOME/.warm2api}"
PROXY="${WARM2API_PROXY:-http://127.0.0.1:${WARM2API_PORT:-41673}}"
JSON=0
[ "${1:-}" = "--json" ] && JSON=1

key=""
[ -n "${WARM2API_API_KEY:-}" ] && key="$WARM2API_API_KEY"
if [ -z "$key" ] && [ -f "$DATA/api-key" ]; then key="$(tr -d ' \n\r' < "$DATA/api-key")"; fi
auth=()
[ -n "$key" ] && auth=(-H "Authorization: Bearer $key")

state="$(curl -fsS --max-time 4 "${auth[@]}" "$PROXY/api/state" 2>/dev/null || true)"

if [ -n "$state" ]; then
  if [ "$JSON" = 1 ]; then printf '%s\n' "$state"; exit 0; fi
  printf '%s' "$state" | jq -r '
    .pool as $p
    | "Warm quota (USD, \(.accounts.total) account\(if .accounts.total == 1 then "" else "s" end))",
      (if $p.limit_usd == null
        then "  budget    unknown — no quota snapshot yet (run: warm2api poll)"
        else "  used      \($p.used_percent)% of $\($p.limit_usd * 100 | round / 100)",
             "  left      $\($p.remaining_usd * 100 | round / 100) (\($p.remaining_usd) of $\($p.limit_usd))",
             "  resets    \($p.resets_at // "unknown" | split("T")[0])",
             "  binding   \($p.binding_label // "-")"
        end),
      "  states    \(.accounts | del(.list, .total) | to_entries | map(select(.value > 0) | "\(.key)=\(.value)") | join(" ") // "-")",
      "  requests  \(.requests.total) total, \(.requests.errors) errors, \(.requests.cache_hit_pct | if . == null then "cache unmeasured" else "\(.)% cached" end)",
      "  models    \(.models | length) available",
      "  source    proxy \(.version) uptime \(.uptime_s)s"'
  exit 0
fi

# Proxy down: report the last snapshot each account wrote, marked stale.
if [ "$JSON" = 1 ]; then
  sqlite3 -readonly "$DATA/state.db" \
    "SELECT a.id, a.label, a.state, s.captured_at, s.raw FROM accounts a
       JOIN usage_snapshots s ON s.id = (SELECT id FROM usage_snapshots WHERE account_id = a.id
                                          ORDER BY captured_at DESC, id DESC LIMIT 1)" 2>/dev/null \
    | jq -R 'split("\t") | {id: .[0], label: .[1], state: .[2], captured_at: (.[3] | tonumber), raw: (.[4] | fromjson?)}' \
    | jq -s '{ok: false, source: "sqlite", accounts: .}'
  exit 0
fi

rows="$(sqlite3 -readonly "$DATA/state.db" \
  "SELECT a.label, a.state, s.captured_at, s.raw FROM accounts a
     JOIN usage_snapshots s ON s.id = (SELECT id FROM usage_snapshots WHERE account_id = a.id
                                        ORDER BY captured_at DESC, id DESC LIMIT 1)" 2>/dev/null)"
if [ -z "$rows" ]; then
  echo "Warm quota: proxy at $PROXY is down and $DATA/state.db has no snapshots" >&2
  exit 1
fi
echo "Warm quota [stale — proxy down at $PROXY]"
printf '%s\n' "$rows" | while IFS=$'\t' read -r label state captured raw; do
  printf '%s' "$raw" | jq -r --arg label "$label" --arg state "$state" --arg captured "$captured" '
    (.usage_windows // .pools // []) as $w
    | ($w | map(.remaining_usd | tonumber? // 0) | add // 0) as $left
    | ($w | map(.limit_usd | tonumber? // 0) | add // 0) as $limit
    | "  \($label) [\($state)]  $\($left) of $\($limit) left  (snapshot \($captured))"'
done
