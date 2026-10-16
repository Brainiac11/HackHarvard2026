"""Auto-coach: decide when the Mission Assistant should speak up unprompted (PLAN.md §10B.7)."""

from __future__ import annotations

from dataclasses import dataclass, field

STABLE_FOR_S = 1.5
COOLDOWN_S = 8.0
REPEAT_SUPPRESS_S = 30.0
QUIET_MEANINGS = {None, "rover.speed", "drill.free_spin"}  # routine sensations don't warrant a card


@dataclass
class AutoCoach:
    enabled: bool = True
    _candidate: str | None = None
    _candidate_since: float = 0.0
    _last_fired: float = -1e9
    _seen: dict[tuple, float] = field(default_factory=dict)
    _seen_alerts: set[int] = field(default_factory=set)
    _equipment_seen: set[str] = field(default_factory=set)

    def reset(self) -> None:
        self._equipment_seen.clear()
        self._seen.clear()

    def check(self, now: float, dominant: str | None, alerts: list[tuple[int, str]], equipment: str | None) -> str | None:
        """Return a trigger label if the assistant should run now, else None.

        alerts: (id, meaning) of alert events currently in the recent window (ids are stable per event).
        """
        if not self.enabled:
            return None
        new_alerts = [(i, m) for i, m in alerts if i not in self._seen_alerts]
        for i, _ in new_alerts:
            self._seen_alerts.add(i)
        if new_alerts:  # alerts bypass the cooldown
            return self._fire(now, f"auto:{new_alerts[-1][1]}", (new_alerts[-1][1], equipment), force=True)

        if equipment and equipment not in self._equipment_seen:
            self._equipment_seen.add(equipment)
            return self._fire(now, f"auto:first_use:{equipment}", ("first_use", equipment), force=True)

        if dominant != self._candidate:
            self._candidate, self._candidate_since = dominant, now
            return None
        if dominant in QUIET_MEANINGS or now - self._candidate_since < STABLE_FOR_S:
            return None
        if now - self._last_fired < COOLDOWN_S:
            return None
        return self._fire(now, f"auto:{dominant}", (dominant, equipment))

    def _fire(self, now: float, label: str, signature: tuple, force: bool = False) -> str | None:
        if not force and now - self._seen.get(signature, -1e9) < REPEAT_SUPPRESS_S:
            return None
        self._seen[signature] = now
        self._last_fired = now
        return label
