import json
import struct
import threading

from fastapi.testclient import TestClient

from lunarhand.server import create_app


class FakeTracker:
    def __init__(self, gate: threading.Event | None = None):
        self.gate, self.seen = gate, []

    def infer(self, jpeg: bytes) -> dict:
        if self.gate:
            self.gate.wait(2)
        self.seen.append(jpeg)
        return {"w": 640, "h": 480, "hands": [{"lm": [[0.5, 0.5, 0]] * 21, "wlm": [[0, 0, 0]] * 21,
                                                "hand": "Right", "score": 0.9}]}


def frame(fid: int, payload: bytes = b"jpeg") -> bytes:
    return struct.pack("<I", fid) + payload


def wait_ready(client):
    for _ in range(50):
        if client.get("/anyhand/health").json()["ready"]:
            return
        threading.Event().wait(0.05)
    raise AssertionError("tracker never became ready")


def test_round_trip_and_status():
    with TestClient(create_app(FakeTracker)) as client:
        wait_ready(client)
        with client.websocket_connect("/anyhand/ws") as ws:
            assert json.loads(ws.receive_text()) == {"t": "anyhand.status", "ready": True,
                                                     "detail": client.get("/anyhand/health").json()["detail"]}
            ws.send_bytes(frame(7))
            res = json.loads(ws.receive_text())
            assert res["t"] == "anyhand.result" and res["id"] == 7 and res["hands"][0]["hand"] == "Right"
            assert res["ms"] >= 0


def test_only_the_newest_frame_is_processed_while_busy():
    gate = threading.Event()
    tracker = FakeTracker(gate)
    with TestClient(create_app(lambda: tracker)) as client:
        wait_ready(client)
        with client.websocket_connect("/anyhand/ws") as ws:
            ws.receive_text()
            ws.send_bytes(frame(1, b"a"))   # starts inference, blocked on the gate
            threading.Event().wait(0.1)
            for fid, payload in [(2, b"b"), (3, b"c"), (4, b"d")]:
                ws.send_bytes(frame(fid, payload))
            threading.Event().wait(0.1)
            gate.set()
            ids = [json.loads(ws.receive_text())["id"] for _ in range(2)]
            assert ids == [1, 4] and tracker.seen == [b"a", b"d"]


def test_only_the_chosen_hand_reaches_the_model():
    import numpy as np

    from lunarhand.server import AnyHandTracker

    class FakePredictor:
        def _detect_hands(self, img):
            boxes = np.array([[0, 0, 1, 1], [1, 1, 2, 2], [2, 2, 3, 3]], dtype=np.float32)
            return boxes, np.array([True, False, False]), np.array([0.9, 0.5, 0.7], dtype=np.float32)

        def _run_wilor(self, img, boxes, is_right, scores):
            self.got = (boxes.tolist(), is_right.tolist(), scores.tolist())
            return ["hand"]

    import torch

    t = AnyHandTracker.__new__(AnyHandTracker)  # skip model loading
    t.predictor, t.torch, t.fp16 = FakePredictor(), torch, False
    t.hand, t.max_hands = "left", 1  # the glove is on the left: ignore the higher-scoring bare right hand
    assert t.predict_bgr(np.zeros((4, 4, 3), np.uint8)) == ["hand"]
    assert t.predictor.got == ([[2, 2, 3, 3]], [False], [np.float32(0.7)])
    t.hand = "any"
    t.predict_bgr(None)
    assert t.predictor.got[1] == [True]  # best overall


def test_load_failure_is_reported_not_raised():
    def broken():
        raise FileNotFoundError("MANO_RIGHT.pkl")

    with TestClient(create_app(broken)) as client:
        for _ in range(50):
            if client.get("/anyhand/health").json()["detail"].startswith("failed"):
                break
            threading.Event().wait(0.05)
        assert "MANO_RIGHT.pkl" in client.get("/anyhand/health").json()["detail"]
