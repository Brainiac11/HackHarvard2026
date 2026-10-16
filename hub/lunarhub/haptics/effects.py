"""Haptic effects: small stateful generators that produce a 5-vector of intensities (0..1) per tick.

Motor order everywhere: thumb, index, middle, ring, pinky.
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
    """Independent random on/off bursts per motor: the 'gritty' texture of hard material."""

    meaning: str
    rng: np.random.Generator
    level: float = 0.0
    burst_hz: float = 14.0
    jitter: float = 0.5
    mask: np.ndarray = field(default_factory=lambda: ALL.copy())
    layer: str = "base"
    alive: bool = True
    _remaining: np.ndarray = field(default_factory=lambda: np.zeros(N))
    _on: np.ndarray = field(default_factory=lambda: np.zeros(N, dtype=bool))
    _amp: np.ndarray = field(default_factory=lambda: np.zeros(N))

    def sample(self, t: float, dt: float) -> np.ndarray:
        self._remaining -= dt
        expired = self._remaining <= 0
        if expired.any() and self.burst_hz > 0:
            k = int(expired.sum())
            half_period = 0.5 / self.burst_hz
            self._remaining[expired] = half_period * (1 + self.jitter * self.rng.uniform(-1, 1, k))
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


@dataclass
class Keyframes(Effect):
    """One-shot pattern: a list of (duration_ms, 5-vector) steps, optionally with a linear decay."""

    meaning: str
    steps: list[tuple[float, np.ndarray]]
    layer: str = "event"
    gain: float = 1.0
    decay: bool = False
    _elapsed: float = 0.0
    alive: bool = True

    @property
    def duration_s(self) -> float:
        return sum(d for d, _ in self.steps) / 1000.0

    def sample(self, t: float, dt: float) -> np.ndarray:
        if not self.alive:
            return np.zeros(N)
        pos = self._elapsed * 1000.0
        self._elapsed += dt
        acc = 0.0
        for dur, v in self.steps:
            if pos < acc + dur:
                scale = 1.0 - (pos - acc) / dur if self.decay else 1.0
                return self.gain * scale * v
            acc += dur
        self.alive = False
        return np.zeros(N)
