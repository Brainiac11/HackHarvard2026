"""Astronaut profile store (PLAN.md §6.3). JSON on disk, atomic writes, bounded settings."""

from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from ..haptics.engine import ShapingProfile

# (equipment, setting) -> (min, max); "all" settings live in the global block
SETTING_BOUNDS: dict[tuple[str, str], tuple[float, float]] = {
    ("drill", "sensitivity"): (0.2, 2.0),
    ("rover", "vibration"): (0.2, 2.0),
    ("rover", "terrain_sensitivity"): (0.2, 2.0),
    ("rover", "slope_warn_deg"): (5.0, 30.0),
    ("all", "warning_intensity"): (0.2, 2.0),
    ("all", "gain"): (0.2, 2.0),
}


def normalize_uid(uid: str) -> str:
    return re.sub(r"[^0-9A-Za-z]", "", uid).upper()


class GlobalSettings(BaseModel):
    gain: float = 1.0
    motor_gain: list[float] = Field(default_factory=lambda: [1.0] * 5)
    warning_gain: float = 1.0


class DrillSettings(BaseModel):
    sensitivity: float = 1.0
    mapping: Literal["resistance", "localized"] = "resistance"


class RoverSettings(BaseModel):
    vibration: float = 1.0
    terrain_sensitivity: float = 1.0
    mapping: Literal["split", "uniform"] = "split"
    slope_warn_deg: float = 15.0


class EquipmentSettings(BaseModel):
    drill: DrillSettings = Field(default_factory=DrillSettings)
    rover: RoverSettings = Field(default_factory=RoverSettings)


class PatchSpec(BaseModel):
    motif: str = "a lunar rover under the Earth"
    colors: str = "navy, gold, regolith grey"
    file: str | None = None


class Profile(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    name: str
    callsign: str = ""
    uids: list[str] = Field(default_factory=list)
    auth_pattern: Literal["double", "triple", "wave"] = "double"
    global_: GlobalSettings = Field(default_factory=GlobalSettings, alias="global")
    hand_calibration: dict | None = None
    equipment: EquipmentSettings = Field(default_factory=EquipmentSettings)
    input: dict = Field(default_factory=dict)
    patch: PatchSpec = Field(default_factory=PatchSpec)

    def to_shaping(self) -> ShapingProfile:
        return ShapingProfile(
            gain=self.global_.gain,
            motor_gain=list(self.global_.motor_gain),
            warning_gain=self.global_.warning_gain,
            drill=self.equipment.drill.model_dump(),
            rover=self.equipment.rover.model_dump(),
        )

    def summary(self) -> dict:
        return {
            "id": self.id, "name": self.name, "callsign": self.callsign, "auth_pattern": self.auth_pattern,
            "settings": {
                "drill": self.equipment.drill.model_dump(),
                "rover": self.equipment.rover.model_dump(),
                "warning_intensity": self.global_.warning_gain,
                "gain": self.global_.gain,
            },
        }


class ProfileDocument(BaseModel):
    version: int = 1
    profiles: list[Profile] = Field(default_factory=list)


class SettingError(ValueError):
    pass


class ProfileStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.doc = ProfileDocument()
        if path.exists():
            self.doc = ProfileDocument.model_validate_json(path.read_text())

    # ------------------------------------------------------------- queries
    @property
    def profiles(self) -> list[Profile]:
        return self.doc.profiles

    def get(self, profile_id: str | None) -> Profile | None:
        return next((p for p in self.doc.profiles if p.id == profile_id), None)

    def by_uid(self, uid: str) -> Profile | None:
        key = normalize_uid(uid)
        return next((p for p in self.doc.profiles if key in {normalize_uid(u) for u in p.uids}), None)

    # ------------------------------------------------------------- mutations
    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = self.doc.model_dump(by_alias=True, mode="json")
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=".profiles-", suffix=".json")
        with os.fdopen(fd, "w") as fh:
            json.dump(data, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, self.path)

    def enroll(self, uid: str, profile_id: str) -> Profile:
        profile = self.get(profile_id)
        if profile is None:
            raise KeyError(profile_id)
        key = normalize_uid(uid)
        for p in self.doc.profiles:  # a tag belongs to exactly one astronaut
            p.uids = [u for u in p.uids if normalize_uid(u) != key]
        profile.uids.append(key)
        self.save()
        return profile

    def get_setting(self, profile: Profile, equipment: str, setting: str) -> float:
        if equipment == "all":
            return profile.global_.warning_gain if setting == "warning_intensity" else profile.global_.gain
        return float(getattr(getattr(profile.equipment, equipment), setting))

    def set_setting(self, profile_id: str, equipment: str, setting: str, value: float) -> tuple[float, float]:
        """Clamp, apply, persist. Returns (old, new)."""
        profile = self.get(profile_id)
        if profile is None:
            raise SettingError("no active astronaut profile")
        bounds = SETTING_BOUNDS.get((equipment, setting))
        if bounds is None:
            valid = sorted(f"{e}.{s}" for e, s in SETTING_BOUNDS)
            raise SettingError(f"'{setting}' is not adjustable for {equipment}; valid: {', '.join(valid)}")
        old = self.get_setting(profile, equipment, setting)
        new = round(min(bounds[1], max(bounds[0], float(value))), 3)
        if equipment == "all":
            if setting == "warning_intensity":
                profile.global_.warning_gain = new
            else:
                profile.global_.gain = new
        else:
            setattr(getattr(profile.equipment, equipment), setting, new)
        self.save()
        return old, new
