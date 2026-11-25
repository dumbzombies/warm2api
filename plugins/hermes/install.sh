#!/data/data/com.termux/files/usr/bin/bash
# Install warm2api as a Hermes custom provider. Hermes discovers providers from
# ~/.hermes/model-providers/<name>/ holding __init__.py + plugin.yaml.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
dest="${HERMES_HOME:-$HOME/.hermes}/model-providers"

mkdir -p "$dest"
rm -rf "$dest/warm2api"
cp -R "$here" "$dest/warm2api"
echo "installed $dest/warm2api"

echo "restart hermes; the provider appears as 'warm2api'."
echo "Set WARM2API_API_KEY (the proxy writes it to ~/.warm2api/api-key)."
