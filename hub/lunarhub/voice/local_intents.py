"""Offline fallback for typed commands when Grok is unreachable (PLAN.md §10.4 step 9).

Maps a handful of phrasings onto the SAME tool calls Grok would make, so the deterministic command
handler stays the single path for state changes. This is a demo safety net, not the Grok integration.
"""

from __future__ import annotations

import re

Intent = tuple[str, dict]

_SETTINGS = [
    (r"terrain", "rover", "terrain_sensitivity"),
    (r"rumble|vibration|speed feel", "rover", "vibration"),
    (r"drill|drilling", "drill", "sensitivity"),
    (r"warning|alert|alarm", "all", "warning_intensity"),
    (r"slope (limit|warning|threshold)", "rover", "slope_warn_deg"),
]


def parse(text: str) -> list[Intent]:
    t = text.lower().strip()
    if not t:
        return []
    m = re.search(r"\b(increase|raise|more|stronger|higher|decrease|lower|less|weaker|reduce)\b", t)
    if m:
        direction = "increase" if m.group(1) in ("increase", "raise", "more", "stronger", "higher") else "decrease"
        for pattern, equipment, setting in _SETTINGS[::-1]:  # most specific first
            if re.search(pattern, t):
                return [("adjust_haptics", {"equipment": equipment, "setting": setting, "direction": direction})]
    if re.search(r"\b(switch|activate|use|start)\b.*\b(drill|rover)\b", t):
        return [("activate_equipment", {"equipment": re.search(r"drill|rover", t).group(0)})]
    if re.search(r"terrain|slope|ground|how steep|rough", t):
        return [("get_terrain_status", {})]
    if re.search(r"how fast|speed|status|depth", t):
        equipment = "drill" if "drill" in t or "depth" in t else "rover"
        return [("get_equipment_status", {"equipment": equipment})]
    if re.search(r"feel|feeling|buzz|vibrat|what should i do|why", t):
        return [("ask_mission_assistant", {"question": text})]
    if re.search(r"profile|who am i|my settings", t):
        return [("get_profile", {})]
    if re.search(r"\bpatch\b", t):
        return [("redesign_mission_patch", {"style": re.sub(r".*patch\s*(with|of)?\s*", "", t)[:120]})]
    if m := re.search(r"\b(double|triple|wave|warning)\b.*pattern|pattern.*\b(double|triple|wave|warning)\b", t):
        return [("play_haptic_test", {"pattern": m.group(1) or m.group(2)})]
    return []


def summarize(tool: str, out: dict) -> str:
    """One spoken sentence from a tool result (used with browser speechSynthesis)."""
    if not out.get("ok", False):
        return f"Unable: {out.get('error', 'unknown error')}. {out.get('hint', '')}".strip()
    if tool == "adjust_haptics":
        return f"{out['setting'].replace('_', ' ').capitalize()} set from {out['old']:g} to {out['new']:g}."
    if tool == "activate_equipment":
        return f"{out['active_equipment'].capitalize()} controls active."
    if tool == "get_terrain_status":
        here, ahead = out["here"], out["ahead_50m"]
        measured = "measured" if here["measured"] else "interpolated"
        return (f"LOLA slope here is {here['lola_slope_deg']:.0f} degrees, {measured}. "
                f"Steepest in the next 50 metres: {ahead['max_slope_deg']:.0f} degrees.")
    if tool == "get_equipment_status":
        if "rover" in out:
            return f"Rover speed {out['rover']['speed_kmh']} kilometres per hour."
        if "drill" in out:
            d = out["drill"]
            return f"Drill depth {d['depth_cm']} centimetres{', stalled' if d['stalled'] else ''}."
        return "No equipment active."
    if tool == "ask_mission_assistant":
        return f"{out.get('explanation', '')} {out.get('action', '')}".strip()
    if tool == "get_profile":
        return f"Profile {out['name']}, callsign {out['callsign']}."
    if tool == "redesign_mission_patch":
        return "Generating a new mission patch."
    if tool == "play_haptic_test":
        return f"Playing the {out['played']} pattern."
    return "Done."
