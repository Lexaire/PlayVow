#!/bin/sh
# Liveness probe for playvow-web. Tracks consecutive failures across timer
# firings; only signals a restart once $THRESHOLD ticks in a row have failed.
#
# Exit 0 = healthy *or* still within the grace window (no restart).
# Exit 1 = threshold reached; ExecStopPost in the .service unit restarts web.
#
# State lives in /run (tmpfs) so it resets on reboot and never accumulates.

set -u

URL="${PLAYVOW_HEALTHZ_URL:-http://127.0.0.1:3000/healthz}"
STATE="${PLAYVOW_HEALTHZ_STATE:-/run/playvow-web-healthcheck.count}"
THRESHOLD="${PLAYVOW_HEALTHZ_THRESHOLD:-3}"
TIMEOUT="${PLAYVOW_HEALTHZ_TIMEOUT:-5}"

if curl -fsS --max-time "$TIMEOUT" "$URL" >/dev/null 2>&1; then
  rm -f "$STATE"
  exit 0
fi

prev=$(cat "$STATE" 2>/dev/null || echo 0)
case "$prev" in
  ''|*[!0-9]*) prev=0 ;;
esac
n=$((prev + 1))
printf '%s\n' "$n" > "$STATE"

if [ "$n" -ge "$THRESHOLD" ]; then
  rm -f "$STATE"
  exit 1
fi
exit 0
