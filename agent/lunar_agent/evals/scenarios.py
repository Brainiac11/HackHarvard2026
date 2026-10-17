"""Synthetic, auto-labelled eval scenarios (PLAN.md §10B.6, dataset `lh-synthetic`).

Each scenario drives the REAL hub haptic engine (imported from lunarhub) with a sim state for a few seconds,
samples REAL LOLA terrain cells, and builds the context with the hub's own `context_from_parts`. Labels come
from the deterministic rules (analysis.derive): the feeling label is what the engine actually rendered.

Requires the hub environment:  uv run --project hub python -m lunar_agent.evals.build_dataset
"""

from __future__ import annotations

import json
import math
import random
from dataclasses import dataclass, field
from pathlib import Path

from lunarhub.assistant.context import context_from_parts
from lunarhub.haptics.engine import HapticEngine
from lunarhub.profiles.store import Profile
from lunarhub.protocol.messages import DrillState, RoverState, SimEvent, SimState, TerrainState, Wheel
from lunarhub.terrain import TerrainGrid

from ..analysis import derive
from ..schema import ContextPacket

ROOT = Path(__file__).resolve().parents[3]
TERRAIN_DIR = ROOT / "sim" / "public" / "terrain" / "site04"


def make_profile(rng: random.Random) -> Profile:
    limit = rng.choice([10, 12, 15, 15, 18])
    name, callsign = rng.choice([("Cmdr. Ana Rivera", "HAWK"), ("Spc. Daniel Okafor", "ATLAS"),
                                 ("Dr. Mei Tanaka", "ORBIT")])
    return Profile.model_validate({
        "id": callsign.lower(), "name": name, "callsign": callsign,
        "global": {"gain": 1.0, "warning_gain": rng.choice([1.0, 1.2])},
        "equipment": {"drill": {"sensitivity": rng.choice([0.8, 1.0, 1.3]),
                                "mapping": rng.choice(["resistance", "localized"])},
                      "rover": {"vibration": rng.choice([0.6, 1.0]), "terrain_sensitivity": rng.choice([1.0, 1.5]),
                                "mapping": rng.choice(["split", "uniform"]), "slope_warn_deg": limit}},
    })


@dataclass
class Spec:
    state: SimState
    active: str | None
    authorized: list[str]
    near: str | None
    seconds: float = 2.0
    events: list[tuple[float, SimEvent]] = field(default_factory=list)  # (time, event)
    with_profile: bool = True


class TerrainPicker:
    """Random real LOLA cells satisfying slope conditions (relative to a slope limit)."""

    def __init__(self, grid: TerrainGrid, rng: random.Random) -> None:
        self.grid, self.rng = grid, rng
        self.half = grid.extent / 2 - 60

    def pick(self, cond, tries: int = 4000) -> tuple[float, float, float]:
        for _ in range(tries):
            x, z = self.rng.uniform(-self.half, self.half), self.rng.uniform(-self.half, self.half)
            heading = self.rng.uniform(0, 360)
            here = self.grid.sample(x, z)
            ahead = self.grid.lookahead(x, z, heading)
            if cond(here, ahead):
                return x, z, heading
        raise RuntimeError("no terrain cell satisfies the condition")


def _wheels(left: float, right: float, rng: random.Random) -> list[Wheel]:
    j = lambda v: max(0.0, v + rng.uniform(-0.05, 0.05))  # noqa: E731
    return [Wheel(vel=j(left)), Wheel(vel=j(right)), Wheel(vel=j(left)), Wheel(vel=j(right))]


def recipes(rng: random.Random, tp: TerrainPicker, limit: float) -> dict[str, callable]:
    def drill(hardness, trigger=1.0, contact=True, stalled=False, held=True, seconds=2.0, events=()):
        d = DrillState(held=held, trigger=trigger, contact=contact, hardness=hardness, stalled=stalled,
                       target=("hard" if hardness >= 0.5 else "soft") if contact else None,
                       depth_m=rng.uniform(0, 0.05) if contact else 0.0,
                       rate_mps=0.02 * trigger * (1 - hardness) ** 2 if contact else 0.0)
        return Spec(SimState(mode="drill", near="drill", drill=d), "drill", ["drill"], "drill", seconds, list(events))

    def rover(cond, speed, rough=0.1, left=0.1, right=0.1, events=(), seconds=2.0):
        x, z, h = tp.pick(cond)
        st = SimState(mode="rover", near="rover",
                      rover=RoverState(speed=speed, rough=rough, heading_deg=h, wheels=_wheels(left, right, rng),
                                       pitch_deg=rng.uniform(-4, 4), roll_deg=rng.uniform(-4, 4)),
                      terrain=TerrainState(x=x, z=z, synthetic_detail=True))
        st.terrain.lola_slope_deg = tp.grid.sample(x, z)["lola_slope_deg"]
        return Spec(st, "rover", ["rover"], "rover", seconds, list(events))

    safe = lambda here, ahead: here["lola_slope_deg"] < limit - 2 and ahead.max_slope_deg < limit - 1  # noqa: E731
    steep_here = lambda here, ahead: here["lola_slope_deg"] > limit + 0.5  # noqa: E731
    steep_ahead = lambda here, ahead: here["lola_slope_deg"] < limit - 2 and ahead.max_slope_deg > limit + 1  # noqa: E731
    impact = lambda side, t: (t, SimEvent(name="impact", mag=rng.uniform(0.4, 1.0), side=side))  # noqa: E731

    return {
        "walk": lambda: Spec(SimState(mode="walk"), None, [], None, 1.0),
        "not_authorized": lambda: Spec(SimState(mode="walk", near=(n := rng.choice(["drill", "rover"]))), None, [],
                                       n, 1.0),
        "equipment_ready": lambda: Spec(SimState(mode="walk", near=(n := rng.choice(["drill", "rover"]))), n, [n],
                                        n, 3.0),
        "no_profile": lambda: Spec(SimState(mode="walk", near=rng.choice([None, "drill"])), None, [], None, 1.0,
                                   with_profile=False),
        "drill_idle": lambda: drill(0.25, trigger=0.0, contact=False),
        "drill_free_spin": lambda: drill(0.0, trigger=rng.uniform(0.5, 1), contact=False),
        "drill_soft": lambda: drill(rng.uniform(0.15, 0.35), trigger=rng.uniform(0.6, 1)),
        "drill_hard": lambda: drill(rng.uniform(0.75, 0.95), trigger=rng.uniform(0.6, 1)),
        "drill_stall": lambda: drill(rng.uniform(0.8, 0.95), stalled=True, seconds=rng.uniform(1.2, 3.0)),
        "drill_breakthrough": lambda: drill(0.25, events=[(1.6, SimEvent(name="breakthrough", mag=1))]),
        "rover_idle": lambda: rover(safe, 0.0, rough=0.0, left=0, right=0),
        "rover_cruise": lambda: rover(safe, rng.uniform(1.0, 3.4), rough=rng.uniform(0, 0.3)),
        "rover_rough_fast": lambda: rover(safe, rng.uniform(2.6, 4.0), rough=rng.uniform(0.55, 1.0),
                                          **rng.choice([dict(left=0.9, right=0.1), dict(left=0.1, right=0.9),
                                                        dict(left=0.7, right=0.6)])),
        "rover_impacts_side": lambda: rover(safe, rng.uniform(1.5, 3.5), rough=rng.uniform(0.2, 0.6),
                                            events=[impact(s := rng.choice(["left", "right"]), 0.5),
                                                    impact(s, rng.uniform(1.0, 1.8))]),
        "rover_slope_ahead": lambda: rover(steep_ahead, rng.uniform(1.0, 3.0)),
        "rover_slope_alert": lambda: rover(steep_here, rng.uniform(0.8, 2.5), seconds=rng.uniform(0.6, 3.0)),
    }


def render(spec: Spec, profile: Profile | None, grid: TerrainGrid, seed: int) -> ContextPacket:
    engine = HapticEngine(seed=seed)
    if profile is not None:
        engine.set_profile(profile.to_shaping())
    engine.set_active_equipment(spec.active)
    engine.update_state(spec.state)
    events = sorted(spec.events, key=lambda e: e[0])
    steps = int(spec.seconds * 100)
    for i in range(steps):
        t = i / 100
        while events and events[0][0] <= t:
            engine.on_event(events.pop(0)[1])
        engine.tick(0.01)
    return context_from_parts(spec.state, engine.snapshot(), profile, spec.active, spec.authorized, spec.near, grid)


def generate(per_situation: int = 20, seed: int = 2026) -> list[dict]:
    rng = random.Random(seed)
    grid = TerrainGrid(TERRAIN_DIR)
    picker = TerrainPicker(grid, rng)
    rows = []
    situations = list(recipes(rng, picker, 15).keys())
    for situation in situations:
        made = 0
        attempts = 0
        while made < per_situation and attempts < per_situation * 5:
            attempts += 1
            profile = make_profile(rng)
            spec = recipes(rng, picker, profile.equipment.rover.slope_warn_deg)[situation]()
            ctx = render(spec, profile if spec.with_profile else None, grid, rng.randrange(1 << 30))
            row = label_row(ctx, question="", intended=situation, labeller="rules")
            if row["situation"] != situation:  # keep the dataset stratified; the label is always the rule output
                continue
            row["id"] = f"syn-{situation}-{made:02d}"
            rows.append(row)
            made += 1
    return rows


def label_row(ctx: ContextPacket, question: str, intended: str, labeller: str, **extra) -> dict:
    d = derive(ctx)
    return {
        "id": "",
        "slice": _slice(d.situation, d.requires_uncertainty),
        "situation": d.situation,
        "intended": intended,
        "context_json": ctx.model_dump_json(exclude_none=True),
        "question": question,
        "expected_feeling": d.feeling,
        "expected_hazard": d.hazard,
        "required_action_terms": json.dumps(list(d.action_terms)),
        "requires_uncertainty": d.requires_uncertainty,
        "must_not_say": json.dumps(extra.pop("must_not_say", [])),
        "reference_answer": extra.pop("reference_answer", ""),
        "labeller": labeller,
        **extra,
    }


def _slice(situation: str, uncertain: bool) -> str:
    if uncertain:
        return "interpolated_terrain"
    if situation.startswith("drill"):
        return "drill"
    if situation in ("rover_slope_alert", "drill_stall"):
        return "alerts"
    if situation.startswith("rover"):
        return "rover"
    return "identity"


def summary(rows: list[dict]) -> dict:
    out: dict[str, int] = {}
    for r in rows:
        out[r["situation"]] = out.get(r["situation"], 0) + 1
    return out


if __name__ == "__main__":
    rows = generate(per_situation=3)
    print(summary(rows))
    print(json.dumps({k: v for k, v in rows[-1].items() if k != "context_json"}, indent=1))
    _ = math  # keep import for downstream helpers
