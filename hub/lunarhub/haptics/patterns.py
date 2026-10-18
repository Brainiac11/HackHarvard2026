"""Named one-shot haptic patterns (PLAN.md §7.2).

Every meaning gets its own signature along at least one strong axis (rhythm, location/motion, envelope), using
coarse finger groups because neighbouring fingers are hard to tell apart on the back of the hand. Steps are at
least 40 ms (an ERM needs 30-50 ms to spin up or down). The grammar:

- alerts (~1 s, hushed lead-in, overdriven accents): stall = heavy static beats in the grip; slope = a left-right
  siren that speeds up and grows.
- world events (< 0.5 s, accented): impact = a hard hit on one side that dies away; breakthrough = a punch in the
  middle that spreads out and fades.
- UI (< 0.5 s, never above the sustained ceiling): pulses for identity, swells for equipment, one tap to confirm,
  directional ripples for settings, a sagging stutter for "no".
"""

from __future__ import annotations

from typing import Callable

from .effects import (ALL, CENTER, EDGES, FINGER, GRIP, LEFT, RIGHT, TRIGGER, Keyframes, Note, pulses, score,
                      sequence, vec)

THUMB_TO_PINKY = list(FINGER)


# ---------------------------------------------------------------- identity
def double(meaning: str = "ui.auth") -> Keyframes:
    return Keyframes(meaning, score(pulses(ALL, 2, 70, 80, 0.85)))


def triple(meaning: str = "ui.auth") -> Keyframes:
    return Keyframes(meaning, score(pulses(ALL, 3, 50, 60, 0.85)))


def wave(meaning: str = "ui.auth") -> Keyframes:
    # out and back across the hand: a wave, unlike the one-way setting ripples
    there_and_back = THUMB_TO_PINKY + THUMB_TO_PINKY[-2::-1]
    return Keyframes(meaning, score(sequence(there_and_back, 60, 0.8, overlap_ms=20)))


# ---------------------------------------------------------------- equipment (swells: drill = one + a tap at the
# centre, rover = two on both edges)
def equipment_drill(meaning: str = "ui.equipment_drill") -> Keyframes:
    return Keyframes(meaning, score([Note(0, 240, 0.3 * TRIGGER, 0.85 * TRIGGER), Note(300, 70, 0.9 * TRIGGER)]))


def equipment_rover(meaning: str = "ui.equipment_rover") -> Keyframes:
    swell = [Note(0, 140, 0.3 * EDGES, 0.8 * EDGES), Note(140, 80, 0.8 * EDGES, 0.3 * EDGES)]
    return Keyframes(meaning, score(swell + [Note(n.at + 260, n.ms, n.level, n.end) for n in swell]))


# ---------------------------------------------------------------- commands and settings
def confirm(meaning: str = "ui.confirm") -> Keyframes:
    return Keyframes(meaning, score([Note(0, 70, 0.85 * CENTER)]))


def setting_up(meaning: str = "ui.setting_up") -> Keyframes:
    return Keyframes(meaning, score(sequence(THUMB_TO_PINKY, 70, [0.45, 0.58, 0.7, 0.83, 0.95], overlap_ms=30)))


def setting_down(meaning: str = "ui.setting_down") -> Keyframes:
    return Keyframes(meaning, score(sequence(THUMB_TO_PINKY[::-1], 70, [0.95, 0.83, 0.7, 0.58, 0.45],
                                             overlap_ms=30)))


def denied(meaning: str = "ui.denied") -> Keyframes:
    # low and rough (an ~11 Hz stutter) and sagging: nothing else in the vocabulary is low, rough and short
    return Keyframes(meaning, score(pulses(ALL, 5, 50, 40, [0.5, 0.46, 0.42, 0.37, 0.32])))


# ---------------------------------------------------------------- alerts
def drill_stall(meaning: str = "alert.drill_stall") -> Keyframes:
    """Three heavy, slow beats where the hand grips; each lands with an accent and sags, like a thud."""
    beats = pulses(GRIP, 3, 200, 120, 1.0, end=0.7, accent_ms=60)
    return Keyframes(meaning, score(beats, lead_ms=80, tail_ms=100, hush_gaps=True), layer="alert")


def slope(meaning: str = "alert.slope") -> Keyframes:
    """A siren: the thumb side and the pinky side take turns, faster and stronger each time, like a rover rocking."""
    ms = [120, 120, 100, 100, 80, 80, 70, 70, 60, 60]
    level = [0.5, 0.55, 0.62, 0.68, 0.75, 0.82, 0.88, 0.94, 1.0, 1.0]
    return Keyframes(meaning, score(sequence([LEFT, RIGHT] * 5, ms, level, accent_ms=40), lead_ms=60, tail_ms=80),
                     layer="alert")


def warning(meaning: str) -> Keyframes:
    """The alert for `meaning` (kept for older callers); any other meaning gets the stall rhythm."""
    return slope(meaning) if meaning == "alert.slope" else drill_stall(meaning)


# ---------------------------------------------------------------- world events
def impact(side: str, magnitude: float = 1.0, meaning: str | None = None) -> Keyframes:
    """A hard accented hit on one side that dies away; `magnitude` (0.35-1) scales it, so small knocks stay small."""
    mask = LEFT if side == "left" else RIGHT
    hit = [Note(0, 50, mask, accent_ms=50), Note(50, 150, 0.85 * mask, 0.0 * mask)]
    return Keyframes(meaning or f"event.impact_{'left' if side == 'left' else 'right'}", score(hit, lead_ms=30),
                     gain=max(0.35, min(1.0, magnitude)))


def breakthrough(meaning: str = "event.breakthrough") -> Keyframes:
    """A punch in the middle that spreads out to the edges and fades: the bit suddenly free of the sample."""
    notes = [Note(0, 60, CENTER, accent_ms=50), Note(0, 60, vec([0.0, 0.5, 0.0, 0.5, 0.0])),
             Note(60, 80, vec([0.0, 0.9, 0.5, 0.9, 0.0])),
             Note(140, 260, vec([0.8, 0.5, 0.2, 0.5, 0.8]), vec([0.0] * 5))]
    return Keyframes(meaning, score(notes, lead_ms=40))


AUTH_PATTERNS: dict[str, Callable[[], Keyframes]] = {"double": double, "triple": triple, "wave": wave}

# Patterns the voice tool / CLI / ABX test may request by name. Every vocabulary signature is here so it can be
# demonstrated on its own; "warning" is the original name for the stall rhythm.
TEST_PATTERNS: dict[str, Callable[[], Keyframes]] = {
    "double": lambda: double("ui.test"),
    "triple": lambda: triple("ui.test"),
    "wave": lambda: wave("ui.test"),
    "warning": lambda: drill_stall("ui.test"),
    "stall": lambda: drill_stall("ui.test"),
    "slope": lambda: slope("ui.test"),
    "breakthrough": lambda: breakthrough("ui.test"),
    "impact_left": lambda: impact("left", 1.0, "ui.test"),
    "impact_right": lambda: impact("right", 1.0, "ui.test"),
    "equipment_drill": lambda: equipment_drill("ui.test"),
    "equipment_rover": lambda: equipment_rover("ui.test"),
    "confirm": lambda: confirm("ui.test"),
    "setting_up": lambda: setting_up("ui.test"),
    "setting_down": lambda: setting_down("ui.test"),
    "denied": lambda: denied("ui.test"),
}
