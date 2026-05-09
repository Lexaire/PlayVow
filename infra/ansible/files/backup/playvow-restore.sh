#!/usr/bin/env bash
# Pull a backup from B2 by key, decompress, and verify it opens cleanly.
# Does NOT touch the live database — only fetches and validates.
#
# Usage:
#   playvow-restore <object-key> [<output-path>]
#
# Examples:
#   playvow-restore 2026/04/2026-04-28T15-00-00Z.db.zst
#   playvow-restore 2026/04/2026-04-28T15-00-00Z.db.zst /tmp/restored.db
#
# List backups:
#   rclone --config /opt/playvow/shared/.backup/rclone.conf ls b2:<bucket>
set -euo pipefail

default_env=/opt/playvow/shared/.backup/backup.env
if [[ -f "$default_env" ]]; then
  set -a; . "$default_env"; set +a
fi

: "${B2_BUCKET:?B2_BUCKET is required}"
: "${RCLONE_CONFIG:?RCLONE_CONFIG is required}"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <object-key> [<output-path>]" >&2
  echo "list: rclone --config $RCLONE_CONFIG ls b2:$B2_BUCKET" >&2
  exit 2
fi

key=$1
out=${2:-/tmp/playvow-restored-$(date -u +%Y%m%dT%H%M%SZ).db}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

rclone copyto --config "$RCLONE_CONFIG" "b2:$B2_BUCKET/$key" "$tmp/dump.db.zst"
if [[ ! -s "$tmp/dump.db.zst" ]]; then
  echo "object not found in bucket: $key" >&2
  echo "list available: rclone --config $RCLONE_CONFIG ls b2:$B2_BUCKET" >&2
  exit 1
fi
unzstd --rm "$tmp/dump.db.zst"

result=$(sqlite3 "$tmp/dump.db" 'PRAGMA integrity_check;')
if [[ "$result" != "ok" ]]; then
  echo "integrity check failed: $result" >&2
  exit 1
fi

mv "$tmp/dump.db" "$out"
echo "restored to $out (integrity ok)"
