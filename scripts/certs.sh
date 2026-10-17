#!/usr/bin/env bash
# Locally-trusted HTTPS for the simulator, so browsers stop warning (PLAN.md §9.6). Needs sudo once.
# Re-run whenever the laptop's LAN IP changes (e.g. after switching to the hotspot), then restart scripts/dev.sh.
#   scripts/certs.sh
# iPhone: AirDrop "$(mkcert -CAROOT)/rootCA.pem" to the phone, install the profile, then enable it under
# Settings > General > About > Certificate Trust Settings.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v mkcert >/dev/null || ! command -v certutil >/dev/null; then
  echo "Installing mkcert and certutil (sudo)..."
  sudo apt-get install -y mkcert libnss3-tools
fi
mkcert -install  # local CA into the system store and the Chrome/Firefox NSS databases

mkdir -p "$ROOT/sim/certs"
# shellcheck disable=SC2046  # one SAN per LAN address
mkcert -cert-file "$ROOT/sim/certs/lan.pem" -key-file "$ROOT/sim/certs/lan-key.pem" \
  localhost 127.0.0.1 ::1 "$(hostname)" "$(hostname).local" $(hostname -I)

echo
echo "Done. Restart scripts/dev.sh and open https://localhost:5173/"
echo "If the browser still warns, quit it completely and reopen it so it reloads its trust store."
