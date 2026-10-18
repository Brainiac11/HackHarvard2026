"""Deterministic command handler for voice tool calls (PLAN.md §10.3).

The voice model can only reach the system through here. Every argument is validated; state changes
go through MissionState / ProfileStore, and the result is a JSON-serialisable dict the model reads.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Protocol

from ..haptics import patterns
from ..haptics.engine import HapticEngine
from ..mission.state import MissionState, Outcome
from ..profiles.store import ProfileStore, SettingError
from ..terrain import TerrainGrid
from .tools import EQUIPMENT_ENUM, TEST_PATTERN_ENUM, TOOL_NAMES

STEP_FACTOR = 1.25
SLOPE_STEP_DEG = 2.0
# which equipment each setting belongs to (lets us correct a wrong `equipment` argument from the model)
SETTING_HOME = {
    "sensitivity": "drill",
    "vibration": "rover",
    "terrain_sensitivity": "rover",
    "slope_warn_deg": "rover",
    "warning_intensity": "all",
}


class HubContext(Protocol):
    mission: MissionState
    store: ProfileStore
    engine: HapticEngine
    terrain: TerrainGrid | None

    async def apply_outcome(self, outcome: Outcome) -> None: ...

    async def profile_settings_changed(self) -> None: ...

    async def ask_assistant(self, question: str, trigger: str) -> dict: ...

    async def redesign_patch(self, style: str) -> dict: ...


def _err(reason: str, **extra: Any) -> dict:
    return {"ok": False, "error": reason, **extra}


class CommandHandler:
    def __init__(self, ctx: HubContext) -> None:
        self.ctx = ctx
        self._dispatch: dict[str, Callable[[dict], Awaitable[dict]]] = {
            "activate_equipment": self.activate_equipment,
            "adjust_haptics": self.adjust_haptics,
            "get_equipment_status": self.get_equipment_status,
            "get_terrain_status": self.get_terrain_status,
            "get_profile": self.get_profile,
            "play_haptic_test": self.play_haptic_test,
            "ask_mission_assistant": self.ask_mission_assistant,
            "redesign_mission_patch": self.redesign_mission_patch,
        }
        assert set(self._dispatch) == TOOL_NAMES

    async def execute(self, name: str, args: dict | None) -> dict:
        fn = self._dispatch.get(name)
        if fn is None:
            return _err(f"unknown tool '{name}'")
        if not isinstance(args, dict):
            return _err("arguments must be an object")
        try:
            return await fn(args)
        except Exception as exc:  # never let a tool call crash the hub
            return _err(f"internal error: {type(exc).__name__}: {exc}")

    # ------------------------------------------------------------- tools
    async def activate_equipment(self, args: dict) -> dict:
        equipment = args.get("equipment")
        if equipment not in EQUIPMENT_ENUM:
            return _err("equipment must be 'drill' or 'rover'")
        outcome = self.ctx.mission.request_equipment(equipment)
        await self.ctx.apply_outcome(outcome)
        if not outcome.ok:
            hints = {"no_profile": "Ask the astronaut to tap their glove on the reader.",
                     "not_authorized": f"Ask the astronaut to tap their glove at the {equipment} to authorize it."}
            return _err(outcome.reason, hint=hints.get(outcome.reason, ""))
        return {"ok": True, "active_equipment": equipment}

    async def adjust_haptics(self, args: dict) -> dict:
        setting = args.get("setting")
        direction = args.get("direction")
        if setting not in SETTING_HOME:
            return _err(f"setting must be one of {sorted(SETTING_HOME)}")
        if direction not in ("increase", "decrease", "set"):
            return _err("direction must be increase, decrease or set")
        equipment = SETTING_HOME[setting]  # authoritative; ignore a mismatched equipment argument
        mission, store = self.ctx.mission, self.ctx.store
        profile = mission.profile
        if profile is None:
            return _err("no_profile", hint="Ask the astronaut to tap their glove on the reader.")
        current = store.get_setting(profile, equipment, setting)
        if direction == "set":
            value = args.get("value")
            if not isinstance(value, (int, float)):
                return _err("value is required for direction=set")
            target = float(value)
        elif setting == "slope_warn_deg":
            target = current + (SLOPE_STEP_DEG if direction == "increase" else -SLOPE_STEP_DEG)
        else:
            target = current * STEP_FACTOR if direction == "increase" else current / STEP_FACTOR
        try:
            old, new = store.set_setting(profile.id, equipment, setting, target)
        except SettingError as exc:
            return _err(str(exc))
        await self.ctx.profile_settings_changed()
        pat = patterns.setting_up() if new > old else patterns.setting_down() if new < old else patterns.confirm()
        await self.ctx.apply_outcome(Outcome(patterns=[(pat, f"{equipment} {setting} {old:g} -> {new:g}")]))
        result = {"ok": True, "equipment": equipment, "setting": setting, "old": old, "new": new}
        if new == old:
            result["note"] = "already at the allowed limit"
        return result

    async def get_equipment_status(self, args: dict) -> dict:
        equipment = args.get("equipment") or self.ctx.mission.active_equipment
        state = self.ctx.engine.state
        common = {"active_equipment": self.ctx.mission.active_equipment,
                  "authorized": sorted(self.ctx.mission.authorized)}
        if equipment == "drill":
            d = state.drill
            return {"ok": True, **common, "drill": {
                "operating": d.held, "running": d.trigger > 0.02, "spindle_pct": round(d.trigger * 100),
                "target": d.target, "in_contact": d.contact, "depth_cm": round(d.depth_m * 100, 1),
                "advance_rate_mm_s": round(d.rate_mps * 1000, 2), "stalled": d.stalled,
                "broken_through": d.through}}
        if equipment == "rover":
            r = state.rover
            return {"ok": True, **common, "rover": {
                "speed_kmh": round(abs(r.speed) * 3.6, 1), "reversing": r.speed < -0.05,
                "pitch_deg": round(r.pitch_deg, 1), "roll_deg": round(r.roll_deg, 1),
                "heading_deg": round(r.heading_deg % 360), "roughness_index": round(r.rough, 2)}}
        return {"ok": True, **common, "note": "no equipment active; specify drill or rover"}

    async def get_terrain_status(self, args: dict) -> dict:
        grid = self.ctx.terrain
        if grid is None:
            return _err("terrain data not loaded")
        st = self.ctx.engine.state
        x, z = st.terrain.x, st.terrain.z
        here = grid.sample(x, z)
        lat, lon = grid.latlon(x, z)
        heading = st.rover.heading_deg
        ahead = grid.lookahead(x, z, heading)
        profile = self.ctx.mission.profile
        limit = profile.equipment.rover.slope_warn_deg if profile else None
        return {
            "ok": True,
            "position": {"lat": lat, "lon": lon, "elevation_m": here["elev_m"]},
            "here": {"lola_slope_deg": here["lola_slope_deg"], "lola_slope_err_deg": here["lola_slope_err_deg"],
                     "measured": here["coverage"] > 0},
            "ahead_50m": {"max_slope_deg": ahead.max_slope_deg, "max_slope_err_deg": ahead.max_slope_err_deg,
                          "at_distance_m": ahead.at_distance_m, "steepest_measured": ahead.max_cover > 0},
            "slope_limit_deg": limit,
            "roughness_index": round(st.rover.rough, 2),
            "roughness_source": "simulated fine-scale detail" if st.terrain.synthetic_detail else "LOLA only",
            **grid.provenance(),
        }

    async def get_profile(self, args: dict) -> dict:
        profile = self.ctx.mission.profile
        if profile is None:
            return _err("no_profile", hint="Ask the astronaut to tap their glove on the reader.")
        return {"ok": True, **profile.summary()}

    async def play_haptic_test(self, args: dict) -> dict:
        name = args.get("pattern")
        if name not in TEST_PATTERN_ENUM:
            return _err(f"pattern must be one of {TEST_PATTERN_ENUM}")
        await self.ctx.apply_outcome(Outcome(patterns=[(patterns.TEST_PATTERNS[name](), f"test pattern {name}")]))
        return {"ok": True, "played": name}

    async def ask_mission_assistant(self, args: dict) -> dict:
        question = str(args.get("question", ""))[:500]
        advice = await self.ctx.ask_assistant(question, "voice")
        return {"ok": True, **advice}

    async def redesign_mission_patch(self, args: dict) -> dict:
        style = str(args.get("style", ""))[:120]
        if self.ctx.mission.profile is None:
            return _err("no_profile", hint="Ask the astronaut to tap their glove on the reader.")
        return await self.ctx.redesign_patch(style)
