#!/usr/bin/env bash
# Laptop Wi-Fi hotspot (fallback if venue Wi-Fi isolates clients). Preferred: iPhone Personal Hotspot instead.
#   scripts/hotspot.sh up | down
set -euo pipefail
IFACE="${IFACE:-wlp0s20f3}"
case "${1:-}" in
  up) nmcli dev wifi hotspot ifname "$IFACE" ssid LunarHaptics password "${HOTSPOT_PASSWORD:-moonwalk2026}" ;;
  down) nmcli connection down Hotspot ;;
  *) echo "usage: $0 up|down"; exit 1 ;;
esac
