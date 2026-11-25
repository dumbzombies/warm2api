#!/data/data/com.termux/files/usr/bin/bash
# Install warm2api into omp: the extension (provider, /warm and /warm-quota, and
# the bundled proxy it spawns) into the agent's extensions directory.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
agent="${OMP_AGENT_DIR:-$HOME/.omp/agent}"

[ -d "$agent" ] || { echo "omp agent dir not found: $agent" >&2; exit 1; }

mkdir -p "$agent/extensions/warm2api"
cp "$here/src/index.ts" "$agent/extensions/warm2api/index.ts"
cp -R "$here/dist" "$agent/extensions/warm2api/dist"
echo "installed $agent/extensions/warm2api/"

echo "restart omp, then /warm status or /warm-quota. The provider appears as 'warm'."
echo "Override the port with WARM2API_PORT (default 41673)."
