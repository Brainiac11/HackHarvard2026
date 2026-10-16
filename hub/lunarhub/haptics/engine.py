"""Haptic engine: composites effects into per-motor duty (PLAN.md §7.1).

    sim state -> mappers -> effects -> compositor (layers, ducking) -> profile shaping
              -> perceptual curve -> duty[5] (u8)

The engine is pure computation driven by `tick(dt)`; the hub runs it at 100 Hz and hands the
duty to the glove transport at 50 Hz. All randomness is seeded so tests are reproducible.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

import numpy as np

from ..protocol.messages import SimEvent, SimState
from . import patterns
from .effects import N, Effect, Keyframes
from .mappers import DrillMapper, RoverMapper

LAYER_ORDER = ("base", "event", "alert")
DUCK_FACTOR = 0.3
SILENCE_THRESHOLD = 0.03
GAMMA = 0.8
RECENT_WINDOW_S = 10.0


@dataclass
class OutputCalibration:
    """Per-motor dead zone (from bring-up §5.4) and global duty ceiling."""

    min_duty: list[int] = field(default_factory=lambda: [70] * N)
    max_duty: int = 180

    def to_duty(self, levels: np.ndarray) -> list[int]:
        out = []
        for i, x in enumerate(levels):
            if x < SILENCE_THRESHOLD:
                out.append(0)
            else:
                lo = self.min_duty[i]
                out.append(int(round(lo + (self.max_duty - lo) * min(1.0, float(x)) ** GAMMA)))
        return out


@dataclass
class HapticEvent:
    t: float
    meaning: str
    layer: str
    cause: str
    id: int = 0


@dataclass
class HapticOutput:
    levels: np.ndarray  # 0..1 after shaping and ducking
    duty: list[int]
    contributions: dict[str, float]  # meaning -> mean level across motors (before ducking)
    dominant: str | None
    alert_active: bool


@dataclass
class ShapingProfile:
    gain: float = 1.0
    motor_gain: list[float] = field(default_factory=lambda: [1.0] * N)
    warning_gain: float = 1.0
    drill: dict = field(default_factory=lambda: {"sensitivity": 1.0, "mapping": "resistance"})
    rover: dict = field(default_factory=lambda: {"vibration": 1.0, "terrain_sensitivity": 1.0,
                                                 "mapping": "split", "slope_warn_deg": 15.0})


def soft_sum(vectors: list[np.ndarray]) -> np.ndarray:
    """1 - prod(1 - x): combines overlapping sensations without exceeding 1."""
    acc = np.ones(N)
    for v in vectors:
        acc *= 1.0 - np.clip(v, 0.0, 1.0)
    return 1.0 - acc


class HapticEngine:
    def __init__(self, seed: int = 0, calibration: OutputCalibration | None = None) -> None:
        self.rng = np.random.default_rng(seed)
        self.calibration = calibration or OutputCalibration()
        self.drill = DrillMapper(np.random.default_rng(self.rng.integers(1 << 31)))
        self.rover = RoverMapper(np.random.default_rng(self.rng.integers(1 << 31)))
        self.oneshots: list[Keyframes] = []
        self.profile = ShapingProfile()
        self.active_equipment: str | None = None
        self.state = SimState()
        self.t = 0.0
        self.recent: deque[HapticEvent] = deque(maxlen=64)
        self._event_id = 0
        self.last_output = HapticOutput(np.zeros(N), [0] * N, {}, None, False)

    # ------------------------------------------------------------------ inputs
    def set_profile(self, profile: ShapingProfile | None) -> None:
        self.profile = profile or ShapingProfile()

    def set_active_equipment(self, equipment: str | None) -> None:
        self.active_equipment = equipment

    def update_state(self, state: SimState) -> None:
        self.state = state

    def on_event(self, event: SimEvent) -> None:
        if event.name == "impact" and self.active_equipment == "rover":
            self.play(patterns.impact(event.side or "left", event.mag), f"wheel impact magnitude {event.mag:.2f}")
        elif event.name == "breakthrough" and self.active_equipment == "drill":
            self.play(patterns.breakthrough(), "drill broke through the sample")

    def play(self, pattern: Keyframes, cause: str = "") -> None:
        self.oneshots.append(pattern)
        self._event_id += 1
        self.recent.append(HapticEvent(self.t, pattern.meaning, pattern.layer, cause, self._event_id))

    def stop_all(self) -> None:
        self.oneshots.clear()

    # ------------------------------------------------------------------ tick
    def tick(self, dt: float) -> HapticOutput:
        self.t += dt
        s, p = self.state, self.profile
        self.drill.update(s.drill, float(p.drill.get("sensitivity", 1.0)), p.drill.get("mapping", "resistance"),
                          self.active_equipment == "drill" and s.mode == "drill", dt, self.play)
        self.rover.update(s.rover, s.terrain, p.rover, self.active_equipment == "rover" and s.mode == "rover",
                          dt, self.play)

        effects: list[Effect] = [*self.drill.effects, *self.rover.effects, *self.oneshots]
        by_layer: dict[str, list[np.ndarray]] = {k: [] for k in LAYER_ORDER}
        contributions: dict[str, float] = {}
        for e in effects:
            v = e.sample(self.t, dt)
            if e.layer == "alert":
                v = v * p.warning_gain
            if not np.any(v):
                continue
            by_layer[e.layer].append(v)
            contributions[e.meaning] = contributions.get(e.meaning, 0.0) + float(np.mean(v))
        # an alert stays active through its silent gaps, so the base layer stays ducked and the rhythm reads clearly
        alert_active = any(o.alive and o.layer == "alert" for o in self.oneshots)
        self.oneshots = [o for o in self.oneshots if o.alive]
        combined = []
        for layer in LAYER_ORDER:
            if not by_layer[layer]:
                continue
            v = soft_sum(by_layer[layer])
            if alert_active and layer != "alert":
                v = v * DUCK_FACTOR
            combined.append(v)
        levels = soft_sum(combined) if combined else np.zeros(N)
        levels = np.clip(levels * p.gain * np.asarray(p.motor_gain, dtype=float), 0.0, 1.0)

        dominant = max(contributions, key=contributions.get) if contributions else None
        self.last_output = HapticOutput(levels, self.calibration.to_duty(levels), contributions, dominant,
                                        alert_active)
        return self.last_output

    # ------------------------------------------------------------------ introspection
    def snapshot(self) -> dict:
        """What the glove is rendering right now, for the HUD and the Mission Assistant."""
        out = self.last_output
        return {
            "dominant": out.dominant,
            "levels": {k: round(v, 3) for k, v in sorted(out.contributions.items(), key=lambda kv: -kv[1])},
            "duty": out.duty,
            "alert_active": out.alert_active,
            "recent": [
                {"id": e.id, "meaning": e.meaning, "layer": e.layer, "cause": e.cause,
                 "t_ago_s": round(self.t - e.t, 2)}
                for e in self.recent if self.t - e.t <= RECENT_WINDOW_S
            ],
        }
