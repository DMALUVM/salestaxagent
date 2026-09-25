#!/bin/bash
# Install the 07:20 failure-only health check LaunchAgent.
# Does not touch com.tallowbourn.salestax (the sync agent).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LABEL="com.tallowbourn.healthcheck"
SRC="${ROOT}/deploy/launchd/${LABEL}.plist"
DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if [[ ! -f "${SRC}" ]]; then
  echo "missing plist: ${SRC}" >&2
  exit 1
fi

mkdir -p "${HOME}/Library/LaunchAgents" "${ROOT}/logs"
cp "${SRC}" "${DEST}"

# Reload if a previous copy is loaded. `load` matches the sync-agent install.
launchctl unload "${DEST}" 2>/dev/null || true
launchctl load "${DEST}"

echo "Loaded ${LABEL}."
echo "Fires daily at 07:20 in the Mac system timezone."
echo "The Mac timezone must be America/New_York."
echo "Required in ${ROOT}/.env:"
echo "  GROKBOT_HEALTH_WEBHOOK_URL"
echo "  GROKBOT_HEALTH_WEBHOOK_KEY"
echo "Optional:"
echo "  GROKBOT_HEALTH_WEBHOOK_HEADER   (default: Authorization: Bearer <key>)"
echo "  GROKBOT_ADS_CLEAR_DEADLINE      (default: 07:15)"
echo "  GROKBOT_SYNC_LAUNCHD_LABEL      (default: com.tallowbourn.salestax)"
echo "  VERCEL_TOKEN                    (skip the Vercel check when unset)"
echo "  VERCEL_ORG_ID or VERCEL_TEAM_ID"
echo "  VERCEL_PROJECT_ID               (default project name: dashboard)"
