#!/usr/bin/env bash
# One-time setup for the AnyHand laptop hand tracker (handpose/): AnyHand + WiLoR code, weights (~2.6 GB), MANO and
# the CUDA Python environment. Safe to re-run; interrupted downloads resume.
#   scripts/setup_anyhand.sh [path/to/mano_v1_2.zip | path/to/MANO_RIGHT.pkl]
#
# MANO needs a free account: register at https://mano.is.tue.mpg.de, then download "Models & Code" (mano_v1_2.zip).
# Licences: AnyHand checkpoints and WiLoR code are CC-BY-NC-ND; MANO has its own non-commercial licence. Everything
# goes into third_party/ (git-ignored), so none of it is ever committed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AH="$ROOT/third_party/AnyHand"

if [[ ! -d "$AH/.git" ]]; then
  git clone https://github.com/chen-si-cs/AnyHand.git "$AH"
fi
git -C "$AH" submodule update --init WiLoR  # HaMeR is not used (too slow for real time)
mkdir -p "$AH/pretrained_models" "$AH/mano_data"

fetch() {  # url dest: resumable, and a half-finished file never looks complete
  [[ -f "$2" ]] && return 0
  echo "Downloading $(basename "$2")..."
  curl -fL --progress-bar -C - -o "$2.part" "$1"
  mv "$2.part" "$2"
}
WILOR_HF="https://huggingface.co/spaces/rolpotamias/WiLoR/resolve/main/pretrained_models"
ANYHAND_HF="https://huggingface.co/chen-si-02/AnyHand-Models/resolve/main"
fetch "$WILOR_HF/detector.pt" "$AH/pretrained_models/detector.pt"
fetch "$ANYHAND_HF/model_config_wilor.yaml" "$AH/pretrained_models/model_config_wilor.yaml"
fetch "$ANYHAND_HF/anyhand_wilor.ckpt" "$AH/pretrained_models/anyhand_wilor.ckpt"
cp -n "$AH/scripts/mano_assets/mano_mean_params.npz" "$AH/mano_data/" 2>/dev/null || true

(cd "$ROOT/handpose" && uv sync --managed-python)

if [[ -n "${1:-}" ]]; then
  python3 - "$1" "$AH/mano_data/MANO_RIGHT.pkl" <<'EOF'
import shutil, sys, zipfile
src, dst = sys.argv[1:]
if zipfile.is_zipfile(src):
    with zipfile.ZipFile(src) as z:
        name = next(n for n in z.namelist() if n.endswith("models/MANO_RIGHT.pkl"))
        with z.open(name) as f, open(dst, "wb") as out:
            shutil.copyfileobj(f, out)
else:
    shutil.copyfile(src, dst)
print(f"MANO_RIGHT.pkl -> {dst}")
EOF
fi
if [[ ! -f "$AH/mano_data/MANO_RIGHT.pkl" ]]; then
  echo
  echo "Almost done: MANO is missing. Register at https://mano.is.tue.mpg.de, download mano_v1_2.zip, then run:"
  echo "  scripts/setup_anyhand.sh ~/Downloads/mano_v1_2.zip"
  exit 1
fi
uv run --project "$ROOT/handpose" python -m lunarhand.mano "$AH/mano_data/MANO_RIGHT.pkl"  # strip chumpy

echo
echo "Self-test on AnyHand's demo image:"
uv run --project "$ROOT/handpose" python -m lunarhand --selftest "$AH/assets/demo_img.jpg" --repeat 10
echo
echo "Ready. Run scripts/dev.sh --anyhand, then tap 'Engine: laptop' on the phone tracker."
