#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"

if ! command -v mise >/dev/null 2>&1; then
  curl https://mise.run | sh
fi

mise trust
mise install
mise exec -- bun install --frozen-lockfile

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

mise exec -- bun run setup:demo
