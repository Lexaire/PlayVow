#!/usr/bin/env bash
# Online SQLite snapshot of the libSQL embedded replica → zstd → Backblaze B2.
# Invoked by playvow-backup.timer; safe to run manually as the deploy user.
set -euo pipefail

default_env=/opt/playvow/shared/.backup/backup.env
if [[ -f "$default_env" ]]; then
  set -a; . "$default_env"; set +a
fi

# healthchecks.io dead-man's-switch. No-op if HEALTHCHECKS_URL is unset/empty,
# which keeps local runs and pre-configuration deploys quiet.
hc_ping() {
  [[ -n "${HEALTHCHECKS_URL:-}" ]] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null "$HEALTHCHECKS_URL$1" || true
}

cleanup() {
  local rc=$?
  if (( rc != 0 )); then hc_ping /fail; fi
  [[ -n "${tmp:-}" ]] && rm -rf "$tmp"
}
trap cleanup EXIT

: "${DB_PATH:?DB_PATH is required}"
: "${B2_BUCKET:?B2_BUCKET is required}"
: "${RCLONE_CONFIG:?RCLONE_CONFIG is required}"

hc_ping /start

ts=$(date -u +%Y-%m-%dT%H-%M-%SZ)
year=$(date -u +%Y)
month=$(date -u +%m)

tmp=$(mktemp -d)
snapshot="$tmp/$ts.db"

# sqlite3 .backup uses the online backup API — safe against a live writer and
# correctly merges WAL contents into a single self-contained file.
sqlite3 "$DB_PATH" ".backup '$snapshot'"
zstd -19 --rm "$snapshot"

rclone copyto \
  --config "$RCLONE_CONFIG" \
  --retries 5 \
  --low-level-retries 10 \
  "$snapshot.zst" \
  "b2:$B2_BUCKET/$year/$month/$ts.db.zst"

echo "uploaded b2:$B2_BUCKET/$year/$month/$ts.db.zst"
hc_ping ""
