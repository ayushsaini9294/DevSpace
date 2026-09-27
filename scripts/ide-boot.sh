#!/usr/bin/env bash
# Run as root at WSL boot, after `service docker start` (see /etc/wsl.conf [boot]): waits for
# Docker, then creates the IDE network and applies the IDE firewall. Logs to
# /var/log/devspace-ide-boot.log.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec >>/var/log/devspace-ide-boot.log 2>&1
echo "--- $(date -Is) ide-boot"

for _ in $(seq 1 60); do
  docker info >/dev/null 2>&1 && break
  sleep 1
done

bash "$here/ide-network.sh"
bash "$here/ide-firewall.sh"
