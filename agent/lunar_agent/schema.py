"""Mission Assistant I/O schemas (PLAN.md §10B.4). Shared by the hub, the Chalk function and the evals."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Feeling = Literal[
    "none", "drill_free_spin", "soft_material_hum", "hard_material_grinding", "drill_stall_warning",
    "drill_breakthrough", "rover_speed_rumble", "rough_terrain_left", "rough_terrain_right", "rough_terrain_both",
    "wheel_impact", "slope_warning", "auth_confirmation", "setting_change", "access_denied",
]
Hazard = Literal["nominal", "caution", "warning"]
FEELINGS: tuple[str, ...] = Feeling.__args__  # type: ignore[attr-defined]
HAZARDS: tuple[str, ...] = Hazard.__args__  # type: ignore[attr-defined]


class _Ctx(BaseModel):
    model_config = ConfigDict(extra="ignore")


class ProfileCtx(_Ctx):
    name: str
    callsign: str = ""
    slope_warn_deg: float = 15.0
    drill_sensitivity: float = 1.0
    rover_vibration: float = 1.0
    terrain_sensitivity: float = 1.0
    warning_intensity: float = 1.0


class RecentEvent(_Ctx):
    meaning: str
    layer: str = "event"
    cause: str = ""
    t_ago_s: float = 0.0


class HapticsCtx(_Ctx):
    dominant: str | None = None
    levels: dict[str, float] = Field(default_factory=dict)  # meaning -> mean motor level 0..1
    duty: list[int] = Field(default_factory=lambda: [0] * 5)  # thumb..pinky
    alert_active: bool = False
    recent: list[RecentEvent] = Field(default_factory=list)  # last 10 s, oldest first


class DrillCtx(_Ctx):
    held: bool = False
    trigger: float = 0.0
    target: Literal["soft", "hard"] | None = None
    contact: bool = False
    hardness: float = 0.0
    depth_m: float = 0.0
    rate_mps: float = 0.0
    stalled: bool = False
    through: bool = False  # broken through the sample, bit not yet raised


class RoverCtx(_Ctx):
    speed_mps: float = 0.0
    rough: float = 0.0
    pitch_deg: float = 0.0
    roll_deg: float = 0.0
    heading_deg: float = 0.0
    left_bump: float = 0.0  # RMS suspension velocity, left wheels (m/s)
    right_bump: float = 0.0


class TerrainCtx(_Ctx):
    lat: float | None = None
    lon: float | None = None
    elev_m: float | None = None
    lola_slope_deg: float | None = None
    lola_slope_err_deg: float | None = None
    measured: bool | None = None  # True = LOLA laser return in this cell; False = interpolated
    lookahead_distance_m: float = 50.0
    lookahead_max_slope_deg: float | None = None
    lookahead_max_slope_err_deg: float | None = None
    lookahead_at_m: float | None = None
    lookahead_max_measured: bool | None = None
    synthetic_detail: bool = True


class ContextPacket(_Ctx):
    mode: Literal["walk", "drill", "rover"] = "walk"
    active_equipment: Literal["drill", "rover"] | None = None
    authorized: list[str] = Field(default_factory=list)
    near: Literal["drill", "rover"] | None = None
    profile: ProfileCtx | None = None
    haptics: HapticsCtx = Field(default_factory=HapticsCtx)
    drill: DrillCtx = Field(default_factory=DrillCtx)
    rover: RoverCtx = Field(default_factory=RoverCtx)
    terrain: TerrainCtx = Field(default_factory=TerrainCtx)


class CitedValue(BaseModel):
    name: str
    value: float


class AssistantAdvice(BaseModel):
    feeling: Feeling
    explanation: str = Field(max_length=240)
    action: str = Field(max_length=140)
    hazard: Hazard
    cited_values: list[CitedValue] = Field(default_factory=list)
    data_quality_note: str | None = None


class AssistantResult(BaseModel):
    """What the function returns: advice plus run metadata (used by latency/grounding scorers)."""

    advice: AssistantAdvice
    variant: str
    model: str = ""
    latency_ms: int = 0
    repaired: bool = False
    source: Literal["chalk", "local"] = "local"
    raw_problems: list[str] = Field(default_factory=list)  # validation problems before the guard (for evals)
    guarded: bool = False  # production guard changed the model's answer
    fallback: bool = False  # model failed entirely; rule-based advice returned
