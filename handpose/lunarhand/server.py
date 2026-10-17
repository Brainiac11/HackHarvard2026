"""Laptop hand-tracking server: the phone tracker streams JPEG frames, AnyHand (WiLoR) runs on the GPU, and the
landmarks go back to the phone, which forwards them to the hub exactly like its own MediaPipe results.

WebSocket /anyhand/ws   client -> server: binary [uint32 LE frame id][JPEG bytes]
                        server -> client: {"t": "anyhand.status", "ready", "detail"}
                                          {"t": "anyhand.result", "id", "ms", "w", "h", "hands": [...]}
REST      /anyhand/health

Only the newest frame is processed: if frames arrive faster than the GPU finishes them, older ones are skipped (a
result for id N tells the client every frame up to N is done).
"""

from __future__ import annotations

import asyncio
import importlib.util
import logging
import os
import struct
import sys
import threading
import time
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import Protocol

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from .frames import to_landmarks

log = logging.getLogger("lunarhand")
HEADER = struct.Struct("<I")


class Tracker(Protocol):
    def infer(self, jpeg: bytes) -> dict: ...


@contextmanager
def trusted_torch_load():
    """torch >= 2.6 defaults torch.load to weights_only=True, which rejects the pickled OmegaConf/ultralytics objects
    in the WiLoR checkpoint and detector. These are pinned upstream files we chose to trust; this is the same
    workaround AnyHand applies, extended to callers (Lightning) that pass weights_only=None explicitly."""
    import torch

    orig = torch.load

    def patched(*args, **kwargs):
        if kwargs.get("weights_only") is None:
            kwargs["weights_only"] = False
        return orig(*args, **kwargs)

    torch.load = patched
    try:
        yield
    finally:
        torch.load = orig


class AnyHandTracker:
    """Wraps AnyHand's own AnyHandPredictor (third_party/AnyHand/scripts/rgb_predictor.py), unmodified.

    hand: "any" | "left" | "right". Set it to the gloved hand so a bare hand in view is never tracked instead.
    max_hands: how many detections go through the 641M-parameter model (each one costs ~20 ms on a laptop GPU);
    the phone only uses the best one.
    """

    def __init__(self, root: Path, device: str = "cuda", det_conf: float = 0.3, fp16: bool = True,
                 hand: str = "any", max_hands: int = 1) -> None:
        import torch

        os.chdir(root)  # WiLoR resolves MANO as ./mano_data/ relative to the working directory
        spec = importlib.util.spec_from_file_location("anyhand_rgb_predictor", root / "scripts" / "rgb_predictor.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module  # its @dataclass looks itself up there
        spec.loader.exec_module(module)
        with trusted_torch_load():
            self.predictor = module.AnyHandPredictor(backend="wilor", device=device, det_conf=det_conf)
        self.torch = torch
        self.fp16 = fp16 and self.predictor.device.type == "cuda"
        self.device = str(self.predictor.device)
        self.hand, self.max_hands = hand, max_hands

    def predict_bgr(self, img: np.ndarray) -> list:
        """AnyHandPredictor.predict's two steps (YOLO detector, then WiLoR), with only the hands we use in step 2."""
        p = self.predictor
        with self.torch.inference_mode(), self.torch.autocast("cuda", dtype=self.torch.float16, enabled=self.fp16):
            boxes, is_right, scores = p._detect_hands(img)
            keep = np.argsort(-scores)
            if self.hand != "any":
                keep = keep[is_right[keep] == (self.hand == "right")]
            keep = keep[:self.max_hands]
            if not len(keep):
                return []
            return p._run_wilor(img, boxes[keep], is_right[keep], scores[keep])

    def infer(self, jpeg: bytes) -> dict:
        import cv2

        img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("frame is not a decodable image")
        h, w = img.shape[:2]
        return {"w": w, "h": h, "hands": [to_landmarks(p.keypoints_3d, p.cam_t, p.focal_length, w, h, p.is_right,
                                                       p.score) for p in self.predict_bgr(img)]}


class Service:
    def __init__(self, factory) -> None:
        self._factory = factory
        self.tracker: Tracker | None = None
        self.detail = "loading AnyHand model"
        self.gpu = asyncio.Lock()
        self.ms = 0.0

    def load(self) -> None:
        t0 = time.monotonic()
        try:
            self.tracker = self._factory()
            self.detail = f"ready ({time.monotonic() - t0:.0f}s to load)"
            log.info("AnyHand %s", self.detail)
        except Exception as exc:  # surfaced on /health and to the phone instead of crashing the server
            self.detail = f"failed to load: {exc}"
            log.exception("AnyHand failed to load")

    async def infer(self, jpeg: bytes) -> dict:
        async with self.gpu:
            t0 = time.perf_counter()
            result = await asyncio.to_thread(self.tracker.infer, jpeg)
            ms = (time.perf_counter() - t0) * 1000
        self.ms = ms if not self.ms else 0.9 * self.ms + 0.1 * ms
        return {**result, "ms": round(ms, 1)}


def create_app(factory) -> FastAPI:
    service = Service(factory)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        threading.Thread(target=service.load, name="anyhand-load", daemon=True).start()
        yield

    app = FastAPI(title="LunarHaptics AnyHand tracker", lifespan=lifespan)
    app.state.service = service

    @app.get("/anyhand/health")
    async def health():
        return {"ready": service.tracker is not None, "detail": service.detail, "avg_ms": round(service.ms, 1)}

    @app.websocket("/anyhand/ws")
    async def ws(sock: WebSocket):
        await sock.accept()
        while service.tracker is None:  # model still loading (or failed): tell the phone, keep the socket
            await sock.send_json({"t": "anyhand.status", "ready": False, "detail": service.detail})
            if service.detail.startswith("failed"):
                await sock.close(code=1011, reason=service.detail[:120])
                return
            await asyncio.sleep(1.0)
        await sock.send_json({"t": "anyhand.status", "ready": True, "detail": service.detail})

        latest: tuple[int, bytes] | None = None
        fresh = asyncio.Event()

        async def worker() -> None:
            nonlocal latest
            while True:
                await fresh.wait()
                fresh.clear()
                fid, jpeg = latest
                try:
                    result = await service.infer(jpeg)
                except Exception as exc:  # bad frame or CUDA hiccup: report it, keep serving
                    log.warning("frame %d failed: %s", fid, exc)
                    result = {"hands": [], "error": str(exc)[:200]}
                await sock.send_json({"t": "anyhand.result", "id": fid, **result})

        task = asyncio.get_running_loop().create_task(worker())
        try:
            while True:
                msg = await sock.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                data = msg.get("bytes")
                if data and len(data) > HEADER.size:
                    latest = (HEADER.unpack_from(data)[0], data[HEADER.size:])
                    fresh.set()
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            task.cancel()

    return app
