import json
import struct
import threading

import numpy as np
from fastapi.testclient import TestClient

from lunarhand.server import AnyHandTracker, create_app


class FakeTracker:
    """Stands in for AnyHandTracker. Loads and unloads go to `calls` (the factory's first load included); models in
    `broken` raise while loading, models in `missing` fail the file check, `failing` ones raise on every frame; the
    gates hold up loads or inference."""

    def __init__(self, model, calls, broken=(), missing=(), failing=(), load_gate=None, infer_gate=None):
        self.calls, self.broken, self.missing, self.failing = calls, broken, missing, failing
        self.load_gate, self.infer_gate, self.seen = load_gate, infer_gate, []
        self.load(model)

    def check(self, model):
        if model in self.missing:
            raise FileNotFoundError(f"{model}.ckpt missing")

    def load(self, model):
        self.check(model)
        self.calls.append(("load", model))
        if self.load_gate:
            self.load_gate.wait(2)
        if model in self.broken:
            raise RuntimeError("CUDA out of memory")

    def unload(self, model):
        self.calls.append(("unload", model))

    def infer(self, jpeg, model):
        if self.infer_gate:
            self.infer_gate.wait(2)
        self.seen.append((jpeg, model))
        if model in self.failing:
            raise RuntimeError("CUDA error: an illegal memory access was encountered")
        return {"w": 640, "h": 480, "hands": [{"lm": [[0.5, 0.5, 0]] * 21, "wlm": [[0, 0, 0]] * 21,
                                                "hand": "Right", "score": 0.9}]}


def app(calls, keep_models=False, **fake):
    return create_app(lambda model: FakeTracker(model, calls, **fake), "wilor", keep_models)


def frame(fid: int, payload: bytes = b"jpeg") -> bytes:
    return struct.pack("<I", fid) + payload


def recv(ws) -> dict:
    return json.loads(ws.receive_text())


def switch(ws, model: str) -> None:
    ws.send_text(json.dumps({"t": "anyhand.model", "model": model}))


def until_ready(ws) -> list[dict]:
    """Statuses up to and including the next ready one."""
    seen = [recv(ws)]
    while not seen[-1]["ready"]:
        seen.append(recv(ws))
    return seen


def wait_for(client, ok) -> dict:
    for _ in range(100):
        if ok(health := client.get("/anyhand/health").json()):
            return health
        threading.Event().wait(0.02)
    raise AssertionError(f"health never got there: {health}")


def wait_ready(client) -> dict:
    return wait_for(client, lambda h: h["ready"])


def test_round_trip_and_status():
    with TestClient(app([])) as client:
        health = wait_ready(client)
        assert health["model"] == "wilor" and health["models"] == ["wilor", "hamer"] and health["loaded"] == ["wilor"]
        with client.websocket_connect("/anyhand/ws") as ws:
            assert recv(ws) == {"t": "anyhand.status", "ready": True, "detail": health["detail"], "model": "wilor"}
            ws.send_text("not json")
            switch(ws, "mediapipe")  # not a laptop model: ignored
            ws.send_bytes(frame(7))
            res = recv(ws)
            assert res["t"] == "anyhand.result" and res["id"] == 7 and res["model"] == "wilor"
            assert res["hands"][0]["hand"] == "Right" and res["ms"] >= 0


def test_a_failed_frame_says_which_model_failed_and_why():
    with TestClient(app([], failing=("wilor",))) as client:
        wait_ready(client)
        with client.websocket_connect("/anyhand/ws") as ws:
            assert recv(ws)["ready"]
            ws.send_bytes(frame(3))
            res = recv(ws)
            assert res["id"] == 3 and res["hands"] == [] and res["model"] == "wilor" and "CUDA" in res["error"]


def test_only_the_newest_frame_is_processed_while_busy():
    gate = threading.Event()
    with TestClient(app([], infer_gate=gate)) as client:
        wait_ready(client)
        tracker = client.app.state.service.tracker
        with client.websocket_connect("/anyhand/ws") as ws:
            recv(ws)
            ws.send_bytes(frame(1, b"a"))   # starts inference, blocked on the gate
            threading.Event().wait(0.1)
            for fid, payload in [(2, b"b"), (3, b"c"), (4, b"d")]:
                ws.send_bytes(frame(fid, payload))
            threading.Event().wait(0.1)
            gate.set()
            ids = [recv(ws)["id"] for _ in range(2)]
            assert ids == [1, 4] and tracker.seen == [(b"a", "wilor"), (b"d", "wilor")]


def test_switching_frees_the_other_model_first_and_tags_results():
    calls = []
    with TestClient(app(calls)) as client:
        wait_ready(client)
        with client.websocket_connect("/anyhand/ws") as ws:
            recv(ws)
            switch(ws, "hamer")
            loading, ready = until_ready(ws)  # one status each way, however many steps the switch takes
            assert loading == {"t": "anyhand.status", "ready": False, "detail": "loading HaMeR…", "model": "hamer"}
            assert ready["model"] == "hamer" and ready["detail"].startswith("HaMeR ready")
            ws.send_bytes(frame(1))
            assert recv(ws)["model"] == "hamer"
        assert calls == [("load", "wilor"), ("unload", "wilor"), ("load", "hamer")]
        health = client.get("/anyhand/health").json()
        assert health["model"] == "hamer" and health["loaded"] == ["hamer"] and health["loading"] is None


def test_keep_models_switches_back_without_reloading():
    calls = []
    with TestClient(app(calls, keep_models=True)) as client:
        wait_ready(client)
        with client.websocket_connect("/anyhand/ws") as ws:
            recv(ws)
            for model in ["hamer", "wilor", "hamer"]:
                switch(ws, model)
                assert until_ready(ws)[-1]["model"] == model
        assert calls == [("load", "wilor"), ("load", "hamer")]
        assert client.get("/anyhand/health").json()["loaded"] == ["hamer", "wilor"]


def test_frames_are_dropped_while_a_model_loads():
    gate = threading.Event()
    with TestClient(app([])) as client:
        wait_ready(client)
        tracker = client.app.state.service.tracker
        tracker.load_gate = gate  # only the switch's load waits
        with client.websocket_connect("/anyhand/ws") as ws:
            recv(ws)
            switch(ws, "hamer")
            assert recv(ws)["detail"] == "loading HaMeR…"
            assert wait_for(client, lambda h: h["loading"] == "hamer")["ready"] is False
            ws.send_bytes(frame(1))
            ws.send_bytes(frame(2))
            threading.Event().wait(0.1)
            gate.set()
            assert until_ready(ws)[-1]["model"] == "hamer"  # no results for frames 1 and 2 on the way
            ws.send_bytes(frame(3))
            assert recv(ws)["id"] == 3
        assert [model for _, model in tracker.seen] == ["hamer"]


def test_a_failed_load_is_reported_and_the_previous_model_comes_back():
    calls = []
    with TestClient(app(calls, broken={"hamer"})) as client:
        wait_ready(client)
        with client.websocket_connect("/anyhand/ws") as ws:
            recv(ws)
            switch(ws, "hamer")
            ready = until_ready(ws)[-1]
            assert ready["model"] == "wilor" and "HaMeR failed to load: CUDA out of memory" in ready["detail"]
            ws.send_bytes(frame(1))
            assert recv(ws)["model"] == "wilor"
        # the failed load is freed before the way back, so the old model fits again
        assert calls == [("load", "wilor"), ("unload", "wilor"), ("load", "hamer"), ("unload", "hamer"),
                         ("load", "wilor")]


def test_when_the_way_back_fails_too_every_error_is_reported_and_a_request_recovers():
    with TestClient(app([])) as client:
        wait_ready(client)
        tracker = client.app.state.service.tracker
        tracker.broken = {"hamer", "wilor"}
        with client.websocket_connect("/anyhand/ws") as ws:
            recv(ws)
            switch(ws, "hamer")
            health = wait_for(client, lambda h: h["loading"] is None)
            assert not health["ready"] and health["detail"] == (
                "HaMeR failed to load: CUDA out of memory; WiLoR failed to load: CUDA out of memory")
            tracker.broken = set()
            switch(ws, "wilor")
            assert until_ready(ws)[-1]["model"] == "wilor"


def test_a_model_that_is_not_installed_never_frees_the_working_one():
    calls = []
    with TestClient(app(calls, missing={"hamer"})) as client:
        wait_ready(client)
        with client.websocket_connect("/anyhand/ws") as ws:
            recv(ws)
            switch(ws, "hamer")
            statuses = until_ready(ws)
            assert statuses[0] == {"t": "anyhand.status", "ready": False, "detail": "loading HaMeR…", "model": "hamer"}
            assert statuses[-1] == {"t": "anyhand.status", "ready": True, "model": "wilor",
                                    "detail": "WiLoR ready; HaMeR failed to load: hamer.ckpt missing"}
        assert ("unload", "wilor") not in calls


def test_a_failed_first_load_is_reported_and_retried_on_request():
    attempts = []

    def factory(model):
        attempts.append(model)
        if len(attempts) == 1:
            raise FileNotFoundError("MANO_RIGHT.pkl")
        return FakeTracker(model, [])

    with TestClient(create_app(factory, "wilor")) as client:
        health = wait_for(client, lambda h: "failed" in h["detail"])
        assert not health["ready"] and health["detail"] == "WiLoR failed to load: MANO_RIGHT.pkl"
        with client.websocket_connect("/anyhand/ws") as ws:  # the socket stays open
            assert recv(ws) == {"t": "anyhand.status", "ready": False, "detail": health["detail"], "model": None}
            switch(ws, "wilor")
            assert until_ready(ws)[-1]["model"] == "wilor"
        assert attempts == ["wilor", "wilor"]


def test_a_model_asked_for_on_connect_is_never_preceded_by_a_stale_status():
    with TestClient(app([])) as client:
        wait_ready(client)
        with client.websocket_connect("/anyhand/ws?model=hamer") as ws:
            assert recv(ws) == {"t": "anyhand.status", "ready": False, "detail": "loading HaMeR…", "model": "hamer"}
            assert until_ready(ws)[-1]["model"] == "hamer"


def test_every_client_hears_about_a_switch():
    with TestClient(app([])) as client:
        wait_ready(client)
        with client.websocket_connect("/anyhand/ws") as a, client.websocket_connect("/anyhand/ws") as b:
            recv(a), recv(b)
            switch(a, "hamer")
            assert until_ready(b)[-1]["model"] == "hamer"


def test_only_the_chosen_hand_reaches_the_model():
    class FakePredictor:
        def _detect_hands(self, img):
            boxes = np.array([[0, 0, 1, 1], [1, 1, 2, 2], [2, 2, 3, 3]], dtype=np.float32)
            return boxes, np.array([True, False, False]), np.array([0.9, 0.5, 0.7], dtype=np.float32)

        def _run_wilor(self, img, boxes, is_right, scores):
            self.got = ("wilor", boxes.tolist(), is_right.tolist(), scores.tolist())
            return ["hand"]

        def _run_hamer(self, img, boxes, is_right, scores):
            self.got = ("hamer", boxes.tolist(), is_right.tolist(), scores.tolist())
            return ["hand"]

    import torch

    t = AnyHandTracker.__new__(AnyHandTracker)  # skip model loading
    t.predictor, t.torch, t.fp16 = FakePredictor(), torch, False
    t.hand, t.max_hands = "left", 1  # the glove is on the left: ignore the higher-scoring bare right hand
    assert t.predict_bgr(np.zeros((4, 4, 3), np.uint8), "wilor") == ["hand"]
    assert t.predictor.got == ("wilor", [[2, 2, 3, 3]], [False], [np.float32(0.7)])
    t.hand = "any"
    t.predict_bgr(None, "hamer")
    assert t.predictor.got[0] == "hamer" and t.predictor.got[2] == [True]  # best overall
