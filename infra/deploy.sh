#!/usr/bin/env bash
# Build locally, rsync .output to the VPS, flip the `current` symlink,
# restart playvow-web + playvow-worker. Fails loudly with actionable
# guidance — the error message tells you exactly what to fix.
#
# Usage:    ./infra/deploy.sh [--check]
# Env:      PLAYVOW_HOST (deploy@playvow.com), PLAYVOW_APP_DIR (/opt/playvow),
#           PLAYVOW_KEEP (5), PLAYVOW_ENV_FILE (infra/.env.production)

set -euo pipefail

HOST="${PLAYVOW_HOST:-deploy@playvow.com}"
APP_DIR="${PLAYVOW_APP_DIR:-/opt/playvow}"
KEEP="${PLAYVOW_KEEP:-5}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
ENV_FILE="${PLAYVOW_ENV_FILE:-$REPO_ROOT/infra/.env.production}"
# DB_MODE/LOCAL_DB_PATH live in a separate file so $ENV_FILE can be
# byte-identical to what's uploaded to the server (where the systemd unit
# supplies DB_MODE per service). Local CLI invocations need both files.
CLI_ENV_FILE="${PLAYVOW_CLI_ENV_FILE:-$REPO_ROOT/infra/.env.cli-prod}"

CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

step() { printf '→ %s\n' "$*"; }
ok()   { printf '✓ %s\n' "$*"; }
fail() { printf '\n✗ %s\n\n%s\n\n' "$1" "${2:-}" >&2; exit 1; }

# --- ssh multiplexing ---
# UFW's `rule: limit` (set in infra/ansible/playbooks/harden.yml) caps new
# SSH connections at 6 per 30 s per source IP. This script otherwise opens
# ~8 distinct connections (preflight checks, mkdir, rsync, scp, activate),
# which trips the limiter mid-deploy. Multiplex them all through one master
# connection so the deploy uses a single TCP connection from start to finish.

SSH_CM_DIR="$(mktemp -d -t playvow-deploy-ssh.XXXXXX)"
SSH_OPTS=(-o ControlMaster=auto -o "ControlPath=${SSH_CM_DIR}/%C" -o ControlPersist=10m)
# rsync spawns its own ssh, so it needs the options via RSYNC_RSH.
export RSYNC_RSH="ssh -o ControlMaster=auto -o ControlPath=${SSH_CM_DIR}/%C -o ControlPersist=10m"

cleanup() {
  # Smoke server (only set while the smoke phase is running).
  if [[ -n "${SMOKE_PID:-}" ]] && kill -0 "$SMOKE_PID" 2>/dev/null; then
    kill "$SMOKE_PID" 2>/dev/null || true
    wait "$SMOKE_PID" 2>/dev/null || true
  fi
  [[ -n "${SMOKE_LOG:-}" ]] && rm -f "$SMOKE_LOG" "$SMOKE_LOG.body" 2>/dev/null || true
  # SSH master — close cleanly so we don't leave a socket behind.
  if [[ -d "$SSH_CM_DIR" ]]; then
    ssh "${SSH_OPTS[@]}" -O exit "$HOST" 2>/dev/null || true
    rm -rf "$SSH_CM_DIR"
  fi
}
trap cleanup EXIT

# --- preflight ---

step "Checking local toolchain"
for cmd in bun ssh scp rsync; do
  command -v "$cmd" >/dev/null || fail "Missing required command: $cmd" \
"Install with mise (preferred):  mise install
Or for bun directly:             curl -fsSL https://bun.sh/install | bash
For ssh/scp/rsync:               your OS package manager (apt, brew, …)"
done

step "Checking env files"
[[ -f "$ENV_FILE" ]] || fail "Production env file not found: $ENV_FILE" \
"Create it (gitignored) with your production secrets:
  cp .env.example $ENV_FILE
  \$EDITOR $ENV_FILE     # fill every key with the real value
Or point elsewhere:  PLAYVOW_ENV_FILE=/path/to/.env make deploy"

[[ -f "$CLI_ENV_FILE" ]] || fail "CLI env file not found: $CLI_ENV_FILE" \
"This file holds DB_MODE and LOCAL_DB_PATH for local CLI invocations
(scrape-once, migrate-check, …) — they're kept out of $ENV_FILE so the
file uploaded to the server is byte-identical to the local one and the
systemd unit's Environment= directives win.
Create it with:
  printf 'DB_MODE=remote\\nLOCAL_DB_PATH=file:local-prod.db\\n' > $CLI_ENV_FILE"

if [[ -f "$REPO_ROOT/.env.example" ]]; then
  missing=()
  while IFS= read -r key; do
    [[ -n "$key" ]] || continue
    grep -qE "^${key}=.+" "$ENV_FILE" && continue
    grep -qE "^${key}=.+" "$CLI_ENV_FILE" && continue
    missing+=("$key")
  done < <(grep -E '^[A-Z_][A-Z0-9_]*=' "$REPO_ROOT/.env.example" | cut -d= -f1)
  (( ${#missing[@]} > 0 )) && fail "Env files are missing values for: ${missing[*]}" \
"Open $ENV_FILE (or $CLI_ENV_FILE for DB_MODE/LOCAL_DB_PATH) and fill those
keys (compare against .env.example). Empty values are not deployed — the
worker and web both validate env at startup and refuse to run with blanks."
fi
ok "Env files have values for every .env.example key"

step "Checking SSH to $HOST"
ssh "${SSH_OPTS[@]}" -o BatchMode=yes -o ConnectTimeout=8 "$HOST" true 2>/dev/null || fail \
  "Cannot SSH to $HOST without a password prompt" \
"Things to try:
  1. Override the target:  PLAYVOW_HOST=deploy@<vps-ip> make deploy
  2. Add your key:         ssh-copy-id $HOST
  3. Bootstrap fresh VPS:  cd infra/ansible && \\
                           ansible-playbook playbooks/bootstrap.yml -u root -e ansible_host=<vps-ip>
  4. Try interactively:    ssh $HOST"
ok "SSH ok"

step "Checking $HOST:$APP_DIR layout"
ssh "${SSH_OPTS[@]}" "$HOST" "test -d '$APP_DIR/releases' && test -d '$APP_DIR/shared'" 2>/dev/null || \
  fail "$APP_DIR is not provisioned on $HOST" \
"Run the Ansible site playbook to create app dirs, install systemd units,
and configure Caddy:
  cd infra/ansible && ansible-playbook playbooks/site.yml
(Override PLAYVOW_APP_DIR if you intentionally moved the install location.)"

units_missing=$(ssh "${SSH_OPTS[@]}" "$HOST" '
  for u in playvow-web.service playvow-worker.service; do
    test -f /etc/systemd/system/$u || echo $u
  done
' 2>/dev/null || true)
[[ -z "$units_missing" ]] || fail \
  "Systemd units missing on $HOST: $units_missing" \
"Re-run the deploy playbook to install the unit files:
  cd infra/ansible && ansible-playbook playbooks/deploy.yml"
ok "App dir + systemd units present"

step "Checking pending migrations on prod DB"
bun --env-file="$ENV_FILE" --env-file="$CLI_ENV_FILE" run src/db/migrate-check.ts || \
  fail "Pending database migrations — refusing to deploy" \
"This deploy script does not run migrations on its own. Apply them first
(see the list above), then re-run deploy:
  make prod-db-migrate"
ok "DB schema is up to date"

if (( CHECK_ONLY )); then
  ok "Preflight passed (--check). Skipping build and deploy."
  exit 0
fi

# --- build ---

step "Building locally"
bun install --frozen-lockfile
bun --env-file="$ENV_FILE" run build

[[ -d .output/server ]] || fail \
  ".output/server missing — Nitro did not produce a server bundle" \
"Try a clean build:
  rm -rf .output node_modules && bun install && bun run build"
[[ -f .output/server/worker.mjs ]] || fail \
  ".output/server/worker.mjs missing — worker bundle not produced" \
"Run the worker build directly to see the error:  bun run build:worker"

# --- smoke test ---
# Boot the built bundle locally with the prod env, curl /, expect 200.
# Catches SSR-only regressions (jsxDEV in prod, missing vendored deps,
# import errors at startup) before any release dir exists on the host.

step "Smoke testing built bundle"
SMOKE_PORT="${PLAYVOW_SMOKE_PORT:-14321}"
SMOKE_LOG="$(mktemp)"
PORT="$SMOKE_PORT" HOST=127.0.0.1 \
  node --env-file="$ENV_FILE" --env-file="$CLI_ENV_FILE" .output/server/index.mjs \
  >"$SMOKE_LOG" 2>&1 &
SMOKE_PID=$!

for _ in $(seq 1 30); do
  curl -fsS -o /dev/null "http://127.0.0.1:$SMOKE_PORT/" 2>/dev/null && break
  if ! kill -0 "$SMOKE_PID" 2>/dev/null; then
    echo "--- smoke server log ---" >&2
    cat "$SMOKE_LOG" >&2
    fail "Smoke test failed: bundle crashed during startup" \
"The built server exited before binding port $SMOKE_PORT. Common causes:
  * missing env var the runtime needs (compare against .env.example)
  * a bad import (vendored dep absent, native module mismatch)
  * a top-level throw at module load
Reproduce locally:
  PORT=$SMOKE_PORT node --env-file=$ENV_FILE --env-file=$CLI_ENV_FILE .output/server/index.mjs"
  fi
  sleep 0.5
done

SMOKE_CODE=$(curl -sS -o "$SMOKE_LOG.body" \
  -w "%{http_code}" "http://127.0.0.1:$SMOKE_PORT/" || echo "000")
if [[ "$SMOKE_CODE" != "200" ]]; then
  echo "--- smoke server log (last 60 lines) ---" >&2
  tail -n 60 "$SMOKE_LOG" >&2
  echo "--- response body (first 500 bytes) ---" >&2
  head -c 500 "$SMOKE_LOG.body" >&2 || true
  echo >&2
  rm -f "$SMOKE_LOG.body"
  fail "Smoke test failed: GET / returned HTTP $SMOKE_CODE" \
"The bundle started but didn't render the homepage cleanly. Refusing to ship.
Reproduce locally:
  PORT=$SMOKE_PORT node --env-file=$ENV_FILE --env-file=$CLI_ENV_FILE .output/server/index.mjs
  curl -i http://127.0.0.1:$SMOKE_PORT/"
fi
rm -f "$SMOKE_LOG.body"
# Stop the smoke server now that we're done with it; the EXIT trap will
# also handle this if we bail out for another reason later.
if kill -0 "$SMOKE_PID" 2>/dev/null; then
  kill "$SMOKE_PID" 2>/dev/null || true
  wait "$SMOKE_PID" 2>/dev/null || true
fi
SMOKE_PID=""
ok "Smoke test passed (HTTP 200 from /)"

# --- ship ---

RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RELEASE_DIR="$APP_DIR/releases/$RELEASE_ID"

step "Creating release dir: $RELEASE_DIR"
ssh "${SSH_OPTS[@]}" "$HOST" "mkdir -p '$RELEASE_DIR'" || fail \
  "Could not create $RELEASE_DIR on $HOST" \
"Check disk space and permissions:
  ssh $HOST 'df -h $APP_DIR && ls -ld $APP_DIR/releases'"

step "Rsyncing .output/"
rsync -az --delete --info=stats1,progress2 \
  .output/ "$HOST:$RELEASE_DIR/.output/" || fail \
  "rsync failed mid-transfer" \
"Partial release at $RELEASE_DIR is harmless — the symlink wasn't flipped.
Re-run after fixing the transport issue (network, disk full, …)."

step "Uploading $(basename "$ENV_FILE") → $APP_DIR/shared/.env"
scp "${SSH_OPTS[@]}" -q "$ENV_FILE" "$HOST:$APP_DIR/shared/.env.new" || fail \
  "Could not upload env file" \
"Check that $APP_DIR/shared exists and is writable by the deploy user:
  ssh $HOST 'ls -ld $APP_DIR/shared'"
ssh "${SSH_OPTS[@]}" "$HOST" "chmod 600 '$APP_DIR/shared/.env.new' && \
             mv -f '$APP_DIR/shared/.env.new' '$APP_DIR/shared/.env'"

# --- activate + restart ---

step "Activating release and restarting services"
ssh "${SSH_OPTS[@]}" "$HOST" "set -euo pipefail
  ln -sfn '$RELEASE_DIR' '$APP_DIR/current.new'
  mv -Tf '$APP_DIR/current.new' '$APP_DIR/current'
  sudo /bin/systemctl restart playvow-web.service
  sudo /bin/systemctl restart playvow-worker.service
  sleep 2
  for u in playvow-web.service playvow-worker.service; do
    if ! sudo /bin/systemctl is-active --quiet \$u; then
      echo \"FAILED: \$u is not active after restart\" >&2
      sudo /bin/systemctl status \$u --no-pager --lines=30 >&2 || true
      exit 1
    fi
  done
  cd '$APP_DIR/releases'
  ls -1t | tail -n +$((KEEP + 1)) | xargs -r rm -rf
" || fail "Service restart failed — see logs above" \
"The release directory was created but services didn't come back up cleanly.
Triage on the host:
  ssh $HOST 'journalctl -u playvow-web -u playvow-worker -n 100 --no-pager'
Roll back to the previous release:
  ssh $HOST 'ls -1t $APP_DIR/releases | head'
  ssh $HOST 'ln -sfn $APP_DIR/releases/<previous-id> $APP_DIR/current && \\
             sudo systemctl restart playvow-web playvow-worker'"

ok "Deployed $RELEASE_ID"
echo "logs: ssh $HOST 'journalctl -u playvow-web -u playvow-worker -f'"
