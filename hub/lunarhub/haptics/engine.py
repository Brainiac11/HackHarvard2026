"""Haptic engine: composites effects into per-motor duty (PLAN.md §7.1).

    sim state -> mappers -> effects -> compositor (layers, ducking, hush) -> profile shaping
              -> perceptual curve -> accents -> thermal budget -> duty[5] (u8)

The engine is pure computation driven by `tick(dt)`; the hub runs it at 100 Hz and hands the
duty to the glove transport at 50 Hz. All randomness is seeded so tests are reproducible.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from itertools import islice

import numpy as np

from ..protocol.messages import SimEvent, SimState
from . import patterns
from .effects import N, Effect, Keyframes
from .mappers import DrillMapper, RoverMapper

LAYER_ORDER = ("base", "event", "alert")
DUCK = {"event": 0.4, "alert": 0.1}  # a playing one-shot scales the layers below it by this
DUCK_RELEASE_S = 0.15  # ducked layers fade back in over this long, so a pattern's end stays clear of the base
SILENCE_THRESHOLD = 0.03
RECENT_WINDOW_S = 10.0
ACCENT_DUTY = 230  # = the firmware's stiction kick duty (firmware/glove/src/config.h DEFAULT_KICK_DUTY)


@dataclass
class OutputCalibration:
    """Per-motor dead zone (from bring-up §5.4) and the sustained duty ceiling.

    Perceptual curve: an ERM's speed, and so its vibration frequency, rises with voltage and its acceleration with
    speed squared, while the skin's acceleration threshold is roughly flat over an ERM's ~70-200 Hz. So felt strength
    in dB ~ 40·log10(duty), and equal level steps should be equal duty *ratios*: duty = min·(max/min)^level. Quiet
    levels sit just above each motor's dead zone and the top of the range climbs steeply (16 dB from 70 to 180).
    """

    min_duty: list[int] = field(default_factory=lambda: [70] * N)
    max_duty: int = 180

    def to_duty(self, levels: np.ndarray) -> list[int]:
        out = []
        for i, x in enumerate(levels):
            if x < SILENCE_THRESHOLD:
                out.append(0)
            else:
                lo = max(1, min(self.min_duty[i], self.max_duty))
                out.append(int(round(lo * (self.max_duty / lo) ** min(1.0, float(x)))))
        return out


@dataclass
class ThermalBudget:
    """Lets short accents exceed the sustained ceiling while the rolling average of every motor stays under it.

    Guarantee: over any `window_ticks` (0.5 s at the 100 Hz tick), the mean duty a motor can actually receive is
    <= `ceiling`. A motor may keep a duty for up to `hold_ticks` (the hub sends every 2nd tick, and an ESPcmd write
    with response can take two 15 ms connection intervals), so each tick is charged the max of the last
    `hold_ticks` duties, and a duty is granted only if every window it can still reach fits even if the motor then
    goes silent. Silence always fits, so the budget can never wedge. Accents above the ceiling are also capped at
    `peak`, `max_run_ticks` long, with as long a rest before the next one. In practice accents are pre-paid by the
    hushed lead-in and gaps around them; a request <= ceiling is only trimmed right after an accent on a motor that
    then stays near the ceiling.
    """

    ceiling: int = 180
    peak: int = ACCENT_DUTY
    window_ticks: int = 50
    max_run_ticks: int = 6
    hold_ticks: int = 5

    def __post_init__(self) -> None:
        if not 1 <= self.hold_ticks < self.window_ticks:
            raise ValueError("need 1 <= hold_ticks < window_ticks")
        self.peak = max(self.peak, self.ceiling)  # a calibration above 230 just leaves no room for accents
        self._charged = [deque([0] * (self.window_ticks - 1), maxlen=self.window_ticks - 1) for _ in range(N)]
        self._sum = [0] * N
        self._recent = [deque([0] * (self.hold_ticks - 1), maxlen=self.hold_ticks - 1) for _ in range(N)]
        self._run = [0] * N
        self._rest = [0] * N

    def _fits(self, i: int, d: int) -> bool:
        """Do the windows ending now and in the next hold_ticks-1 ticks fit if the motor gets d, then silence?"""
        limit = self.ceiling * self.window_ticks
        past = list(self._recent[i])  # duties of the last hold_ticks-1 ticks, oldest first
        oldest = list(islice(self._charged[i], self.hold_ticks))
        before, ahead = self._sum[i], 0
        for j in range(self.hold_ticks):
            ahead += max([d, *past[j:]])  # what tick now+j may still be holding
            if before + ahead > limit:
                return False
            before -= oldest[j]  # the next window starts one tick later
        return True

    def apply(self, request: list[int]) -> list[int]:
        out = []
        for i, r in enumerate(request):
            accent_ok = self._run[i] < self.max_run_ticks and self._rest[i] == 0
            d = max(0, min(int(r), self.peak if accent_ok else self.ceiling))
            if not self._fits(i, d):
                lo, hi = 0, d - 1
                while lo < hi:
                    mid = (lo + hi + 1) // 2
                    lo, hi = (mid, hi) if self._fits(i, mid) else (lo, mid - 1)
                d = lo
            charged = max([d, *self._recent[i]])
            self._sum[i] += charged - self._charged[i][0]
            self._charged[i].append(charged)
            self._recent[i].append(d)
            if d > self.ceiling:
                self._run[i] += 1
            else:
                self._rest[i] = self.max_run_ticks if self._run[i] else max(0, self._rest[i] - 1)
                self._run[i] = 0
            out.append(d)
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
        self.budget = ThermalBudget(ceiling=self.calibration.max_duty)
        self._duck = {layer: 1.0 for layer in LAYER_ORDER}
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
        self.oneshots = [o for o in self.oneshots if o.alive]
        # a one-shot ducks the layers below it for its whole length (gaps included, so its rhythm reads clearly) and
        # mutes them during its hushed steps; when it ends they fade back in
        target = {layer: 1.0 for layer in LAYER_ORDER}
        accent = np.zeros(N, dtype=bool)
        for o in self.oneshots:
            for lower in LAYER_ORDER[:LAYER_ORDER.index(o.layer)]:
                target[lower] = min(target[lower], 0.0 if o.hushing else DUCK[o.layer])
            accent = accent | o.accent
        combined = []
        for layer in LAYER_ORDER:
            g = self._duck[layer]
            self._duck[layer] = g = target[layer] if target[layer] < g else min(target[layer], g + dt / DUCK_RELEASE_S)
            if by_layer[layer]:
                combined.append(soft_sum(by_layer[layer]) * g)
        alert_active = any(o.layer == "alert" for o in self.oneshots)
        levels = soft_sum(combined) if combined else np.zeros(N)
        levels = np.clip(levels * p.gain * np.asarray(p.motor_gain, dtype=float), 0.0, 1.0)

        duty = self.calibration.to_duty(levels)
        top = self.calibration.max_duty
        # an accented motor is overdriven in proportion (full level -> ACCENT_DUTY) for a crisp attack, if the
        # thermal budget allows; everything else stays at or below the sustained ceiling
        request = [max(d, min(ACCENT_DUTY, round(d * ACCENT_DUTY / top))) if a else d for d, a in zip(duty, accent)]
        dominant = max(contributions, key=contributions.get) if contributions else None
        self.last_output = HapticOutput(levels, self.budget.apply(request), contributions, dominant, alert_active)
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
