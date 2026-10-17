import json
import shutil
from pathlib import Path

import pytest

from lunarhub.commands.handler import CommandHandler
from lunarhub.haptics.engine import HapticEngine
from lunarhub.mission.state import MissionState, Outcome
from lunarhub.profiles.store import ProfileStore, normalize_uid
from lunarhub.protocol.messages import RoverState, SimState, TerrainState
from lunarhub.terrain import TerrainGrid

ROOT = Path(__file__).resolve().parents[2]
TERRAIN_DIR = ROOT / "sim" / "public" / "terrain" / "site04"
UID_A = "04:A2:24:5A:6B:12:90"


@pytest.fixture
def store(tmp_path):
    path = tmp_path / "profiles.json"
    shutil.copy(ROOT / "data" / "profiles.json", path)
    s = ProfileStore(path)
    for p in s.profiles:  # drop tags enrolled on the demo machine (they live in the real profiles.json)
        p.uids = []
    s.enroll(UID_A, "rivera")
    return s


class FakeHub:
    def __init__(self, store):
        self.store = store
        self.mission = MissionState(store)
        self.engine = HapticEngine()
        self.terrain = TerrainGrid.try_load(TERRAIN_DIR)
        self.outcomes: list[Outcome] = []
        self.settings_changes = 0

    async def apply_outcome(self, outcome):
        self.outcomes.append(outcome)

    async def profile_settings_changed(self):
        self.settings_changes += 1

    async def ask_assistant(self, question, trigger):
        return {"feeling": "none", "explanation": f"echo: {question}", "action": "continue", "hazard": "nominal"}

    async def redesign_patch(self, style):
        return {"ok": True, "status": "generating", "style": style}


@pytest.fixture
def hub(store):
    return FakeHub(store)


# ---------------------------------------------------------------- profiles

def test_uid_normalisation_and_lookup(store):
    assert normalize_uid("04:a2 24-5a6b1290") == "04A2245A6B1290"
    assert store.by_uid("04a2245a6b1290").id == "rivera"
    assert store.by_uid("FFFF") is None


def test_enroll_moves_tag_between_profiles_and_persists(store):
    store.enroll(UID_A, "okafor")
    reloaded = ProfileStore(store.path)
    assert reloaded.by_uid(UID_A).id == "okafor"
    assert not reloaded.get("rivera").uids
    assert json.loads(store.path.read_text())["profiles"][0]["global"]["gain"] == 1.0  # alias preserved


def test_setting_bounds(store):
    old, new = store.set_setting("rivera", "drill", "sensitivity", 99)
    assert (old, new) == (1.3, 2.0)
    _, new = store.set_setting("rivera", "rover", "slope_warn_deg", 1)
    assert new == 5.0
    with pytest.raises(ValueError):
        store.set_setting("rivera", "drill", "terrain_sensitivity", 1.0)


# ---------------------------------------------------------------- mission state (§6.2 flow table)

@pytest.mark.parametrize("near,known,expect_active,expect_ok", [
    (None, True, None, True),
    ("drill", True, "drill", True),
    ("rover", True, "rover", True),
    (None, False, None, False),
    ("drill", False, None, False),
])
def test_scan_flow(store, near, known, expect_active, expect_ok):
    m = MissionState(store)
    m.set_near(near)
    out = m.on_scan(UID_A if known else "DEADBEEF")
    assert out.ok is expect_ok
    assert m.active_equipment == expect_active
    meanings = [p.meaning for p, _ in out.patterns]
    if known:
        assert meanings[0] == "ui.auth" and m.profile.id == "rivera"
        if near:
            assert meanings[1] == f"ui.equipment_{near}" and near in m.authorized
    else:
        assert meanings == ["ui.denied"] and m.unknown_uid == "DEADBEEF"


def test_enrollment_then_scan(store):
    m = MissionState(store)
    m.set_near("rover")
    m.on_scan("CAFEBABE")
    out = m.enroll("okafor")
    assert out.ok and m.profile.id == "okafor" and m.active_equipment == "rover"
    assert store.by_uid("CAFEBABE").id == "okafor"


def test_enroll_rejects_unknown_profile(store):
    m = MissionState(store)
    m.on_scan("CAFEBABE")
    out = m.enroll("nobody")
    assert not out.ok and out.reason == "unknown_profile"
    assert m.unknown_uid == "CAFEBABE" and store.by_uid("CAFEBABE") is None


def test_equipment_requires_authorization(store):
    m = MissionState(store)
    assert m.request_equipment("drill").reason == "no_profile"
    m.on_scan(UID_A)
    assert m.request_equipment("rover").reason == "not_authorized"
    m.set_near("rover")
    m.on_scan(UID_A)
    m.set_near("drill")
    m.on_scan(UID_A)
    assert m.active_equipment == "drill"
    out = m.request_equipment("rover")  # previously authorized
    assert out.ok and m.active_equipment == "rover"


def test_switching_astronaut_clears_authorizations(store):
    store.enroll("BEEF", "okafor")
    m = MissionState(store)
    m.set_near("drill")
    m.on_scan(UID_A)
    m.set_near(None)
    m.on_scan("BEEF")
    assert m.profile.id == "okafor" and not m.authorized and m.active_equipment is None


# ---------------------------------------------------------------- command handler

async def test_unknown_tool_and_bad_args(hub):
    h = CommandHandler(hub)
    assert (await h.execute("launch_rocket", {}))["ok"] is False
    assert (await h.execute("activate_equipment", {"equipment": "laser"}))["ok"] is False
    assert (await h.execute("activate_equipment", "nope"))["ok"] is False


async def test_adjust_requires_profile(hub):
    out = await CommandHandler(hub).execute("adjust_haptics", {"equipment": "rover", "setting": "vibration",
                                                               "direction": "increase"})
    assert out == {"ok": False, "error": "no_profile", "hint": "Ask the astronaut to tap their glove on the reader."}


async def test_adjust_steps_clamps_and_corrects_equipment(hub):
    hub.mission.on_scan(UID_A)
    h = CommandHandler(hub)
    out = await h.execute("adjust_haptics", {"equipment": "all", "setting": "terrain_sensitivity",
                                             "direction": "increase"})
    assert out["ok"] and out["equipment"] == "rover" and out["old"] == 1.0 and out["new"] == 1.25
    assert hub.outcomes[-1].patterns[0][0].meaning == "ui.setting_up"
    assert hub.settings_changes == 1
    out = await h.execute("adjust_haptics", {"equipment": "rover", "setting": "slope_warn_deg",
                                             "direction": "decrease"})
    assert out["new"] == 13.0
    out = await h.execute("adjust_haptics", {"equipment": "drill", "setting": "sensitivity",
                                             "direction": "set", "value": 50})
    assert out["new"] == 2.0
    out = await h.execute("adjust_haptics", {"equipment": "drill", "setting": "sensitivity",
                                             "direction": "set"})
    assert out["ok"] is False


async def test_activate_equipment_flow(hub):
    h = CommandHandler(hub)
    hub.mission.set_near("rover")
    hub.mission.on_scan(UID_A)
    hub.mission.request_equipment(None)
    assert (await h.execute("activate_equipment", {"equipment": "drill"}))["error"] == "not_authorized"
    assert (await h.execute("activate_equipment", {"equipment": "rover"}))["active_equipment"] == "rover"


async def test_status_tools(hub):
    h = CommandHandler(hub)
    hub.engine.update_state(SimState(mode="rover", rover=RoverState(speed=2.5, heading_deg=90),
                                     terrain=TerrainState(x=0, z=0)))
    rover = await h.execute("get_equipment_status", {"equipment": "rover"})
    assert rover["rover"]["speed_kmh"] == 9.0
    assert (await h.execute("get_profile", {}))["ok"] is False
    if hub.terrain is not None:
        terrain = await h.execute("get_terrain_status", {})
        assert terrain["ok"] and -90 <= terrain["position"]["lat"] <= -89
        assert terrain["ahead_50m"]["max_slope_deg"] >= 0 and "LOLA" in terrain["source"]


async def test_test_pattern_and_delegations(hub):
    h = CommandHandler(hub)
    assert (await h.execute("play_haptic_test", {"pattern": "warning"}))["played"] == "warning"
    assert (await h.execute("play_haptic_test", {"pattern": "boom"}))["ok"] is False
    assert "echo" in (await h.execute("ask_mission_assistant", {"question": "why?"}))["explanation"]
    assert (await h.execute("redesign_mission_patch", {"style": "x"}))["error"] == "no_profile"


# ---------------------------------------------------------------- terrain grid

@pytest.mark.skipif(not TERRAIN_DIR.exists(), reason="terrain not built")
def test_terrain_grid_sampling():
    g = TerrainGrid(TERRAIN_DIR)
    s = g.sample(0, 0)
    assert 0 <= s["lola_slope_deg"] < 60 and s["lola_slope_err_deg"] > 0
    lat, lon = g.latlon(0, 0)
    assert abs(lat - g.meta["corners"]["center"]["lat"]) < 0.01
    # lookahead never leaves the grid and reports the steepest sample
    la = g.lookahead(0, 0, 0)
    assert la.max_slope_deg >= g.sample(0, -5)["lola_slope_deg"] - 1e-6
    edge = g.lookahead(g.extent / 2 - 1, 0, 90)
    assert edge.max_slope_deg == 0.0
