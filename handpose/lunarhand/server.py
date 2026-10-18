"""Laptop hand-tracking server: the phone tracker streams JPEG frames, a hand model runs on the GPU, and the
landmarks go back to the phone, which forwards them to the hub exactly like its own MediaPipe results.

Two models behind the same YOLO hand detector (models.py): AnyHand's WiLoR and HaMeR. The phone picks one; the
server loads it in the background, by default freeing the other first (two ViT-H models crowd an 8 GB laptop GPU).
There is one GPU, so the model is the same for every client.

WebSocket /anyhand/ws?model=wilor|hamer   the query asks for a model on connect, without a stale status first
  client -> server: binary [uint32 LE frame id][JPEG bytes]
                    {"t": "anyhand.model", "model": "wilor" | "hamer"}
  server -> client: {"t": "anyhand.status", "ready", "detail", "model"}   on connect and on every change
                    {"t": "anyhand.result", "id", "ms", "w", "h", "model", "hands": [...]}
REST      /anyhand/health

Only the newest frame is processed: if frames arrive faster than the GPU finishes them, older ones are skipped (a
result for id N tells the client every frame up to N is done). Frames that arrive while no model is ready are
dropped; the "ready" status that ends a switch tells the client that nothing of its is in flight any more.
"""

from __future__ import annotations

import asyncio
import gc
import importlib.util
import json
import logging
import os
import struct
import sys
import time
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import Callable, Protocol

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from .frames import to_landmarks
from .models import MODELS, NAMES, hamer_mean_params, load_hamer, require

log = logging.getLogger("lunarhand")
HEADER = struct.Struct("<I")


class Tracker(Protocol):
    def check(self, model: str) -> None: ...  # raises if the model's files are missing
    def load(self, model: str) -> None: ...
    def unload(self, model: str) -> None: ...
    def infer(self, jpeg: bytes, model: str) -> dict: ...


@contextmanager
def trusted_torch_load():
    """torch >= 2.6 defaults torch.load to weights_only=True, which rejects the pickled OmegaConf/yacs/ultralytics
    objects in the WiLoR and HaMeR checkpoints and the detector. These are pinned upstream files we chose to trust;
    this is the same workaround AnyHand applies, extended to callers (Lightning) that pass weights_only=None.

    Everything also loads to the CPU, and each loader then moves its model to the GPU. Left to Lightning, WiLoR's
    weights are restored straight onto the GPU: a second 2.5 GB copy there while the model is built, which the
    allocator then keeps (5.4 GB of VRAM for WiLoR instead of 2.8)."""
    import torch

    orig = torch.load

    def patched(*args, **kwargs):
        if kwargs.get("weights_only") is None:
            kwargs["weights_only"] = False
        kwargs["map_location"] = "cpu"
        return orig(*args, **kwargs)

    torch.load = patched
    try:
        yield
    finally:
        torch.load = orig


def predictor_class(root: Path, hamer: tuple[Path, Path], hamer_root: Path) -> type:
    """AnyHand's AnyHandPredictor (third_party/AnyHand/scripts/rgb_predictor.py, unmodified), with HaMeR loaded from
    geopavlakos/hamer (models.load_hamer) instead of from files AnyHand expects to be edited by hand."""
    import torch

    spec = importlib.util.spec_from_file_location("anyhand_rgb_predictor", root / "scripts" / "rgb_predictor.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # its @dataclass looks itself up there
    spec.loader.exec_module(module)

    class Predictor(module.AnyHandPredictor):
        def _load_hamer(self) -> None:
            model, self._hamer_model_cfg = load_hamer(*hamer, hamer_root, root / "mano_data")
            self._hamer_model = model.to(self.device).eval()

        def _run_hamer(self, img_bgr, boxes, is_right, scores):
            # AnyHand's version crops with HaMeR's ViTDetDataset, which prints on every crop and whose package needs
            # training-only dependencies (webdataset). WiLoR forked that class; its copy is otherwise identical.
            module._ensure_on_path(root / "WiLoR", "run scripts/setup_anyhand.sh")
            from wilor.datasets.vitdet_dataset import ViTDetDataset

            cfg = self._hamer_model_cfg
            h, w = img_bgr.shape[:2]
            crops = ViTDetDataset(cfg, img_bgr, boxes, is_right, rescale_factor=self.rescale_factor)
            return self._collect_predictions(
                torch.utils.data.DataLoader(crops, batch_size=self.batch_size), self._hamer_model, boxes, is_right,
                scores, torch.tensor([w, h], dtype=torch.float32, device=self.device),
                float(cfg.EXTRA.FOCAL_LENGTH / cfg.MODEL.IMAGE_SIZE * max(w, h)), backend="hamer")

    return Predictor


class AnyHandTracker:
    """The YOLO hand detector and the hand models it feeds, which share AnyHand's output path.

    hand: "any" | "left" | "right". Set it to the gloved hand so a bare hand in view is never tracked instead.
    max_hands: how many detections go through the model (each one costs ~20 ms on a laptop GPU); the phone only
    uses the best one.
    """

    def __init__(self, root: Path, model: str, hamer: tuple[Path, Path], hamer_root: Path, device: str = "cuda",
                 det_conf: float = 0.3, fp16: bool = True, hand: str = "any", max_hands: int = 1) -> None:
        import torch

        weights = root / "pretrained_models"
        wilor = (weights / "anyhand_wilor.ckpt", weights / "model_config_wilor.yaml")
        self.files = {"wilor": wilor,
                      "hamer": (hamer_root / "hamer" / "__init__.py", *hamer, hamer_mean_params(hamer_root))}
        self.check(model)
        os.chdir(root)  # WiLoR resolves MANO as ./mano_data/ relative to the working directory
        with trusted_torch_load():
            self.predictor = predictor_class(root, hamer, hamer_root)(
                backend=model, device=device, det_conf=det_conf, wilor_ckpt=str(wilor[0]), wilor_cfg=str(wilor[1]))
        self.torch = torch
        self.fp16 = fp16 and self.predictor.device.type == "cuda"
        self.device = str(self.predictor.device)
        self.hand, self.max_hands = hand, max_hands

    def check(self, model: str) -> None:
        require(model, self.files[model])

    def load(self, model: str) -> None:
        self.check(model)
        with trusted_torch_load():
            getattr(self.predictor, f"_load_{model}")()

    def unload(self, model: str) -> None:
        setattr(self.predictor, f"_{model}_model", None)
        setattr(self.predictor, f"_{model}_model_cfg", None)
        gc.collect()  # Lightning modules hold reference cycles
        self.torch.cuda.empty_cache()

    def predict_bgr(self, img: np.ndarray, model: str) -> list:
        """AnyHandPredictor.predict's two steps (YOLO detector, then `model`), with only the hands we use in step 2."""
        p = self.predictor
        with self.torch.inference_mode(), self.torch.autocast("cuda", dtype=self.torch.float16, enabled=self.fp16):
            boxes, is_right, scores = p._detect_hands(img)
            keep = np.argsort(-scores)
            if self.hand != "any":
                keep = keep[is_right[keep] == (self.hand == "right")]
            keep = keep[:self.max_hands]
            if not len(keep):
                return []
            return getattr(p, f"_run_{model}")(img, boxes[keep], is_right[keep], scores[keep])

    def infer(self, jpeg: bytes, model: str) -> dict:
        import cv2

        img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("frame is not a decodable image")
        h, w = img.shape[:2]
        return {"w": w, "h": h, "hands": [to_landmarks(p.keypoints_3d, p.cam_t, p.focal_length, w, h, p.is_right,
                                                       p.score) for p in self.predict_bgr(img, model)]}


class Service:
    """Which model serves frames, and switching between them. Loads run one at a time in a worker thread, and no
    frame reaches a model that is loading or being freed: `model` is None from the moment a switch starts."""

    def __init__(self, factory: Callable[[str], Tracker], keep_models: bool = False) -> None:
        self._factory = factory  # builds the tracker with its first model loaded
        self.keep_models = keep_models
        self.tracker: Tracker | None = None
        self.model: str | None = None  # serving frames
        self.loading: str | None = None  # being loaded (or freed to make room for it)
        self.wanted: str | None = None
        self.loaded: set[str] = set()
        self.detail = "starting"
        self.gpu = asyncio.Lock()
        self.ms = 0.0
        self.listeners: set[Callable[[], None]] = set()  # told about every status change
        self._switching: asyncio.Task | None = None  # a reference keeps the running switch alive

    def status(self) -> dict:
        return {"t": "anyhand.status", "ready": self.model is not None, "detail": self.detail,
                "model": self.model or self.loading or self.wanted}

    def request(self, model: str) -> None:
        """Serve `model`. A load in progress finishes first; then the latest request wins."""
        self.wanted = model
        if self.loading is None and model != self.model:
            serving = self.model
            self._announce(model)  # now, so a status sent before the task runs already says so
            self._switching = asyncio.get_running_loop().create_task(self._switch(serving))

    def _announce(self, target: str) -> None:
        if (self.model, self.loading) != (None, target):
            self.model, self.loading, self.detail = None, target, f"loading {NAMES[target]}…"
            self._notify()

    def _notify(self) -> None:
        for listener in list(self.listeners):
            listener()

    async def _switch(self, fallback: str | None) -> None:
        errors: list[str] = []
        while (target := self.wanted) is not None and target != self.model:
            self._announce(target)
            t0 = time.monotonic()
            try:
                loaded = await self._load(target)
            except Exception as exc:  # reported to the phone; the model that was serving comes back
                errors.append(f"{NAMES[target]} failed to load: {exc}")
                log.error("%s", errors[-1], exc_info=not isinstance(exc, FileNotFoundError))
                if self.wanted == target:
                    self.wanted, fallback = fallback, None  # one way back: if that fails too, stop
            else:
                self.model, self.loading, fallback = target, None, target
                self.ms = 0.0
                ready = f"{NAMES[target]} ready" + (f" ({time.monotonic() - t0:.0f}s to load)" if loaded else "")
                self.detail = "; ".join([ready, *errors])
                errors = []
                log.info("%s", self.detail)
                continue
            # out here the exception's traceback no longer pins a half-loaded model, so freeing it works
            if self.tracker is not None:
                await asyncio.to_thread(self.tracker.unload, target)
        self.loading = None
        if self.model is None:
            self.detail = "; ".join(errors)
        self._notify()

    async def _load(self, target: str) -> bool:
        """Make `target` the loaded model; False if it already was (kept by --keep-models, or a failed switch)."""
        async with self.gpu:  # the frame in flight finishes; the ones after it see model None and are dropped
            pass
        if self.tracker is None:
            self.tracker = await asyncio.to_thread(self._factory, target)
            self.loaded = {target}
            return True
        self.tracker.check(target)  # a model that isn't installed fails here, before the working one is freed
        for other in [] if self.keep_models else sorted(self.loaded - {target}):
            await asyncio.to_thread(self.tracker.unload, other)
            self.loaded.discard(other)
        if target in self.loaded:
            return False
        await asyncio.to_thread(self.tracker.load, target)
        self.loaded.add(target)
        return True

    async def infer(self, jpeg: bytes) -> dict | None:
        """The landmarks, or None if no model is ready (the frame is dropped)."""
        async with self.gpu:
            if (model := self.model) is None:
                return None
            t0 = time.perf_counter()
            result = await asyncio.to_thread(self.tracker.infer, jpeg, model)
            ms = (time.perf_counter() - t0) * 1000
        self.ms = ms if not self.ms else 0.9 * self.ms + 0.1 * ms
        return {**result, "model": model, "ms": round(ms, 1)}


def create_app(factory: Callable[[str], Tracker], model: str = "wilor", keep_models: bool = False) -> FastAPI:
    service = Service(factory, keep_models)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        service.request(model)
        yield

    app = FastAPI(title="LunarHaptics laptop hand tracker", lifespan=lifespan)
    app.state.service = service

    @app.get("/anyhand/health")
    async def health():
        return {"ready": service.model is not None, "model": service.model, "loading": service.loading,
                "models": list(MODELS), "loaded": sorted(service.loaded), "keep_models": service.keep_models,
                "detail": service.detail, "avg_ms": round(service.ms, 1)}

    @app.websocket("/anyhand/ws")
    async def ws(sock: WebSocket):
        await sock.accept()
        if (asked := sock.query_params.get("model")) in MODELS:
            service.request(asked)

        latest: tuple[int, bytes] | None = None
        status_due = True
        wake = asyncio.Event()
        wake.set()

        def on_status() -> None:
            nonlocal status_due
            status_due = True
            wake.set()

        async def sender() -> None:  # the only writer, so statuses and results arrive in the order they happened
            nonlocal latest, status_due
            while True:
                await wake.wait()
                wake.clear()
                if status_due:
                    status_due = False
                    await sock.send_json(service.status())  # current when sent, never a stale snapshot
                if latest is None:
                    continue
                (fid, jpeg), latest = latest, None
                try:
                    result = await service.infer(jpeg)
                except Exception as exc:  # bad frame or CUDA hiccup: report it, keep serving
                    log.warning("frame %d failed: %s", fid, exc)
                    result = {"hands": [], "error": str(exc)[:200], "model": service.model or service.wanted}
                if result is not None:
                    await sock.send_json({"t": "anyhand.result", "id": fid, **result})

        service.listeners.add(on_status)
        task = asyncio.get_running_loop().create_task(sender())
        try:
            while True:
                msg = await sock.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                if data := msg.get("bytes"):
                    if len(data) > HEADER.size:
                        latest = (HEADER.unpack_from(data)[0], data[HEADER.size:])
                        wake.set()
                elif text := msg.get("text"):
                    try:
                        req = json.loads(text)
                    except ValueError:
                        continue
                    if isinstance(req, dict) and req.get("t") == "anyhand.model" and req.get("model") in MODELS:
                        service.request(req["model"])
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            service.listeners.discard(on_status)
            task.cancel()

    return app
