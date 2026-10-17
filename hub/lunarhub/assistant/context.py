"""Build the Mission Assistant's ContextPacket from live hub state (PLAN.md §10B.7).

`context_from_parts` is also used by the eval scenario generator, so eval contexts are built by exactly the
same code as production contexts.
"""

from __future__ import annotations

import math

from lunar_agent.schema import ContextPacket

from ..haptics.engine import HapticEngine
from ..mission.state import MissionState
from ..profiles.store import Profile
from ..protocol.messages import SimState
from ..terrain import TerrainGrid


def context_from_parts(state: SimState, snapshot: dict, profile: Profile | None, active: str | None,
                       authorized: list[str], near: str | None, terrain: TerrainGrid | None) -> ContextPacket:
    wheels = state.rover.wheels
    left = math.sqrt((wheels[0].vel ** 2 + wheels[2].vel ** 2) / 2) if len(wheels) >= 4 else 0.0
    right = math.sqrt((wheels[1].vel ** 2 + wheels[3].vel ** 2) / 2) if len(wheels) >= 4 else 0.0

    terrain_ctx: dict = {"synthetic_detail": state.terrain.synthetic_detail}
    if terrain is not None:
        x, z = state.terrain.x, state.terrain.z
        here = terrain.sample(x, z)
        lat, lon = terrain.latlon(x, z)
        ahead = terrain.lookahead(x, z, state.rover.heading_deg)
        terrain_ctx.update(
            lat=lat, lon=lon, elev_m=here["elev_m"], lola_slope_deg=here["lola_slope_deg"],
            lola_slope_err_deg=here["lola_slope_err_deg"], measured=here["coverage"] > 0,
            lookahead_distance_m=ahead.distance_m, lookahead_max_slope_deg=ahead.max_slope_deg,
            lookahead_max_slope_err_deg=ahead.max_slope_err_deg, lookahead_at_m=ahead.at_distance_m,
            lookahead_max_measured=ahead.max_cover > 0,
        )

    return ContextPacket.model_validate({
        "mode": state.mode,
        "active_equipment": active,
        "authorized": sorted(authorized),
        "near": near,
        "profile": None if profile is None else {
            "name": profile.name, "callsign": profile.callsign,
            "slope_warn_deg": profile.equipment.rover.slope_warn_deg,
            "drill_sensitivity": profile.equipment.drill.sensitivity,
            "rover_vibration": profile.equipment.rover.vibration,
            "terrain_sensitivity": profile.equipment.rover.terrain_sensitivity,
            "warning_intensity": profile.global_.warning_gain,
        },
        "haptics": snapshot,
        "drill": state.drill.model_dump(),
        "rover": {"speed_mps": state.rover.speed, "rough": state.rover.rough, "pitch_deg": state.rover.pitch_deg,
                  "roll_deg": state.rover.roll_deg, "heading_deg": state.rover.heading_deg,
                  "left_bump": round(left, 3), "right_bump": round(right, 3)},
        "terrain": terrain_ctx,
    })


def build_context(mission: MissionState, engine: HapticEngine, terrain: TerrainGrid | None) -> ContextPacket:
    return context_from_parts(engine.state, engine.snapshot(), mission.profile, mission.active_equipment,
                              sorted(mission.authorized), mission.near, terrain)
