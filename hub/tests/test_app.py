"""Integration: run the hub app with the null glove and drive it over WebSockets like the simulator does."""

import json
import shutil
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from lunarhub.app import Settings, create_app
from lunarhub.glove.transport import NullTransport
from lunarhub.protocol import glove as gp
from lunarhub.haptics.vocabulary import as_dict

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def env(tmp_path):
    (tmp_path / "data").mkdir()
    shutil.copy(ROOT / "data" / "profiles.json", tmp_path / "data" / "profiles.json")
    (tmp_path / "sim" / "public").mkdir(parents=True)
    terrain = ROOT / "sim" / "public" / "terrain"
    if terrain.exists():
        (tmp_path / "sim" / "public" / "terrain").symlink_to(terrain)
    transport = NullTransport()
    app = create_app(Settings(root=tmp_path, nfc="none", pregenerate_patches=False), transport)
    with TestClient(app) as client:
        yield client, transport, app.state.hub


def recv_until(ws, kind, limit=200):
    for _ in range(limit):
        msg = json.loads(ws.receive_text())
        if msg["t"] == kind:
            return msg
    raise AssertionError(f"no {kind} message")


def test_health_and_voice_config(env):
    client, _, _ = env
    h = client.get("/api/health").json()
    assert h["glove"]["transport"] == "null" and h["voice_configured"] is False
    cfg = client.get("/api/voice/config").json()
    assert cfg["session"]["turn_detection"] is None
    assert {t["name"] for t in cfg["session"]["tools"]} >= {"ask_mission_assistant", "adjust_haptics"}
    assert client.post("/api/voice/token").status_code == 503  # no key configured


def test_scan_drill_and_haptics_end_to_end(env):
    client, transport, hub = env
    with client.websocket_connect("/ws/sim") as ws:
        assert json.loads(ws.receive_text())["t"] == "hub.state"
        # walk to the drill, simulate the glove tap
        ws.send_text(json.dumps({"t": "sim.state", "mode": "walk", "near": "drill"}))
        ws.send_text(json.dumps({"t": "ui.action", "action": "nfc_simulate", "args": {"profile_id": "rivera"}}))
        welcome = recv_until(ws, "hub.welcome")
        assert welcome["name"] == "Cmdr. Ana Rivera" and welcome["patch_source"] == "fallback"
        state = recv_until(ws, "hub.state")
        assert state["equipment"]["active"] == "drill" and state["profile"]["id"] == "rivera"
        # drill hard basalt; motors must be driven and the frame must reach the transport
        ws.send_text(json.dumps({"t": "sim.state", "mode": "drill", "near": "drill",
                                 "drill": {"held": True, "trigger": 1, "contact": True, "hardness": 0.9,
                                           "target": "hard"}}))
        deadline = time.time() + 2
        motors = None
        while time.time() < deadline:
            msg = json.loads(ws.receive_text())
            if msg["t"] == "hub.motors" and msg["dominant"] == "drill.hard":
                motors = msg
                break
        assert motors and max(motors["duty"]) > 0
        pkt = gp.Parser().feed(transport.last_packet)
        assert pkt and pkt[0].type in (gp.PacketType.FRAME, gp.PacketType.PING)


def test_unknown_tag_enrolled_at_drill_authorizes_it(env):
    client, _, hub = env
    with client.websocket_connect("/ws/sim") as ws:
        ws.receive_text()
        ws.send_text(json.dumps({"t": "sim.state", "mode": "walk", "near": "drill"}))
        recv_until(ws, "hub.state")
        # a real reader tap goes through NfcService.emit, same as this endpoint
        assert client.post("/api/nfc/scan", json={"uid": "04:A2:24:5A:6B:12:90"}).json()["ok"]
        assert "Unknown glove" in recv_until(ws, "hub.toast")["text"]
        state = recv_until(ws, "hub.state")
        assert state["nfc"]["unknown_uid"] == "04A2245A6B1290" and state["profile"] is None
        # the sim sends this when N is pressed while an unknown tag is pending
        ws.send_text(json.dumps({"t": "ui.action", "action": "enroll", "args": {"profile_id": "rivera"}}))
        state = recv_until(ws, "hub.state")
        assert state["profile"]["id"] == "rivera" and state["nfc"]["unknown_uid"] is None
        assert state["equipment"]["authorized"] == ["drill"] and state["equipment"]["active"] == "drill"
    assert hub.store.by_uid("04A2245A6B1290").id == "rivera"
    assert "04A2245A6B1290" in (hub.settings.data_dir / "profiles.json").read_text()


def test_voice_tool_call_round_trip(env):
    client, _, _ = env
    with client.websocket_connect("/ws/sim") as ws:
        ws.receive_text()
        ws.send_text(json.dumps({"t": "voice.tool_call", "call_id": "c1", "name": "get_profile", "args": {}}))
        res = recv_until(ws, "voice.tool_result")
        assert res["call_id"] == "c1" and res["output"]["error"] == "no_profile"
        ws.send_text(json.dumps({"t": "ui.action", "action": "nfc_simulate", "args": {"profile_id": "okafor"}}))
        ws.send_text(json.dumps({"t": "voice.tool_call", "call_id": "c2", "name": "adjust_haptics",
                                 "args": {"equipment": "rover", "setting": "terrain_sensitivity",
                                          "direction": "increase"}}))
        res = recv_until(ws, "voice.tool_result")
        assert res["output"]["ok"] and res["output"]["old"] == 1.5 and res["output"]["new"] == 1.875


def test_assistant_local_fallback(env):
    client, _, hub = env
    with client.websocket_connect("/ws/sim") as ws:
        ws.receive_text()
        ws.send_text(json.dumps({"t": "sim.state", "mode": "walk", "near": "rover"}))
        ws.send_text(json.dumps({"t": "ui.action", "action": "nfc_simulate", "args": {"profile_id": "rivera"}}))
        ws.send_text(json.dumps({"t": "sim.state", "mode": "rover", "near": "rover",
                                 "rover": {"speed": 2.0, "heading_deg": 0},
                                 "terrain": {"x": 0, "z": 0, "lola_slope_deg": 25}}))
        ws.send_text(json.dumps({"t": "ui.action", "action": "ask_assistant", "args": {"question": "why?"}}))
        for _ in range(400):
            msg = json.loads(ws.receive_text())
            if msg["t"] == "hub.assistant" and msg["status"] == "ready" and msg["trigger"] == "manual":
                break
        assert msg["source"] == "local"
        assert msg["advice"]["hazard"] in ("nominal", "caution", "warning")
    log = list((hub.settings.data_dir / "sessions").glob("assistant-*.jsonl"))
    assert log and log[0].read_text().strip()


def test_tracker_relay(env):
    client, _, hub = env
    with client.websocket_connect("/ws/sim") as sim, client.websocket_connect("/ws/tracker") as tracker:
        sim.receive_text()
        tracker.send_text(json.dumps({"t": "ping", "ts": 1}))
        assert json.loads(tracker.receive_text())["t"] == "pong"
        tracker.send_text(json.dumps({"t": "hand.frame", "ts": 1, "lm": [[0, 0, 0]] * 21, "engine": "anyhand"}))
        assert recv_until(sim, "hand.frame")["lm"][0] == [0, 0, 0]
        assert hub.state_view()["tracker"]["engine"] == "anyhand"


def test_agent_vocabulary_is_in_sync():
    exported = json.loads((ROOT / "agent" / "lunar_agent" / "vocabulary.json").read_text())
    assert exported == as_dict(), "run the vocabulary export (see hub/lunarhub/haptics/vocabulary.py)"
