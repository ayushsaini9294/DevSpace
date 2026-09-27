#!/usr/bin/env bash
# Checks that the ports DevSpace needs are free before `npm run dev` or the e2e tests start:
# the API (PORT, 3000), the IDE listener (IDE_PORT, 3100) and the web app (5173).
# Exits 1 and names the process holding a port that is already taken. Used in CI.
set -euo pipefail

ports=("${PORT:-3000}" "${IDE_PORT:-3100}" 5173)
busy=0

for port in "${ports[@]}"; do
  holder="$(ss -Hltnp "sport = :$port" 2>/dev/null || true)"
  if [ -n "$holder" ]; then
    echo "check-ports: port $port is already in use:" >&2
    echo "  $holder" >&2
    busy=1
  else
    echo "check-ports: port $port is free"
  fi
done

if [ "$busy" -ne 0 ]; then
  echo "check-ports: stop whatever holds these ports (an old 'npm run dev'?) and try again." >&2
  exit 1
fi
