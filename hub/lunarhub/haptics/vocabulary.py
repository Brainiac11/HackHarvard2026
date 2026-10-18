"""Haptic vocabulary: the single source of truth for what each glove sensation means (PLAN.md §7.5).

Every effect the engine renders carries one of these meaning ids. The Mission Assistant receives the
same table (exported to agent/lunar_agent/vocabulary.json) so it can explain sensations to the astronaut.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass(frozen=True)
class Meaning:
    id: str
    sensation: str  # what the astronaut physically feels
    signal: str  # what it tells them
    feeling: str  # AssistantAdvice.feeling label this maps to
    layer: str  # base | event | alert


MEANINGS: dict[str, Meaning] = {m.id: m for m in [
    Meaning("drill.free_spin", "faint, smooth, steady hum (barely there)", "drill running but not touching material",
            "drill_free_spin", "base"),
    Meaning("drill.soft", "gentle hum with a slow, even throb", "bit cutting soft regolith easily",
            "soft_material_hum", "base"),
    Meaning("drill.hard", "strong, gritty, irregular grinding jolts",
            "bit grinding hard basalt against high resistance", "hard_material_grinding", "base"),
    Meaning("alert.drill_stall", "a brief silence, then three heavy, slow beats in the index, middle and ring fingers",
            "the drill bit has stopped advancing", "drill_stall_warning", "alert"),
    Meaning("event.breakthrough", "one sharp punch in the middle finger that spreads out across the hand and fades",
            "the bit punched through the sample", "drill_breakthrough", "event"),
    Meaning("rover.speed", "steady rumble that grows stronger and throbs faster with speed", "rover speed",
            "rover_speed_rumble", "base"),
    Meaning("rover.terrain_left", "random taps on the thumb side, denser and stronger on rougher ground",
            "left wheels crossing bumps", "rough_terrain_left", "base"),
    Meaning("rover.terrain_right", "random taps on the pinky side, denser and stronger on rougher ground",
            "right wheels crossing bumps", "rough_terrain_right", "base"),
    Meaning("rover.terrain", "random taps across the hand, denser and stronger on rougher ground",
            "wheels crossing rough ground", "rough_terrain_both", "base"),
    Meaning("event.impact_left", "one sharp, hard hit on the thumb side that dies away quickly",
            "a left wheel struck a rock or crater edge", "wheel_impact", "event"),
    Meaning("event.impact_right", "one sharp, hard hit on the pinky side that dies away quickly",
            "a right wheel struck a rock or crater edge", "wheel_impact", "event"),
    Meaning("alert.slope", "a brief silence, then a siren: the thumb side and the pinky side take turns, faster and "
            "stronger each time", "measured LOLA slope under the rover exceeds your personal limit", "slope_warning",
            "alert"),
    Meaning("ui.auth", "your chosen identity pattern: two crisp pulses, three quick pulses, or a wave across the "
            "fingers and back", "glove identity accepted", "auth_confirmation", "event"),
    Meaning("ui.equipment_drill", "a swell that builds in the index and middle fingers, then a firm tap",
            "drill profile is active", "auth_confirmation", "event"),
    Meaning("ui.equipment_rover", "two rolling swells on both edges of the hand (thumb and pinky sides)",
            "rover profile is active", "auth_confirmation", "event"),
    Meaning("ui.confirm", "one short tap on the middle finger", "command accepted", "setting_change", "event"),
    Meaning("ui.setting_up", "a quick ripple from thumb to pinky that grows stronger",
            "a feedback setting was increased", "setting_change", "event"),
    Meaning("ui.setting_down", "a quick ripple from pinky to thumb that fades", "a feedback setting was decreased",
            "setting_change", "event"),
    Meaning("ui.denied", "a low, rough, stuttering buzz that sags",
            "not authorised, or the glove was not recognised", "access_denied", "event"),
    Meaning("ui.test", "a demonstration of one of the patterns above", "haptic test requested", "none", "event"),
]}


def export_json(path: Path) -> None:
    path.write_text(json.dumps({k: asdict(v) for k, v in MEANINGS.items()}, indent=2) + "\n")


def as_dict() -> dict[str, dict]:
    return {k: asdict(v) for k, v in MEANINGS.items()}
