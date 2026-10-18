"""CLI entry point.

    uv run --project handpose python -m lunarhand                       # server on 127.0.0.1:8001 (Vite proxies /anyhand)
    uv run --project handpose python -m lunarhand --model hamer         # start on HaMeR (the phone can switch)
    uv run --project handpose python -m lunarhand --selftest IMAGE      # one-off check: detections + timing
"""

from __future__ import annotations

import argparse
import logging
import os
import time
from pathlib import Path

from dotenv import load_dotenv

from .models import HAMER_WEIGHTS, MODELS, NAMES, hamer_files

ROOT = Path(__file__).resolve().parents[2]
ANYHAND = ROOT / "third_party" / "AnyHand"
HAMER = ROOT / "third_party" / "hamer"


def make_tracker(args, model: str):
    from .server import AnyHandTracker

    return AnyHandTracker(args.root, model, hamer_files(args.hamer_weights, args.hamer_root, args.root),
                          args.hamer_root, args.device, args.det_conf, fp16=not args.no_fp16, hand=args.hand,
                          max_hands=args.max_hands)


def selftest(args) -> None:
    import cv2

    image = Path(args.selftest).resolve()
    img = cv2.imread(str(image))
    if img is None:
        raise SystemExit(f"cannot read {image}")
    t0 = time.monotonic()
    tracker = make_tracker(args, args.model)
    print(f"{NAMES[args.model]} loaded on {tracker.device} in {time.monotonic() - t0:.1f}s (fp16={tracker.fp16})")
    ok, jpeg = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 80])
    times = []
    for _ in range(args.repeat):
        t = time.perf_counter()
        result = tracker.infer(jpeg.tobytes(), args.model)
        times.append((time.perf_counter() - t) * 1000)
    for hand in result["hands"]:
        print(f"  {hand['hand']:5s} score {hand['score']:.2f}  wrist {hand['lm'][0][:2]}  "
              f"middle-MCP to wrist {sum((a - b) ** 2 for a, b in zip(hand['wlm'][9], hand['wlm'][0])) ** 0.5:.3f} m")
    warm = sorted(times[1:]) or times
    print(f"{len(result['hands'])} hand(s) in {image.name} ({result['w']}x{result['h']}); "
          f"first {times[0]:.0f} ms, median warm {warm[len(warm) // 2]:.0f} ms")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="lunarhand", description="LunarHaptics laptop GPU hand tracker (WiLoR, HaMeR)")
    ap.add_argument("--root", type=Path, default=ANYHAND, help="AnyHand checkout (scripts/setup_anyhand.sh)")
    ap.add_argument("--model", default=os.getenv("HAND_MODEL") or "wilor", choices=MODELS,
                    help="model to load first (the phone can switch); default HAND_MODEL from .env, else wilor")
    ap.add_argument("--hamer-weights", default=os.getenv("HAMER_WEIGHTS") or "original",
                    metavar="{original,anyhand,CKPT}",
                    help="HaMeR checkpoint: geopavlakos' original, AnyHand's fine-tune of it, or a path; default "
                         "HAMER_WEIGHTS from .env, else original")
    ap.add_argument("--hamer-root", type=Path, default=HAMER, help="HaMeR checkout (scripts/setup_anyhand.sh --hamer)")
    ap.add_argument("--keep-models", action="store_true",
                    help="keep both models on the GPU once loaded, so switching back is instant (needs more VRAM)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8001)
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--det-conf", type=float, default=0.3, help="hand detector confidence (lower helps gloves)")
    ap.add_argument("--hand", default=os.getenv("GLOVE_HAND", "any"), choices=["any", "left", "right"],
                    help="track only this hand (the gloved one); default GLOVE_HAND from .env")
    ap.add_argument("--max-hands", type=int, default=1, help="detections run through the model per frame")
    ap.add_argument("--no-fp16", action="store_true", help="run the model in fp32 (about 3x slower)")
    ap.add_argument("--selftest", metavar="IMAGE", help="run on one image, print detections and timing, exit")
    ap.add_argument("--repeat", type=int, default=20, help="selftest iterations")
    args = ap.parse_args(argv)
    if args.model not in MODELS:  # argparse checks choices on the command line only, not a HAND_MODEL default
        ap.error(f"HAND_MODEL must be one of {', '.join(MODELS)}, not {args.model!r}")
    if args.hamer_weights not in HAMER_WEIGHTS:  # a path: resolve it now, the tracker changes directory
        args.hamer_weights = str(Path(args.hamer_weights).expanduser().resolve())
    args.root, args.hamer_root = args.root.resolve(), args.hamer_root.resolve()
    return args


def main() -> None:
    load_dotenv(ROOT / ".env", override=True)  # same project config as the hub
    args = parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname).1s %(name)s: %(message)s",
                        datefmt="%H:%M:%S")
    if not (args.root / "mano_data" / "MANO_RIGHT.pkl").exists():
        raise SystemExit(f"MANO_RIGHT.pkl missing in {args.root / 'mano_data'}: run scripts/setup_anyhand.sh")
    os.environ.setdefault("PYOPENGL_PLATFORM", "egl")  # WiLoR and HaMeR import pyrender; no window is ever opened
    os.environ.setdefault("YOLO_AUTOINSTALL", "false")  # never let ultralytics pip-install into the env
    if args.selftest:
        selftest(args)
        return

    import uvicorn

    from .server import create_app

    app = create_app(lambda model: make_tracker(args, model), args.model, args.keep_models)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
