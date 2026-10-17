import pytest

from lunarhub.commands.tools import TOOL_NAMES
from lunarhub.voice.local_intents import parse, summarize


@pytest.mark.parametrize("text,tool,args", [
    ("Increase my terrain feedback sensitivity", "adjust_haptics",
     {"equipment": "rover", "setting": "terrain_sensitivity", "direction": "increase"}),
    ("less drill vibration please", "adjust_haptics",
     {"equipment": "drill", "setting": "sensitivity", "direction": "decrease"}),
    ("make the warnings stronger", "adjust_haptics",
     {"equipment": "all", "setting": "warning_intensity", "direction": "increase"}),
    ("lower my slope limit", "adjust_haptics",
     {"equipment": "rover", "setting": "slope_warn_deg", "direction": "decrease"}),
    ("Switch to rover controls", "activate_equipment", {"equipment": "rover"}),
    ("How rough is the terrain ahead?", "get_terrain_status", {}),
    ("How fast is the rover moving?", "get_equipment_status", {"equipment": "rover"}),
    ("why is my glove buzzing on the left", "ask_mission_assistant",
     {"question": "why is my glove buzzing on the left"}),
    ("show me the warning pattern", "play_haptic_test", {"pattern": "warning"}),
])
def test_parse(text, tool, args):
    assert parse(text) == [(tool, args)]


def test_unknown_and_empty():
    assert parse("") == [] and parse("sing me a song") == []


def test_all_intents_target_real_tools():
    for text in ["increase terrain", "switch to drill", "terrain", "speed", "why", "profile", "new patch with a fox",
                 "play the wave pattern"]:
        for tool, _ in parse(text):
            assert tool in TOOL_NAMES


def test_summaries():
    assert "1.25" in summarize("adjust_haptics", {"ok": True, "setting": "terrain_sensitivity", "old": 1.0, "new": 1.25})
    assert summarize("activate_equipment", {"ok": False, "error": "not_authorized", "hint": "Tap glove."}).startswith(
        "Unable")
    s = summarize("get_terrain_status", {"ok": True, "here": {"lola_slope_deg": 7.2, "measured": False},
                                         "ahead_50m": {"max_slope_deg": 16.4}})
    assert "interpolated" in s and "16" in s
