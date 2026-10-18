"""Haptic effects: small stateful generators that produce a 5-vector of intensities (0..1) per tick.

Motor order everywhere: thumb, index, middle, ring, pinky.

One-shot patterns are written as a score of `Note`s (built with `pulses` / `sequence`) and rendered by `score()`
into the `Step`s a `Keyframes` effect plays. Durations are multiples of the engine's 10 ms tick.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Sequence

import numpy as np

N = 5
ALL = np.ones(N)
LEFT = np.array([1.0, 1.0, 0.0, 0.0, 0.0])  # thumb + index
CENTER = np.array([0.0, 0.0, 1.0, 0.0, 0.0])
RIGHT = np.array([0.0, 0.0, 0.0, 1.0, 1.0])  # ring + pinky
TRIGGER = np.array([0.0, 1.0, 1.0, 0.0, 0.0])  # index + middle
GRIP = np.array([0.0, 1.0, 1.0, 1.0, 0.0])  # index + middle + ring: the fingers that close around a handle
EDGES = LEFT + RIGHT  # both sides of the hand, middle finger silent
FINGER = np.eye(N)  # FINGER[i]: one motor
NO_ACCENT = np.zeros(N, dtype=bool)
MAX_ACCENT_MS = 60.0  # an overdriven accent is a transient: the engine's ThermalBudget enforces the same limit


def vec(values: Sequence[float]) -> np.ndarray:
    arr = np.asarray(values, dtype=float)
    if arr.shape != (N,):
        raise ValueError(f"expected {N} values")
    return arr


class Effect:
    """Interface. Subclasses (dataclasses) define `meaning`, `layer` and `alive`.

    Declares no attributes itself: dataclasses would inherit them as field defaults.
    """

    def sample(self, t: float, dt: float) -> np.ndarray:  # pragma: no cover - interface
        raise NotImplementedError


@dataclass
class Hum(Effect):
    """Steady level with gentle amplitude modulation."""

    meaning: str
    level: float = 0.0
    mod_hz: float = 4.0
    depth: float = 0.1
    mask: np.ndarray = field(default_factory=lambda: ALL.copy())
    layer: str = "base"
    alive: bool = True
    _phase: float = 0.0

    def sample(self, t: float, dt: float) -> np.ndarray:
        self._phase = (self._phase + dt * self.mod_hz) % 1.0
        mod = 1.0 - self.depth + self.depth * 0.5 * (1.0 + math.sin(2 * math.pi * self._phase))
        return self.level * mod * self.mask


@dataclass
class Abrasive(Effect):
    """Random on/off bursts: the 'gritty' texture of hard material.

    `sync` switches every motor on one shared clock (with its own random amplitude), which reads as grinding jolts;
    independent per-motor timing reads as a finer fizz. Keep `burst_hz` <= ~12: an ERM needs 30-50 ms to spin up or
    down, so faster bursts smear into a plain buzz.
    """

    meaning: str
    rng: np.random.Generator
    level: float = 0.0
    burst_hz: float = 10.0
    jitter: float = 0.5
    sync: bool = False
    mask: np.ndarray = field(default_factory=lambda: ALL.copy())
    layer: str = "base"
    alive: bool = True
    _remaining: np.ndarray = field(default_factory=lambda: np.zeros(N))
    _on: np.ndarray = field(default_factory=lambda: np.zeros(N, dtype=bool))
    _amp: np.ndarray = field(default_factory=lambda: np.zeros(N))

    def sample(self, t: float, dt: float) -> np.ndarray:
        self._remaining -= dt
        expired = self._remaining <= 0
        if self.sync:
            expired[:] = expired[0]
        if expired.any() and self.burst_hz > 0:
            k = int(expired.sum())
            half_period = 0.5 / self.burst_hz
            jitter = self.rng.uniform(-1, 1, 1 if self.sync else k)
            self._remaining[expired] = half_period * (1 + self.jitter * jitter)
            self._on[expired] = ~self._on[expired]
            self._amp[expired] = self.rng.uniform(0.4, 1.0, k)
        return self.level * np.where(self._on, self._amp, 0.0) * self.mask


@dataclass
class Poisson(Effect):
    """Sparse random spikes (terrain texture). Each spike lasts width_ms on the masked motors."""

    meaning: str
    rng: np.random.Generator
    rate_hz: float = 0.0
    amp: float = 0.0
    width_ms: float = 35.0
    mask: np.ndarray = field(default_factory=lambda: ALL.copy())
    layer: str = "base"
    alive: bool = True
    _until: float = -1.0
    _spike_amp: float = 0.0

    def sample(self, t: float, dt: float) -> np.ndarray:
        if t >= self._until and self.rate_hz > 0 and self.rng.random() < 1.0 - math.exp(-self.rate_hz * dt):
            self._until = t + self.width_ms / 1000.0
            self._spike_amp = self.amp * self.rng.uniform(0.6, 1.0)
        return (self._spike_amp if t < self._until else 0.0) * self.mask


@dataclass(frozen=True, eq=False)
class Step:
    """One keyframe: `ms` long, ramping linearly from `level` to `end` (5-vectors; `end` None = hold `level`).

    `accent` marks the motors the engine may overdrive above the sustained duty ceiling during this step (a
    transient for a crisp attack; ERMs take 30-50 ms to spin up). `hush` silences the layers below this one, so the
    glove is truly quiet before an accent or between alert beats.
    """

    ms: float
    level: np.ndarray
    end: np.ndarray | None = None
    accent: np.ndarray = field(default_factory=lambda: NO_ACCENT)
    hush: bool = False


@dataclass
class Keyframes(Effect):
    """One-shot pattern: a list of `Step`s (or legacy `(duration_ms, 5-vector)` tuples).

    `decay` (legacy) fades every step that has no `end` linearly to 0. While playing, `accent` and `hushing` report
    the current step's flags to the engine.
    """

    meaning: str
    steps: list[Step]
    layer: str = "event"
    gain: float = 1.0
    decay: bool = False
    _elapsed: float = 0.0
    alive: bool = True
    accent: np.ndarray = field(default_factory=lambda: NO_ACCENT)
    hushing: bool = False

    def __post_init__(self) -> None:
        self.steps = [s if isinstance(s, Step) else Step(float(s[0]), vec(s[1])) for s in self.steps]

    @property
    def duration_s(self) -> float:
        return sum(s.ms for s in self.steps) / 1000.0

    def sample(self, t: float, dt: float) -> np.ndarray:
        if not self.alive:
            return np.zeros(N)
        pos = self._elapsed * 1000.0 + 1e-6  # summed dt drifts just below step boundaries: 0.01*14 -> 139.99999
        self._elapsed += dt
        acc = 0.0
        for s in self.steps:
            if pos < acc + s.ms:
                end = s.end if s.end is not None else (0.0 * s.level if self.decay else s.level)
                f = (pos - acc) / s.ms
                self.accent, self.hushing = s.accent, s.hush
                return self.gain * (s.level + (end - s.level) * f)
            acc += s.ms
        self.alive, self.accent, self.hushing = False, NO_ACCENT, False
        return np.zeros(N)


# ---------------------------------------------------------------- pattern building blocks

@dataclass(frozen=True, eq=False)
class Note:
    """`level` on some motors from `at` for `ms` (ms), optionally ramping to `end`. The first `accent_ms` may be
    overdriven. Notes may overlap (they add, clipped to 1): `score()` renders them into `Step`s."""

    at: float
    ms: float
    level: np.ndarray
    end: np.ndarray | None = None
    accent_ms: float = 0.0

    def value(self, t: float) -> np.ndarray:
        if self.end is None:
            return self.level
        return self.level + (self.end - self.level) * (t - self.at) / self.ms


def _per(value: float | Sequence[float], n: int) -> list[float]:
    return list(value) if isinstance(value, Sequence) else [float(value)] * n


def sequence(masks: Sequence[np.ndarray], ms: float | Sequence[float], level: float | Sequence[float] = 1.0,
             gap_ms: float = 0.0, overlap_ms: float = 0.0, at: float = 0.0, accent_ms: float = 0.0,
             end: float | Sequence[float] | None = None) -> list[Note]:
    """Notes one after another, one per mask: sweeps (single fingers), alternations (groups) and pulse trains.

    `ms`, `level` and `end` may be per-note sequences, for accelerating rhythms and crescendos. Each note starts
    `gap_ms` after the previous one ends; a negative gap (`overlap_ms`) makes a legato sweep, which reads as smoother
    motion across the fingers than discrete hops.
    """
    n = len(masks)
    durs, levels = _per(ms, n), _per(level, n)
    ends = _per(end, n) if end is not None else [None] * n
    notes, t = [], at
    for mask, d, lv, e in zip(masks, durs, levels, ends):
        mask = np.asarray(mask, dtype=float)
        notes.append(Note(t, d, lv * mask, None if e is None else e * mask, min(accent_ms, d)))
        t += d + gap_ms - overlap_ms
    return notes


def pulses(mask: np.ndarray, count: int, on_ms: float, off_ms: float, level: float | Sequence[float] = 1.0,
           at: float = 0.0, accent_ms: float = 0.0, end: float | Sequence[float] | None = None) -> list[Note]:
    """A pulse train on one group of motors: rhythm by count, on/off time and per-pulse level."""
    return sequence([mask] * count, on_ms, level, gap_ms=off_ms, at=at, accent_ms=accent_ms, end=end)


def score(notes: Sequence[Note], lead_ms: float = 0.0, tail_ms: float = 0.0, hush_gaps: bool = False) -> list[Step]:
    """Render overlapping notes into consecutive Steps (piecewise linear, so ramps stay exact).

    `lead_ms` / `tail_ms` add silence before / after that also hushes the layers below; `hush_gaps` does the same
    for every silent gap inside the score (alerts: true silence between beats keeps the rhythm countable).
    """
    for nt in notes:
        if nt.accent_ms > MAX_ACCENT_MS:
            raise ValueError(f"accent {nt.accent_ms} ms > {MAX_ACCENT_MS} ms")
    cuts = sorted({0.0, *(nt.at for nt in notes), *(nt.at + nt.ms for nt in notes),
                   *(nt.at + nt.accent_ms for nt in notes if nt.accent_ms)})
    steps = [Step(lead_ms, np.zeros(N), hush=True)] if lead_ms > 0 else []
    for a, b in zip(cuts, cuts[1:]):
        live = [nt for nt in notes if nt.at <= a and b <= nt.at + nt.ms]
        start = np.clip(sum((nt.value(a) for nt in live), np.zeros(N)), 0.0, 1.0)
        stop = np.clip(sum((nt.value(b) for nt in live), np.zeros(N)), 0.0, 1.0)
        accent = np.zeros(N, dtype=bool)
        for nt in live:
            if a < nt.at + nt.accent_ms:
                accent |= nt.level > 0
        silent = not live or (not start.any() and not stop.any())
        steps.append(Step(b - a, start, None if np.allclose(start, stop) else stop, accent, hush_gaps and silent))
    if tail_ms > 0:
        steps.append(Step(tail_ms, np.zeros(N), hush=True))
    return steps
