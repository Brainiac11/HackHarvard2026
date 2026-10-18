#!/usr/bin/env bash
# One-time setup for the laptop hand tracker (handpose/): AnyHand + WiLoR code, weights (~2.6 GB), MANO and the CUDA
# Python environment; with --hamer also HaMeR (github.com/geopavlakos/hamer) and its weights (~2.7 GB). Safe to
# re-run; interrupted downloads resume.
#   scripts/setup_anyhand.sh [--hamer [--hamer-weights original|anyhand]] [path/to/mano_v1_2.zip | MANO_RIGHT.pkl]
#
# --hamer-weights: original = geopavlakos' checkpoint (default); anyhand = AnyHand's fine-tune of it (same
# architecture). The tracker picks one at run time from HAMER_WEIGHTS in .env.
# MANO needs a free account: register at https://mano.is.tue.mpg.de, then download "Models & Code" (mano_v1_2.zip).
# Licences: AnyHand checkpoints and WiLoR code are CC-BY-NC-ND; HaMeR's code is MIT, but its weights are built on
# MANO, which has its own non-commercial licence. Everything goes into third_party/ (git-ignored), so none of it is
# ever committed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AH="$ROOT/third_party/AnyHand"
# Beside AnyHand, not in AnyHand/third_party/hamer where its predictor would look: handpose loads HaMeR itself
# (lunarhand/models.py), and HaMeR's own checkout keeps its downloads in the _DATA layout its docs describe.
HM="$ROOT/third_party/hamer"
HAMER_COMMIT=3a01849f4148352e9260b69bf28b65d1671a4905  # tested; only hamer.models and hamer.configs are imported

HAMER=0 HAMER_WEIGHTS=original MANO_SRC=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hamer) HAMER=1 ;;
    --hamer-weights) HAMER=1 HAMER_WEIGHTS="${2:?--hamer-weights takes original or anyhand}"; shift ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) MANO_SRC="$1" ;;
  esac
  shift
done
if [[ "$HAMER_WEIGHTS" != original && "$HAMER_WEIGHTS" != anyhand ]]; then
  echo "--hamer-weights is original or anyhand (a checkpoint of your own goes in HAMER_WEIGHTS in .env)" >&2
  exit 2
fi

if [[ ! -d "$AH/.git" ]]; then
  git clone https://github.com/chen-si-cs/AnyHand.git "$AH"
fi
git -C "$AH" submodule update --init WiLoR  # not AnyHand's HaMeR submodule: see HM above
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

if [[ $HAMER == 1 ]]; then
  # The pinned commit alone, without the ViTPose submodule: AnyHand's YOLO detector replaces HaMeR's ViTPose +
  # detectron2 front end, so mmcv is never installed.
  if [[ "$(git -C "$HM" rev-parse HEAD 2>/dev/null)" != "$HAMER_COMMIT" ]]; then
    git init -q "$HM"
    git -C "$HM" fetch -q --depth 1 https://github.com/geopavlakos/hamer.git "$HAMER_COMMIT"
    git -C "$HM" checkout -q FETCH_HEAD
  fi
  HAMER_HF="https://huggingface.co/spaces/geopavlakos/hamer/resolve/main/_DATA"
  mkdir -p "$HM/_DATA/hamer_ckpts/checkpoints" "$HM/_DATA/data"
  # the config serves AnyHand's fine-tune too: same architecture, and AnyHand's own copy is missing upstream
  fetch "$HAMER_HF/hamer_ckpts/model_config.yaml" "$HM/_DATA/hamer_ckpts/model_config.yaml"
  fetch "$HAMER_HF/data/mano_mean_params.npz" "$HM/_DATA/data/mano_mean_params.npz"
  if [[ $HAMER_WEIGHTS == original ]]; then
    fetch "$HAMER_HF/hamer_ckpts/checkpoints/hamer.ckpt" "$HM/_DATA/hamer_ckpts/checkpoints/hamer.ckpt"
  else
    fetch "$ANYHAND_HF/anyhand_hamer.ckpt" "$AH/pretrained_models/anyhand_hamer.ckpt"
  fi
fi

(cd "$ROOT/handpose" && uv sync --managed-python)

if [[ -n "$MANO_SRC" ]]; then
  python3 - "$MANO_SRC" "$AH/mano_data/MANO_RIGHT.pkl" <<'EOF'
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
  echo "  scripts/setup_anyhand.sh $([[ $HAMER == 1 ]] && echo "--hamer --hamer-weights $HAMER_WEIGHTS ")~/Downloads/mano_v1_2.zip"
  exit 1
fi
uv run --project "$ROOT/handpose" python -m lunarhand.mano "$AH/mano_data/MANO_RIGHT.pkl"  # strip chumpy

echo
echo "Self-test on AnyHand's demo image:"
uv run --project "$ROOT/handpose" python -m lunarhand --model wilor --selftest "$AH/assets/demo_img.jpg" --repeat 10
if [[ $HAMER == 1 ]]; then
  uv run --project "$ROOT/handpose" python -m lunarhand --model hamer --hamer-weights "$HAMER_WEIGHTS" \
    --selftest "$AH/assets/demo_img.jpg" --repeat 10
fi
echo
if [[ $HAMER == 1 && $HAMER_WEIGHTS != original ]]; then
  echo "Set HAMER_WEIGHTS=$HAMER_WEIGHTS in .env so the tracker loads that checkpoint."
fi
echo "Ready. Run scripts/dev.sh --anyhand$([[ $HAMER == 1 ]] && echo " (or --hamer)"), then tap Engine on the phone tracker."
