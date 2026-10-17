"""CLI entry point.

    uv run --project hub python -m lunarhub --glove null --nfc auto
    uv run --project hub python -m lunarhub --glove ble --nfc pcsc --assistant chalk
    uv run --project hub python -m lunarhub --glove serial:/dev/ttyUSB0 --log-telemetry
"""

from __future__ import annotations

import argparse
import logging
import os
from pathlib import Path

import uvicorn
from dotenv import load_dotenv

from .app import Settings, create_app

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    # .env wins over the shell: VS Code (python.terminal.useEnvFile) injects a snapshot of .env into each new
    # terminal, which would otherwise shadow keys added to .env after the terminal was opened.
    load_dotenv(ROOT / ".env", override=True)
    ap = argparse.ArgumentParser(prog="lunarhub", description="LunarHaptics hub")
    ap.add_argument("--glove", default=os.getenv("GLOVE_TRANSPORT", "null"),
                    help="null | ble | ble:<name> | serial:<port>")
    ap.add_argument("--nfc", default=os.getenv("NFC_BACKEND", "auto"),
                    help="auto | pcsc | hid[:/dev/input/by-id/...] | serial:<port> | none")
    ap.add_argument("--assistant", default=os.getenv("ASSISTANT_BACKEND", "local"), choices=["local", "chalk"])
    ap.add_argument("--variant", default=os.getenv("ASSISTANT_VARIANT", "v2+guard"))
    ap.add_argument("--terrain", default="site04")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--log-telemetry", action="store_true", help="record sim.state to data/sessions/ for tuning/evals")
    ap.add_argument("--no-patches", action="store_true", help="skip Grok Imagine patch pre-generation")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname).1s %(name)s: %(message)s", datefmt="%H:%M:%S")
    settings = Settings(
        root=ROOT, glove=args.glove, nfc=args.nfc, terrain_site=args.terrain, assistant=args.assistant,
        variant=args.variant, xai_api_key=os.getenv("XAI_API_KEY", ""),
        imagine_model=os.getenv("IMAGINE_MODEL", "grok-imagine-image"),
        voice_model=os.getenv("VOICE_MODEL", "grok-voice-latest"), voice_name=os.getenv("VOICE_NAME", "eve"),
        seed=args.seed, log_telemetry=args.log_telemetry, pregenerate_patches=not args.no_patches,
    )
    uvicorn.run(create_app(settings), host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
