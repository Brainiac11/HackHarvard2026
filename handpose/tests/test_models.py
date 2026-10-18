import copy
from pathlib import Path

import pytest

from lunarhand.__main__ import parse_args
from lunarhand.models import hamer_config, hamer_files, require

# the parts of HaMeR's _DATA/hamer_ckpts/model_config.yaml that matter here, as downloaded
RAW = {
    "MANO": {"DATA_DIR": "_DATA/data/", "MODEL_PATH": "_DATA/data/mano", "GENDER": "neutral", "NUM_HAND_JOINTS": 15,
             "MEAN_PARAMS": "_DATA/data/mano_mean_params.npz", "CREATE_BODY_POSE": False},
    "EXTRA": {"FOCAL_LENGTH": 5000},
    "MODEL": {"IMAGE_SIZE": 256, "BACKBONE": {"TYPE": "vit", "PRETRAINED_WEIGHTS": "hamer_training_data/vitpose.pth"},
              "MANO_HEAD": {"TYPE": "transformer_decoder"}},
}


def test_hamer_config_points_mano_at_anyhand_and_crops_like_hamers_loader():
    raw = copy.deepcopy(RAW)
    cfg = hamer_config(raw, Path("/a/mano_data"), Path("/h/_DATA/data/mano_mean_params.npz"))
    assert cfg["MANO"]["MODEL_PATH"] == "/a/mano_data"
    assert cfg["MANO"]["MEAN_PARAMS"] == "/h/_DATA/data/mano_mean_params.npz"
    assert cfg["MANO"]["NUM_HAND_JOINTS"] == 15 and cfg["EXTRA"] == RAW["EXTRA"]
    assert "PRETRAINED_WEIGHTS" not in cfg["MODEL"]["BACKBONE"] and cfg["MODEL"]["BBOX_SHAPE"] == [192, 256]
    assert raw == RAW  # the loaded file is left alone


def test_hamer_config_keeps_a_crop_shape_the_file_already_has():
    raw = copy.deepcopy(RAW)
    raw["MODEL"]["BBOX_SHAPE"] = [256, 256]
    assert hamer_config(raw, Path("m"), Path("p"))["MODEL"]["BBOX_SHAPE"] == [256, 256]


def test_hamer_files(tmp_path):
    hamer, anyhand = tmp_path / "hamer", tmp_path / "AnyHand"
    config = hamer / "_DATA" / "hamer_ckpts" / "model_config.yaml"
    assert hamer_files("original", hamer, anyhand) == (config.parent / "checkpoints" / "hamer.ckpt", config)
    assert hamer_files("anyhand", hamer, anyhand) == (anyhand / "pretrained_models" / "anyhand_hamer.ckpt", config)
    own = tmp_path / "mine" / "model_config.yaml"  # HaMeR's layout: the config one level above checkpoints/
    own.parent.mkdir()
    own.touch()
    ckpt = str(own.parent / "checkpoints" / "last.ckpt")
    assert hamer_files(ckpt, hamer, anyhand) == (Path(ckpt), own)
    assert hamer_files(str(tmp_path / "x.ckpt"), hamer, anyhand) == (tmp_path / "x.ckpt", config)


def test_require_names_the_setup_step(tmp_path):
    present = tmp_path / "a.ckpt"
    present.touch()
    require("wilor", [present])
    with pytest.raises(FileNotFoundError, match=r"b\.ckpt missing: run scripts/setup_anyhand.sh --hamer"):
        require("hamer", [present, tmp_path / "b.ckpt"])


@pytest.fixture
def env(monkeypatch):
    for name in ("HAND_MODEL", "HAMER_WEIGHTS", "GLOVE_HAND"):
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


def test_cli_defaults(env):
    args = parse_args([])
    assert args.model == "wilor" and args.hamer_weights == "original" and not args.keep_models
    assert args.root.is_absolute() and args.hamer_root.name == "hamer"


def test_cli_model_from_env_and_flags(env):
    env.setenv("HAND_MODEL", "hamer")
    env.setenv("HAMER_WEIGHTS", "anyhand")
    args = parse_args([])
    assert (args.model, args.hamer_weights) == ("hamer", "anyhand")
    args = parse_args(["--model", "wilor", "--hamer-weights", "original", "--keep-models"])
    assert (args.model, args.hamer_weights, args.keep_models) == ("wilor", "original", True)


def test_cli_rejects_unknown_models(env):
    with pytest.raises(SystemExit):
        parse_args(["--model", "mediapipe"])
    env.setenv("HAND_MODEL", "anyhand")
    with pytest.raises(SystemExit):
        parse_args([])


def test_cli_resolves_a_checkpoint_path_before_the_tracker_changes_directory(env, tmp_path):
    env.chdir(tmp_path)
    assert parse_args(["--hamer-weights", "ckpts/mine.ckpt"]).hamer_weights == str(tmp_path / "ckpts" / "mine.ckpt")
