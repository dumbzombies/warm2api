#!/data/data/com.termux/files/usr/bin/env bash
# warm2api one-shot installer for Termux (and any Linux with bash).
#
#   curl -fsSL https://raw.githubusercontent.com/dumbzombies/warm2api/main/install.sh | bash
#
# It installs Bun when missing, fetches the repo, compiles the proxy into one
# self-contained binary, and puts `warm2api` on PATH. Nothing else is required:
# no Node, no package registry, no service manager.
#
# Env:
#   WARM2API_HOME   checkout/build location   (default ~/.local/share/warm2api)
#   WARM2API_BIN    install directory for PATH (default: platform default)
#   WARM2API_REF    git ref to build          (default main)
#   WARM2API_REPO   owner/name               (default dumbzombies/warm2api)
set -euo pipefail

REPO="${WARM2API_REPO:-dumbzombies/warm2api}"
REF="${WARM2API_REF:-main}"
HOME_DIR="${WARM2API_HOME:-$HOME/.local/share/warm2api}"

say() { printf 'warm2api: %s\n' "$*" >&2; }
die() { printf 'warm2api: ERROR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- PATH target
# Termux has a real PREFIX/bin; plain Linux uses ~/.local/bin; both are on PATH
# in their respective defaults, and neither needs root.
detect_bin_dir() {
  if [ -n "${WARM2API_BIN:-}" ]; then printf '%s' "$WARM2API_BIN"; return; fi
  if [ -n "${TERMUX_VERSION:-}" ] || [ -d "/data/data/com.termux/files/usr" ]; then
    printf '%s' "${PREFIX:-/data/data/com.termux/files/usr}/bin"
    return
  fi
  printf '%s' "$HOME/.local/bin"
}

# ---------------------------------------------------------------- bun
# Prefer the system package where it exists: Termux's bun package is the only
# supported build there. Elsewhere use Bun's own installer, which needs no sudo.
ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    say "bun $(bun --version) already installed"
    return
  fi
  if command -v pkg >/dev/null 2>&1 && [ -n "${TERMUX_VERSION:-}" ]; then
    say "installing bun from the Termux repository"
    pkg install -y bun >&2 || die "pkg install bun failed"
  else
    say "installing bun to ~/.bun"
    curl -fsSL https://bun.sh/install | bash >&2 || die "bun install failed"
    export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
    export PATH="$BUN_INSTALL/bin:$PATH"
  fi
  command -v bun >/dev/null 2>&1 || die "bun still not on PATH after install"
}

fetch_source() {
  local url="https://github.com/${REPO}.git"
  if command -v git >/dev/null 2>&1; then
    if [ -d "$HOME_DIR/.git" ]; then
      say "updating checkout in $HOME_DIR"
      git -C "$HOME_DIR" fetch --depth 1 origin "$REF" >&2 || die "git fetch failed"
      git -C "$HOME_DIR" checkout -q FETCH_HEAD >&2 || die "git checkout failed"
    else
      say "cloning $REPO ($REF) into $HOME_DIR"
      rm -rf "$HOME_DIR"
      mkdir -p "$(dirname "$HOME_DIR")"
      git clone --depth 1 --branch "$REF" "$url" "$HOME_DIR" >&2 || die "git clone failed"
    fi
    return
  fi
  # No git: take the source tarball, which GitHub always serves.
  say "git missing; downloading the source tarball"
  command -v curl >/dev/null 2>&1 || die "curl is required"
  rm -rf "$HOME_DIR" && mkdir -p "$HOME_DIR"
  curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/refs/heads/${REF}" |
    tar -xz -C "$HOME_DIR" --strip-components=1 || die "tarball download failed"
}

BIN_DIR="$(detect_bin_dir)"
say "installing into $HOME_DIR, command in $BIN_DIR"

ensure_bun
fetch_source

say "compiling the proxy (this takes a few seconds)"
mkdir -p "$BIN_DIR"
cd "$HOME_DIR"
bun build --compile --target=bun ./src/main.ts --outfile="$BIN_DIR/warm2api" >&2 ||
  die "compile failed"

chmod +x "$BIN_DIR/warm2api" 2>/dev/null || true
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "WARNING: $BIN_DIR is not on PATH; add it or run $BIN_DIR/warm2api directly" ;;
esac

"$BIN_DIR/warm2api" version >/dev/null 2>&1 || die "installed binary does not run"

cat >&2 <<EOF

warm2api is installed: $BIN_DIR/warm2api

  warm2api start        # run in the background
  warm2api status       # health, URL, dashboard link
  warm2api add          # approve a Warm account
  warm2api stop         # stop it
  warm2api --help       # everything else

Data (database, API key, logs): ${WARM2API_DATA:-$HOME/.warm2api}
EOF
