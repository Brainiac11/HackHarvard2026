"""Named one-shot haptic patterns (PLAN.md §7.2)."""

from __future__ import annotations

from typing import Callable

import numpy as np

from .effects import ALL, CENTER, LEFT, RIGHT, TRIGGER, Keyframes, N

OFF = np.zeros(N)


def _ripple(order: list[int], step_ms: float, level: float) -> list[tuple[float, np.ndarray]]:
    steps = []
    for i in order:
        v = np.zeros(N)
        v[i] = level
        steps.append((step_ms, v))
    return steps


def double(meaning: str = "ui.auth") -> Keyframes:
    return Keyframes(meaning, [(80, 0.9 * ALL), (90, OFF), (80, 0.9 * ALL)])


def triple(meaning: str = "ui.auth") -> Keyframes:
    return Keyframes(meaning, [(60, 0.9 * ALL), (70, OFF)] * 2 + [(60, 0.9 * ALL)])


def wave(meaning: str = "ui.auth") -> Keyframes:
    return Keyframes(meaning, _ripple([0, 1, 2, 3, 4], 60, 0.85))


def equipment_drill() -> Keyframes:
    return Keyframes("ui.equipment_drill", [(150, 0.8 * TRIGGER)])


def equipment_rover() -> Keyframes:
    return Keyframes("ui.equipment_rover", [(100, 0.8 * LEFT), (100, 0.8 * RIGHT)])


def confirm() -> Keyframes:
    return Keyframes("ui.confirm", [(60, 0.7 * CENTER)])


def setting_up() -> Keyframes:
    return Keyframes("ui.setting_up", _ripple([0, 1, 2, 3, 4], 40, 0.75))


def setting_down() -> Keyframes:
    return Keyframes("ui.setting_down", _ripple([4, 3, 2, 1, 0], 40, 0.75))


def denied() -> Keyframes:
    return Keyframes("ui.denied", [(400, 0.45 * ALL)])


def warning(meaning: str) -> Keyframes:
    return Keyframes(meaning, [(150, ALL), (100, OFF)] * 2 + [(150, ALL)], layer="alert")


def impact(side: str, magnitude: float = 1.0) -> Keyframes:
    mask = LEFT if side == "left" else RIGHT
    return Keyframes(f"event.impact_{'left' if side == 'left' else 'right'}", [(120, mask)],
                     gain=max(0.3, min(1.0, magnitude)), decay=True)


def breakthrough() -> Keyframes:
    return Keyframes("event.breakthrough", [(200, 0.6 * ALL)], decay=True)


AUTH_PATTERNS: dict[str, Callable[[], Keyframes]] = {"double": double, "triple": triple, "wave": wave}

# Patterns the voice tool / CLI may request by name.
TEST_PATTERNS: dict[str, Callable[[], Keyframes]] = {
    "double": lambda: double("ui.test"),
    "triple": lambda: triple("ui.test"),
    "wave": lambda: wave("ui.test"),
    "warning": lambda: warning("ui.test"),
}
