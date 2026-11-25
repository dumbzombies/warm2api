#!/data/data/com.termux/files/usr/bin/bash
# Install the Warm provider, /warm-quota command and the bundled proxy into
# opencode.
#   1. plugin file -> ~/.config/opencode/plugins/ (starts the proxy at load)
#   2. provider block merged into opencode.jsonc
#   3. /warm-quota command + the shared quota script in ~/.local/bin
#
# This opencode build evaluates plugin modules but never calls their hooks, so
# the provider must live in the config; the plugin only guarantees the proxy the
# block points at is up.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
cfg="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
bin="${WARM_QUOTA_BIN:-$HOME/.local/bin}"
port="${WARM2API_PORT:-41673}"

[ -d "$cfg" ] || { echo "opencode config dir not found: $cfg" >&2; exit 1; }

mkdir -p "$cfg/plugins" "$cfg/command" "$bin"
cp "$here/plugins/warm2api.ts" "$cfg/plugins/"
cp "$here/commands/warm-quota.md" "$cfg/command/"
cp "$here/../shared/warm-quota.sh" "$bin/warm-quota"
chmod +x "$bin/warm-quota"
echo "installed $cfg/plugins/warm2api.ts, $cfg/command/warm-quota.md and $bin/warm-quota"

conf="$cfg/opencode.jsonc"
[ -f "$conf" ] || printf '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' > "$conf"
python3 - "$conf" "$here/opencode.jsonc.example" "$port" <<'PY'
import json, shutil, sys
conf, example, port = sys.argv[1], sys.argv[2], sys.argv[3]
with open(conf) as f:
    data = json.load(f)
with open(example) as f:
    block = json.load(f)["provider"]["warm"]
block["options"]["baseURL"] = f"http://127.0.0.1:{port}/v1"
existing = data.get("provider", {}).get("warm")
if existing == block:
    print("provider already present in", conf)
    raise SystemExit
shutil.copy(conf, conf + ".bak-warm2api")
data.setdefault("provider", {})["warm"] = block
with open(conf, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print("merged warm provider into", conf, "(backup: opencode.jsonc.bak-warm2api)")
PY

echo "restart opencode; pick a warm/* model, or run /warm-quota."
echo "The plugin starts the bundled proxy on 127.0.0.1:${port} (WARM2API_PORT)."
