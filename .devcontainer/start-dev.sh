#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"

# Steam OpenID's return_to is built from STEAM_OPENID_REALM. In a Codespace
# the browser hits https://${CODESPACE_NAME}-3000.${forwarding-domain}, not
# localhost, so the realm baked in by .env.example would send users to an
# unreachable host after sign-in. Rewrite it to the actual forwarded URL
# every start so the value tracks the codespace it's running in.
if [[ -n "${CODESPACE_NAME:-}" && -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" && -f .env ]]; then
  realm="https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
  if grep -q '^STEAM_OPENID_REALM=' .env; then
    sed -i "s|^STEAM_OPENID_REALM=.*|STEAM_OPENID_REALM=${realm}|" .env
  else
    printf '\nSTEAM_OPENID_REALM=%s\n' "$realm" >> .env
  fi
fi

if timeout 1 bash -c '</dev/tcp/127.0.0.1/3000' >/dev/null 2>&1; then
  echo "PlayVow is already running on port 3000."
  exit 0
fi

mise exec -- bun run dev
