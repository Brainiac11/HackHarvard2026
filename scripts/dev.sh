#!/usr/bin/env bash
# Start the hub and the simulator dev server together. Extra args go to the hub, e.g.:
#   scripts/dev.sh --glove ble --nfc pcsc --assistant chalk
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM

uv run --project "$ROOT/hub" python -m lunarhub "$@" &
(cd "$ROOT/sim" && npx vite --port 5173) &

sleep 3
IP="$(hostname -I | awk '{print $1}')"
echo
echo "  Simulator (laptop):  https://localhost:5173/"
echo "  Hand tracker (iPhone Safari):  https://$IP:5173/tracker.html"
echo "  Hub health:  http://localhost:8000/api/health"
echo
wait
