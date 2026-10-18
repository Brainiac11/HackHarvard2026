"""The laptop hand models, where their files live, and how HaMeR is loaded.

    wilor  AnyHand's fine-tuned WiLoR (third_party/AnyHand), loaded by AnyHand's own predictor
    hamer  HaMeR, ViT-H (github.com/geopavlakos/hamer, third_party/hamer): the original checkpoint, or AnyHand's
           fine-tune of it (same architecture)

Both regress MANO from the same YOLO hand crops, so they return the same 21 joints in the same order. The paths and
the config fix-up are pure (unit-tested); load_hamer needs the HaMeR checkout and torch.
"""

from __future__ import annotations

import copy
from pathlib import Path

NAMES = {"wilor": "WiLoR", "hamer": "HaMeR"}
MODELS = tuple(NAMES)
HAMER_WEIGHTS = ("original", "anyhand")
SETUP = {"wilor": "scripts/setup_anyhand.sh", "hamer": "scripts/setup_anyhand.sh --hamer"}


def require(model: str, paths) -> None:
    """Raise FileNotFoundError for the first missing file, naming the setup command that provides it."""
    for path in paths:
        if not Path(path).is_file():
            raise FileNotFoundError(f"{path} missing: run {SETUP[model]}")


def hamer_files(weights: str, hamer_root: Path, anyhand_root: Path) -> tuple[Path, Path]:
    """(checkpoint, model_config.yaml) for --hamer-weights original | anyhand | path/to/checkpoint.ckpt.

    A checkpoint in HaMeR's own layout (<dir>/checkpoints/x.ckpt) brings its config one level up; AnyHand's fine-tune
    ships none (its model_config_hamer.yaml is missing upstream), so it gets the original's.
    """
    ckpt = {
        "original": hamer_root / "_DATA" / "hamer_ckpts" / "checkpoints" / "hamer.ckpt",
        "anyhand": anyhand_root / "pretrained_models" / "anyhand_hamer.ckpt",
    }.get(weights, Path(weights))
    own = ckpt.parent.parent / "model_config.yaml"
    return ckpt, own if own.is_file() else hamer_root / "_DATA" / "hamer_ckpts" / "model_config.yaml"


def hamer_mean_params(hamer_root: Path) -> Path:
    """The MANO head's initial pose, shape and camera (from HaMeR's demo data, next to its checkpoints)."""
    return hamer_root / "_DATA" / "data" / "mano_mean_params.npz"


def hamer_config(raw: dict, mano_dir: Path, mean_params: Path) -> dict:
    """HaMeR's model_config.yaml made loadable here: what hamer.models.load_hamer does to it, without touching the
    downloaded file, and with MANO taken from AnyHand's mano_data (shared with WiLoR) instead of HaMeR's ./_DATA."""
    cfg = copy.deepcopy(raw)
    cfg["MANO"].update(DATA_DIR=str(mean_params.parent), MODEL_PATH=str(mano_dir), MEAN_PARAMS=str(mean_params))
    model = cfg["MODEL"]
    model["BACKBONE"].pop("PRETRAINED_WEIGHTS", None)  # ViTPose init for training; the checkpoint overwrites it
    if model["BACKBONE"]["TYPE"] == "vit":
        model.setdefault("BBOX_SHAPE", [192, 256])  # the ViT sees a 192x256 crop: widen boxes to that aspect
    return cfg


def load_hamer(ckpt: Path, config: Path, hamer_root: Path, mano_dir: Path):
    """(model, cfg) on the CPU. Imports only hamer.models and hamer.configs, which need nothing beyond WiLoR's
    dependencies: mmcv, ViTPose and detectron2 are for HaMeR's demo hand detector, which AnyHand's YOLO replaces."""
    import sys

    import yaml
    from yacs.config import CfgNode

    if str(hamer_root) not in sys.path:
        sys.path.insert(0, str(hamer_root))
    from hamer.configs import default_config
    from hamer.models.hamer import HAMER

    cfg = default_config()  # the same defaults hamer.configs.get_config merges the file into
    cfg.merge_from_other_cfg(CfgNode(hamer_config(yaml.safe_load(config.read_text()), mano_dir,
                                                  hamer_mean_params(hamer_root))))
    cfg.freeze()
    # strict=False like HaMeR's own loader: the checkpoint has no entries for the (unused) loss modules
    model = HAMER.load_from_checkpoint(str(ckpt), strict=False, cfg=cfg, init_renderer=False, map_location="cpu")
    return model, cfg
