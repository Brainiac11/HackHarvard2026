"""Function-tool schemas exposed to Grok Voice (PLAN.md §10.3).

These are the ONLY actions the voice model can take; every call is validated by CommandHandler.
"""

from __future__ import annotations

EQUIPMENT_ENUM = ["drill", "rover"]
SETTING_ENUM = ["sensitivity", "vibration", "terrain_sensitivity", "warning_intensity", "slope_warn_deg"]
TEST_PATTERN_ENUM = ["double", "triple", "wave", "warning"]


def _fn(name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {
        "type": "function",
        "name": name,
        "description": description,
        "parameters": {"type": "object", "properties": properties, "required": required,
                       "additionalProperties": False},
    }


TOOLS: list[dict] = [
    _fn("activate_equipment",
        "Switch the astronaut's active equipment controls. Only works for equipment their glove has "
        "already been tapped to authorize.",
        {"equipment": {"type": "string", "enum": EQUIPMENT_ENUM}}, ["equipment"]),
    _fn("adjust_haptics",
        "Change one of the astronaut's personal haptic feedback settings. Drill: sensitivity. Rover: vibration, "
        "terrain_sensitivity, slope_warn_deg. all: warning_intensity. 'increase'/'decrease' step by 25%; "
        "slope_warn_deg steps by 2 degrees.",
        {"equipment": {"type": "string", "enum": ["drill", "rover", "all"]},
         "setting": {"type": "string", "enum": SETTING_ENUM},
         "direction": {"type": "string", "enum": ["increase", "decrease", "set"]},
         "value": {"type": "number", "description": "Only for direction=set. Multipliers 0.2-2.0; "
                                                   "slope_warn_deg 5-30."}},
        ["equipment", "setting", "direction"]),
    _fn("get_equipment_status", "Read live status of the drill or rover.",
        {"equipment": {"type": "string", "enum": EQUIPMENT_ENUM}}, []),
    _fn("get_terrain_status",
        "Read the terrain at and ahead of the astronaut from NASA LOLA data: position, elevation, measured slope "
        "and its uncertainty, laser coverage, and the steepest slope in the next 50 m along the heading.",
        {}, []),
    _fn("get_profile", "Read the identified astronaut's profile and haptic settings.", {}, []),
    _fn("play_haptic_test", "Play a demonstration haptic pattern on the glove.",
        {"pattern": {"type": "string", "enum": TEST_PATTERN_ENUM}}, ["pattern"]),
    _fn("ask_mission_assistant",
        "Ask the Mission Assistant to explain what the astronaut is feeling through the glove, why, and what they "
        "should do. Use this for any 'what am I feeling', 'why is my glove buzzing', or 'what should I do' question.",
        {"question": {"type": "string", "description": "The astronaut's question, verbatim."}}, ["question"]),
    _fn("redesign_mission_patch",
        "Generate a new mission patch image for the active astronaut with Grok Imagine.",
        {"style": {"type": "string", "description": "Short description of the new motif or style (max 120 chars)."}},
        ["style"]),
]

TOOL_NAMES = {t["name"] for t in TOOLS}
