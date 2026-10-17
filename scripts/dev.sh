#!/usr/bin/env bash
# Start the hub and the simulator dev server together. Extra args go to the hub, e.g.:
#   scripts/dev.sh --glove ble --nfc pcsc --assistant chalk
#   scripts/dev.sh --anyhand        # also start the AnyHand laptop hand tracker (scripts/setup_anyhand.sh first)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

ANYHAND=0
HUB_ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--anyhand" ]]; then ANYHAND=1; else HUB_ARGS+=("$arg"); fi
done
PORTS=(8000 5173)
[[ $ANYHAND == 1 ]] && PORTS+=(8001)

# A leftover hub/sim on these ports means the browser keeps talking to the old processes (old .env, old flags).
for port in "${PORTS[@]}"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    echo "Port $port is already in use: an old hub or simulator is still running." >&2
    echo "Stop it first:  kill \$(lsof -t -iTCP:$port -sTCP:LISTEN)" >&2
    exit 1
  fi
done

cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM

uv run --project "$ROOT/hub" python -m lunarhub "${HUB_ARGS[@]}" &
(cd "$ROOT/sim" && npx vite --port 5173 --strictPort) &
[[ $ANYHAND == 1 ]] && uv run --project "$ROOT/handpose" python -m lunarhand &

sleep 3
IP="$(hostname -I | awk '{print $1}')"
echo
echo "  Simulator (laptop):  https://localhost:5173/"
echo "  Hand tracker (iPhone Safari):  https://$IP:5173/tracker.html"
echo "  Hub health:  http://localhost:8000/api/health"
if [[ $ANYHAND == 1 ]]; then
  echo "  AnyHand tracker:  http://localhost:8001/anyhand/health (model takes ~20 s to load; then tap Engine on the phone)"
fi
if [[ ! -f "$ROOT/sim/certs/lan.pem" ]]; then
  echo "  Using a self-signed cert, so browsers will warn. Run scripts/certs.sh once for a trusted one."
fi
echo
wait
