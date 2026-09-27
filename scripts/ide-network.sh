#!/usr/bin/env bash
# Creates the Docker network that DevSpace IDE containers join (Phase 5 contract in CLAUDE.md).
# Safe to run again: an existing network with the right settings is left alone, and one with
# different settings is reported instead of silently kept.
#
#   network devspace-ide, bridge br-dsp-ide, subnet 10.213.0.0/24, container-to-container traffic off
#
# Run scripts/ide-firewall.sh (as root) after this to block the host and private ranges.
set -euo pipefail

NETWORK=devspace-ide
BRIDGE=br-dsp-ide
SUBNET=10.213.0.0/24

current() {
  docker network inspect "$NETWORK" --format \
    '{{.Driver}} {{(index .IPAM.Config 0).Subnet}} {{index .Options "com.docker.network.bridge.name"}} {{index .Options "com.docker.network.bridge.enable_icc"}} {{.EnableIPv6}}'
}

want="bridge $SUBNET $BRIDGE false false"

if docker network inspect "$NETWORK" >/dev/null 2>&1; then
  have="$(current)"
  if [ "$have" != "$want" ]; then
    echo "ide-network: network $NETWORK exists with the wrong settings." >&2
    echo "  have: $have" >&2
    echo "  want: $want" >&2
    echo "  Stop its containers, run 'docker network rm $NETWORK', then run this again." >&2
    exit 1
  fi
  echo "ide-network: $NETWORK already exists ($SUBNET on $BRIDGE, icc off)"
  exit 0
fi

docker network create \
  --driver bridge \
  --subnet "$SUBNET" \
  --ipv6=false \
  --opt com.docker.network.bridge.name="$BRIDGE" \
  --opt com.docker.network.bridge.enable_icc=false \
  --label devspace.role=ide \
  "$NETWORK" >/dev/null

have="$(current)"
if [ "$have" != "$want" ]; then
  echo "ide-network: created $NETWORK but its settings are wrong: $have" >&2
  exit 1
fi
echo "ide-network: created $NETWORK ($SUBNET on $BRIDGE, icc off)"
