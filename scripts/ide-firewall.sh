#!/usr/bin/env bash
# Firewall for DevSpace IDE containers (Phase 5 design, see docs/decisions.md). Run as root; safe to run
# again (it rebuilds its own chains and adds each jump only once).
#
# Containers on bridge br-dsp-ide:
#   - cannot open connections to the host itself (the API, PostgreSQL, Redis, the Docker host's
#     DNS, anything listening on it), whatever address they use, except the API's AI gateway
#     (Phase 12): TCP to AI_GATEWAY_HOST:AI_GATEWAY_PORT (default 10.213.0.1:3200, the bridge's
#     own address) and nothing else;
#   - cannot reach private, loopback, link-local, CGNAT or multicast ranges, so no other
#     container, no Windows host behind WSL, no local network;
#   - can reach the internet (Docker masquerades their traffic);
#   - still answer the API: replies to connections the host opened to them are allowed.
#
# Uses the iptables backend Docker uses (iptables-legacy on the WSL setup). Override with
# IPTABLES=iptables-nft if needed. Rules are not persistent: run at boot after Docker and
# scripts/ide-network.sh (see /etc/wsl.conf [boot]), and in CI.
set -euo pipefail

BRIDGE=br-dsp-ide
# The API's AI gateway (Phase 12): same defaults as the API (AI_GATEWAY_HOST, AI_GATEWAY_PORT).
AI_GATEWAY_HOST="${AI_GATEWAY_HOST:-10.213.0.1}"
AI_GATEWAY_PORT="${AI_GATEWAY_PORT:-3200}"
[[ "$AI_GATEWAY_HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "ide-firewall: AI_GATEWAY_HOST must be an IPv4 address" >&2; exit 1; }
[[ "$AI_GATEWAY_PORT" =~ ^[0-9]+$ ]] || { echo "ide-firewall: AI_GATEWAY_PORT must be a port number" >&2; exit 1; }
IN_CHAIN=DEVSPACE-IDE-IN
FWD_CHAIN=DEVSPACE-IDE-FWD

BLOCKED_RANGES=(
  0.0.0.0/8       # "this" network
  10.0.0.0/8      # private (includes this bridge, 10.213.0.0/24, and WSL's DNS 10.255.255.254)
  100.64.0.0/10   # carrier-grade NAT / VPNs
  127.0.0.0/8     # loopback
  169.254.0.0/16  # link-local (cloud metadata endpoints)
  172.16.0.0/12   # private (Docker's other networks, the WSL/Windows host)
  192.168.0.0/16  # private (local network)
  224.0.0.0/4     # multicast
  240.0.0.0/4     # reserved and broadcast
)

if [ "$(id -u)" -ne 0 ]; then
  echo "ide-firewall: run as root" >&2
  exit 1
fi

pick_iptables() {
  if [ -n "${IPTABLES:-}" ]; then
    echo "$IPTABLES"
    return
  fi
  # Use whichever backend holds Docker's DOCKER-USER chain, preferring legacy.
  for candidate in iptables-legacy iptables-nft iptables; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -w -n -L DOCKER-USER >/dev/null 2>&1; then
      echo "$candidate"
      return
    fi
  done
  echo "ide-firewall: Docker's DOCKER-USER chain was not found. Is Docker running?" >&2
  exit 1
}

IPT="$(pick_iptables)"
ipt() { "$IPT" -w "$@"; }

ensure_chain() {
  ipt -n -L "$1" >/dev/null 2>&1 || ipt -N "$1"
  ipt -F "$1"
}

ensure_jump() { # parent chain, rule...
  local parent="$1"
  shift
  ipt -C "$parent" "$@" 2>/dev/null || ipt -I "$parent" 1 "$@"
}

# Traffic from a container to the host itself (INPUT): only replies to connections the host
# opened (the API proxying to the IDE) are accepted; everything else is dropped.
ensure_chain "$IN_CHAIN"
ipt -A "$IN_CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
# The one exception (Phase 12): the API's AI gateway, on the bridge's own address and one port.
ipt -A "$IN_CHAIN" -p tcp -d "$AI_GATEWAY_HOST" --dport "$AI_GATEWAY_PORT" -j ACCEPT
ipt -A "$IN_CHAIN" -j DROP
ensure_jump INPUT -i "$BRIDGE" -j "$IN_CHAIN"

# Traffic from a container through the host (FORWARD, via Docker's DOCKER-USER hook): private
# and special ranges are refused, the internet is allowed (RETURN hands over to Docker's rules).
ensure_chain "$FWD_CHAIN"
ipt -A "$FWD_CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
for range in "${BLOCKED_RANGES[@]}"; do
  ipt -A "$FWD_CHAIN" -d "$range" -j REJECT --reject-with icmp-admin-prohibited
done
ipt -A "$FWD_CHAIN" -j RETURN
ensure_jump DOCKER-USER -i "$BRIDGE" -j "$FWD_CHAIN"

echo "ide-firewall: rules for $BRIDGE are in place, AI gateway $AI_GATEWAY_HOST:$AI_GATEWAY_PORT allowed ($IPT)"
