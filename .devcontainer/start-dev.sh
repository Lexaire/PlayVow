#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"

if timeout 1 bash -c '</dev/tcp/127.0.0.1/3000' >/dev/null 2>&1; then
  echo "PlayVow is already running on port 3000."
  exit 0
fi

mise exec -- bun run dev
