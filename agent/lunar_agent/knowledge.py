"""Operational knowledge: haptic vocabulary + situation rubric (PLAN.md §10B.5).

The rubric is used three ways: in the LLM prompt, by the rule-based baseline, and as eval ground truth.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from importlib import resources


@lru_cache(maxsize=1)
def vocabulary() -> dict[str, dict]:
    """meaning id -> {sensation, signal, feeling, layer}; exported from the hub's haptics/vocabulary.py."""
    return json.loads(resources.files("lunar_agent").joinpath("vocabulary.json").read_text())


@dataclass(frozen=True)
class Situation:
    id: str
    hazard: str
    action_terms: tuple[str, ...]  # a correct action mentions at least one of these
    guidance: str  # recommended action, phrased for the prompt and the baseline


RUBRIC: dict[str, Situation] = {s.id: s for s in [
    Situation("no_profile", "nominal", ("tap",), "Tap your glove on the reader so the system knows who you are."),
    Situation("not_authorized", "nominal", ("tap",), "Tap your glove on the reader at this equipment to authorize it."),
    Situation("walk", "nominal", ("approach", "walk", "tap"), "Walk to the drill rack or the rover and tap your glove."),
    Situation("drill_idle", "nominal", ("squeeze", "trigger", "aim"), "Aim at a sample and squeeze the trigger."),
    Situation("drill_free_spin", "nominal", ("aim", "contact", "move", "closer"),
              "Bring the spinning bit into contact with the sample."),
    Situation("drill_soft", "nominal", ("continue", "steady", "keep"), "Keep a steady feed; the bit is cutting cleanly."),
    Situation("drill_hard", "caution", ("ease", "steady", "pulse", "let the bit", "lighter", "reduce"),
              "Ease off the feed and let the bit cut; use short trigger pulses."),
    Situation("drill_stall", "warning", ("release", "back", "reposition", "check", "stop"),
              "Release the trigger, back the bit out, and reposition or check the bit."),
    Situation("drill_breakthrough", "nominal", ("release", "withdraw", "back", "stop"),
              "Release the trigger and withdraw the drill."),
    Situation("rover_idle", "nominal", ("throttle", "drive", "steer"), "Apply throttle gently to start driving."),
    Situation("rover_cruise", "nominal", ("continue", "keep", "maintain"), "Continue at this speed."),
    Situation("rover_rough_fast", "caution", ("slow", "reduce speed", "ease"),
              "Slow down until the ground smooths out."),
    Situation("rover_impacts_side", "caution", ("slow", "steer", "check", "away"),
              "Slow down and steer away from the obstacles on that side."),
    Situation("rover_slope_ahead", "caution", ("turn", "heading", "steer", "avoid", "around", "change"),
              "Change heading before reaching the steeper ground ahead."),
    Situation("rover_slope_alert", "warning", ("stop", "slow", "across", "traverse", "turn", "back"),
              "Slow or stop, then turn to traverse across the slope instead of climbing straight up it."),
]}

UNCERTAINTY_TERMS = ("interpolated", "estimated", "not directly measured", "uncertain", "no laser")


def rubric_text() -> str:
    return "\n".join(f"- {s.id}: hazard={s.hazard}; do: {s.guidance}" for s in RUBRIC.values())


def vocabulary_text() -> str:
    return "\n".join(f"- {k}: feels like {v['sensation']}; means {v['signal']}" for k, v in vocabulary().items())
