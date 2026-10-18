"""Mappers: equipment state -> haptic effects (PLAN.md §7.3, §7.4).

Each mapper owns persistent continuous effects (base layer) whose parameters it updates every tick,
and emits one-shot patterns (events/alerts) through the `emit` callback.
"""

from __future__ import annotations

from typing import Callable

import numpy as np

from ..protocol.messages import DrillState, RoverState, TerrainState
from . import patterns
from .effects import ALL, LEFT, RIGHT, TRIGGER, Abrasive, Effect, Hum, Keyframes, Poisson

Emit = Callable[[Keyframes, str], None]  # (pattern, cause)

STALL_ALERT_AFTER_S = 0.8
ROVER_V_MAX = 4.0  # m/s used to normalise speed (demo boost included)
SLOPE_REARM_MARGIN_DEG = 2.0
SLOPE_REARM_AFTER_S = 3.0
TAP_MS = 45.0  # terrain tap length: long enough for an ERM to reach speed, short enough to stay a tap


class DrillMapper:
    """Three textures that differ in level *and* rhythm: free spin flat and faint, soft a gentle even throb, hard a
    strong irregular grind (levels go through the perceptual curve: 0.2 / ~0.45 / ~0.85 at full spindle)."""

    def __init__(self, rng: np.random.Generator) -> None:
        self.free_spin = Hum("drill.free_spin", mod_hz=0.0, depth=0.0)
        self.soft = Hum("drill.soft", mod_hz=2.0, depth=0.4)  # a slow throb: half the rover rumble's slowest
        self.hard_base = Hum("drill.hard", mod_hz=0.0, depth=0.0)
        self.hard_grit = Abrasive("drill.hard", rng, jitter=0.6, sync=True)
        self._stall_time = 0.0
        self._stall_alerted = False

    @property
    def effects(self) -> list[Effect]:
        return [self.free_spin, self.soft, self.hard_base, self.hard_grit]

    def update(self, d: DrillState, sensitivity: float, mapping: str, active: bool, dt: float, emit: Emit) -> None:
        for e in self.effects:
            e.level = 0.0
        if not (active and d.held):
            self._stall_time, self._stall_alerted = 0.0, False
            return
        mask = ALL.copy() if mapping == "resistance" else TRIGGER + 0.3 * (ALL - TRIGGER)
        for e in self.effects:
            e.mask = mask
        trig = d.trigger
        if trig <= 0.02:
            pass
        elif not d.contact:
            self.free_spin.level = 0.2 * trig * sensitivity  # barely there: just above the dead zone
        else:
            h = d.hardness
            if h < 0.5:
                self.soft.level = (0.45 + 0.13 * trig) * sensitivity  # throbs 0.35..0.58 at full spindle
            else:
                # grinding jolts on a strong floor: basalt (0.9) jumps 0.72 <-> 0.83..0.99 at ~9.5 Hz, irregularly
                self.hard_base.level = (0.45 + 0.3 * h) * trig * sensitivity
                self.hard_grit.level = (0.6 + 0.4 * h) * trig * sensitivity
                self.hard_grit.burst_hz = 5.0 + 5.0 * h

        if d.stalled and d.contact and trig > 0.5:
            self._stall_time += dt
            if self._stall_time >= STALL_ALERT_AFTER_S and not self._stall_alerted:
                self._stall_alerted = True
                emit(patterns.drill_stall(), "drill bit not advancing in hard material")
        else:
            self._stall_time, self._stall_alerted = 0.0, False


class RoverMapper:
    """A periodic rumble for speed (smooth, throbbing faster as it rises) under sparse random taps for terrain."""

    def __init__(self, rng: np.random.Generator) -> None:
        self.speed = Hum("rover.speed", mod_hz=4.0, depth=0.3)
        self.left = Poisson("rover.terrain_left", rng, width_ms=TAP_MS, mask=LEFT)
        self.right = Poisson("rover.terrain_right", np.random.default_rng(rng.integers(1 << 31)), width_ms=TAP_MS,
                             mask=RIGHT)
        self.both = Poisson("rover.terrain", np.random.default_rng(rng.integers(1 << 31)), width_ms=TAP_MS,
                            mask=ALL.copy())
        self._slope_alerted = False
        self._below_time = 0.0

    @property
    def effects(self) -> list[Effect]:
        return [self.speed, self.left, self.right, self.both]

    def update(self, r: RoverState, terrain: TerrainState, settings: dict, active: bool, dt: float,
               emit: Emit) -> None:
        self.speed.level = 0.0
        for p in (self.left, self.right, self.both):
            p.rate_hz, p.amp = 0.0, 0.0
        if not active:
            self._slope_alerted, self._below_time = False, 0.0
            return

        a = float(settings.get("vibration", 1.0))
        k = float(settings.get("terrain_sensitivity", 1.0))
        vn = min(1.0, abs(r.speed) / ROVER_V_MAX)
        if vn > 0.01:
            # crawl ~0.2 (just felt) .. 0.7 at v_max: the top stays low enough for terrain taps to stand out on it
            self.speed.level = a * (0.1 + 0.6 * vn ** 0.8)
            self.speed.mod_hz = 4.0 + 6.0 * vn  # 4 Hz at a crawl to 10 Hz flat out

        rough = r.rough
        if rough > 0.02 and vn > 0.01:
            rate = 3.0 + 22.0 * rough  # a few taps a second on gravel, a dense rattle on boulders
            amp = k * (0.35 + 0.65 * rough)
            if settings.get("mapping", "split") == "split" and len(r.wheels) >= 4:
                left_e = float(np.sqrt(np.mean([r.wheels[0].vel ** 2, r.wheels[2].vel ** 2])))
                right_e = float(np.sqrt(np.mean([r.wheels[1].vel ** 2, r.wheels[3].vel ** 2])))
                total = left_e + right_e
                lw, rw = (0.5, 0.5) if total < 1e-6 else (left_e / total, right_e / total)
                self.left.rate_hz, self.left.amp = rate * (0.4 + lw), amp * min(1.0, 2 * lw)
                self.right.rate_hz, self.right.amp = rate * (0.4 + rw), amp * min(1.0, 2 * rw)
            else:
                self.both.rate_hz, self.both.amp = rate, amp

        limit = float(settings.get("slope_warn_deg", 15.0))
        slope = terrain.lola_slope_deg
        if slope is not None:
            if slope > limit and not self._slope_alerted:
                self._slope_alerted, self._below_time = True, 0.0
                emit(patterns.slope(),
                     f"LOLA slope {slope:.1f} deg exceeds personal limit {limit:.0f} deg")
            elif self._slope_alerted and slope < limit - SLOPE_REARM_MARGIN_DEG:
                self._below_time += dt
                if self._below_time >= SLOPE_REARM_AFTER_S:
                    self._slope_alerted = False
            else:
                self._below_time = 0.0
