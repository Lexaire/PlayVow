#!/usr/bin/env bash
# Download the official Node.js binary from nodejs.org and stage it at
# .output/node so the deploy artifact ships its own runtime. The VPS does
# not need Node installed via apt — bumping Node is a code change in this
# repo, not a server task.
#
# Keep NODE_VERSION in sync with mise.toml. Override NODE_PLATFORM if the
# server architecture changes (default linux-x64; Node also publishes
# linux-arm64, linux-armv7l, etc).

set -euo pipefail

NODE_VERSION="24.15.0"
NODE_PLATFORM="${NODE_PLATFORM:-linux-x64}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="$REPO_ROOT/.cache/node"
CACHED_DIR="$CACHE_DIR/node-v$NODE_VERSION-$NODE_PLATFORM"
CACHED_NODE="$CACHED_DIR/bin/node"
OUT_DIR="$REPO_ROOT/.output"
OUT_NODE="$OUT_DIR/node"

# sha256 verification — sha256sum on Linux/coreutils, shasum on macOS.
SHA_CMD=(sha256sum)
command -v sha256sum >/dev/null 2>&1 || SHA_CMD=(shasum -a 256)

if [[ ! -x "$CACHED_NODE" ]]; then
  TARBALL="node-v$NODE_VERSION-$NODE_PLATFORM.tar.xz"
  URL_BASE="https://nodejs.org/dist/v$NODE_VERSION"
  TMPDIR="$(mktemp -d -t playvow-node.XXXXXX)"
  trap 'rm -rf "$TMPDIR"' EXIT

  echo "→ Downloading Node $NODE_VERSION ($NODE_PLATFORM)"
  curl -fsSLo "$TMPDIR/$TARBALL" "$URL_BASE/$TARBALL"
  curl -fsSLo "$TMPDIR/SHASUMS256.txt" "$URL_BASE/SHASUMS256.txt"

  echo "→ Verifying SHA256"
  ( cd "$TMPDIR" && grep " $TARBALL\$" SHASUMS256.txt | "${SHA_CMD[@]}" -c - )

  echo "→ Extracting to $CACHE_DIR"
  mkdir -p "$CACHE_DIR"
  tar -xJf "$TMPDIR/$TARBALL" -C "$CACHE_DIR"
fi

mkdir -p "$OUT_DIR"
install -m 755 "$CACHED_NODE" "$OUT_NODE"

echo "✓ Node $NODE_VERSION ($NODE_PLATFORM) staged at .output/node"
