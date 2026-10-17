#!/usr/bin/env bash
# One-time Linux setup for the ACR122U (or any PC/SC) NFC reader (PLAN.md §6.1). Needs sudo.
#   scripts/setup_nfc.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

sudo apt-get install -y pcscd libccid pcsc-tools

# The kernel NFC stack (pn533_usb) claims the ACR122U before pcscd can see it: unload it now and keep it off.
printf "blacklist pn533_usb\nblacklist pn533\nblacklist nfc\n" | sudo tee /etc/modprobe.d/blacklist-nfc.conf >/dev/null
sudo modprobe -r pn533_usb pn533 nfc 2>/dev/null || true
sudo systemctl restart pcscd.service  # rescan USB now that the reader is free

(cd "$ROOT/hub" && uv sync --extra nfc)

if uv run --project "$ROOT/hub" python -c "
from smartcard.System import readers
r = readers()
print('PC/SC readers:', [str(x) for x in r])
raise SystemExit(0 if r else 1)"; then
  echo
  echo "Reader ready. Run scripts/dev.sh, tap a tag, then press N (or Shift+N) in the sim to enroll it."
else
  echo "No PC/SC reader visible yet. Unplug and replug the reader, then check with: pcsc_scan" >&2
  exit 1
fi
