"""WebSocket JSON message models (PLAN.md §4.2). Source of truth; sim/src/net/messages.ts mirrors these.

Models are permissive (unknown fields ignored, everything defaulted) so a partially-populated
sim.state never crashes the hub.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class _Model(BaseModel):
    model_config = ConfigDict(extra="ignore")


Equipment = Literal["drill", "rover"]


class DrillState(_Model):
    held: bool = False
    trigger: float = Field(0.0, ge=0, le=1)
    target: Literal["soft", "hard"] | None = None
    contact: bool = False
    hardness: float = Field(0.0, ge=0, le=1)
    depth_m: float = 0.0
    rate_mps: float = 0.0
    stalled: bool = False
    through: bool = False  # the bit broke through the sample: it's clear below it until raised


class Wheel(_Model):
    comp: float = 0.0  # suspension compression, m
    vel: float = 0.0  # compression velocity, m/s
    contact: bool = True


class RoverState(_Model):
    speed: float = 0.0  # m/s (signed: negative = reverse)
    accel: float = 0.0
    throttle: float = 0.0
    steer: float = 0.0
    wheels: list[Wheel] = Field(default_factory=lambda: [Wheel() for _ in range(4)])  # FL, FR, RL, RR
    rough: float = Field(0.0, ge=0, le=1)
    pitch_deg: float = 0.0
    roll_deg: float = 0.0
    heading_deg: float = 0.0


class TerrainState(_Model):
    x: float = 0.0
    z: float = 0.0
    elev_m: float = 0.0
    lat: float | None = None
    lon: float | None = None
    lola_slope_deg: float | None = None
    lola_slope_err_deg: float | None = None
    coverage: int | None = None
    synthetic_detail: bool = True


class SimState(_Model):
    t: Literal["sim.state"] = "sim.state"
    ts: float = 0.0
    mode: Literal["walk", "drill", "rover"] = "walk"
    near: Equipment | None = None
    drill: DrillState = Field(default_factory=DrillState)
    rover: RoverState = Field(default_factory=RoverState)
    terrain: TerrainState = Field(default_factory=TerrainState)


class SimEvent(_Model):
    t: Literal["sim.event"] = "sim.event"
    name: Literal["impact", "breakthrough", "stall", "enter_rover", "exit_rover"]
    mag: float = 1.0
    side: Literal["left", "right"] | None = None


class UiAction(_Model):
    t: Literal["ui.action"] = "ui.action"
    action: str
    args: dict = Field(default_factory=dict)


class VoiceToolCall(_Model):
    t: Literal["voice.tool_call"] = "voice.tool_call"
    call_id: str
    name: str
    args: dict = Field(default_factory=dict)


class HandFrame(_Model):
    t: Literal["hand.frame"] = "hand.frame"
    ts: float = 0.0
    hand: str = "Right"
    score: float = 0.0
    lm: list[list[float]] = Field(default_factory=list)
    wlm: list[list[float]] = Field(default_factory=list)
    fps: float = 0.0
