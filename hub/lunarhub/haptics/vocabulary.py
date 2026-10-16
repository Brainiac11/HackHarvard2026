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
    Meaning("drill.free_spin", "light, fast hum", "drill running but not touching material",
            "drill_free_spin", "base"),
    Meaning("drill.soft", "gentle, steady hum", "bit cutting soft regolith easily",
            "soft_material_hum", "base"),
    Meaning("drill.hard", "strong, gritty, irregular bursts", "bit grinding hard basalt against high resistance",
            "hard_material_grinding", "base"),
    Meaning("alert.drill_stall", "three strong beats on all fingers", "the drill bit has stopped advancing",
            "drill_stall_warning", "alert"),
    Meaning("event.breakthrough", "one fading pulse", "the bit punched through the sample",
            "drill_breakthrough", "event"),
    Meaning("rover.speed", "rumble that rises and quickens with speed", "rover speed",
            "rover_speed_rumble", "base"),
    Meaning("rover.terrain_left", "random taps on the thumb side", "left wheels crossing bumps",
            "rough_terrain_left", "base"),
    Meaning("rover.terrain_right", "random taps on the pinky side", "right wheels crossing bumps",
            "rough_terrain_right", "base"),
    Meaning("rover.terrain", "random taps across the hand", "wheels crossing rough ground",
            "rough_terrain_both", "base"),
    Meaning("event.impact_left", "sharp hit on the thumb side", "a left wheel struck a rock or crater edge",
            "wheel_impact", "event"),
    Meaning("event.impact_right", "sharp hit on the pinky side", "a right wheel struck a rock or crater edge",
            "wheel_impact", "event"),
    Meaning("alert.slope", "three strong beats on all fingers while driving",
            "measured LOLA slope under the rover exceeds your personal limit", "slope_warning", "alert"),
    Meaning("ui.auth", "short double/triple pulse or finger wave", "glove identity accepted",
            "auth_confirmation", "event"),
    Meaning("ui.equipment_drill", "index and middle finger pulse", "drill profile is active",
            "auth_confirmation", "event"),
    Meaning("ui.equipment_rover", "left-to-right sweep", "rover profile is active",
            "auth_confirmation", "event"),
    Meaning("ui.confirm", "single short middle-finger tap", "command accepted", "setting_change", "event"),
    Meaning("ui.setting_up", "ripple from thumb to pinky", "a feedback setting was increased",
            "setting_change", "event"),
    Meaning("ui.setting_down", "ripple from pinky to thumb", "a feedback setting was decreased",
            "setting_change", "event"),
    Meaning("ui.denied", "long low buzz", "not authorised, or the glove was not recognised",
            "access_denied", "event"),
    Meaning("ui.test", "demonstration pattern", "haptic test requested", "none", "event"),
]}


def export_json(path: Path) -> None:
    path.write_text(json.dumps({k: asdict(v) for k, v in MEANINGS.items()}, indent=2) + "\n")


def as_dict() -> dict[str, dict]:
    return {k: asdict(v) for k, v in MEANINGS.items()}
