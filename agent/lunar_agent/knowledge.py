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
    Situation("walk", "nominal", ("approach", "walk", "tap"), "Walk to the drill press or the rover and tap your glove."),
    Situation("equipment_ready", "nominal", ("pick up", "board", "grab", "grip", "climb in", "enter", "step up",
                                             "operate", "fist"),
              "Your glove is authorized here: step up to the drill press or board the rover to begin."),
    Situation("drill_idle", "nominal", ("squeeze", "trigger", "aim", "lower", "fist", "space"),
              "Close your fist (or hold Space) to lower the bit onto the sample."),
    Situation("drill_free_spin", "nominal", ("aim", "contact", "move", "closer", "lower", "fist"),
              "Keep lowering the spinning bit (closed fist or Space) until it contacts the sample."),
    Situation("drill_soft", "nominal", ("continue", "steady", "keep", "fist"),
              "Keep your fist closed for a steady feed; the bit is cutting cleanly."),
    Situation("drill_hard", "caution", ("ease", "steady", "pulse", "let the bit", "lighter", "reduce", "relax", "hold off"),
              "Ease off the feed: lower in short pulses (close your fist, then relax it) and let the bit cut."),
    Situation("drill_stall", "warning", ("release", "back", "reposition", "check", "stop", "raise", "open hand",
                                         "open your hand"),
              "Stop feeding: open your hand (or press W) to raise the bit, then check it or switch samples."),
    Situation("drill_breakthrough", "nominal", ("release", "withdraw", "back", "stop", "raise", "open hand",
                                                "open your hand"),
              "Open your hand (or press W) to raise the bit; a fresh sample loads once it is clear."),
    Situation("rover_idle", "nominal", ("throttle", "drive", "steer", "open hand", "open your hand", "accelerate"),
              "Open your hand (or press W) to apply throttle gently and start driving."),
    Situation("rover_cruise", "nominal", ("continue", "keep", "maintain"), "Continue at this speed."),
    Situation("rover_rough_fast", "caution", ("slow", "reduce speed", "ease", "fist", "brake"),
              "Slow down until the ground smooths out: close your fist (or press S) to brake."),
    Situation("rover_impacts_side", "caution", ("slow", "steer", "check", "away", "fist", "brake"),
              "Slow down (close your fist or press S) and steer away from the obstacles on that side with A/D."),
    Situation("rover_slope_ahead", "caution", ("turn", "heading", "steer", "avoid", "around", "change"),
              "Change heading (steer with A/D) before reaching the steeper ground ahead."),
    Situation("rover_slope_alert", "warning", ("stop", "slow", "across", "traverse", "turn", "back", "fist", "brake"),
              "Close your fist (or press S) to slow or stop, then turn to traverse across the slope rather than "
              "climbing it head-on."),
]}

UNCERTAINTY_TERMS = ("interpolated", "estimated", "not directly measured", "uncertain", "no laser")


def rubric_text() -> str:
    return "\n".join(f"- {s.id}: hazard={s.hazard}; do: {s.guidance}" for s in RUBRIC.values())


def vocabulary_text() -> str:
    return "\n".join(f"- {k}: feels like {v['sensation']}; means {v['signal']}" for k, v in vocabulary().items())
