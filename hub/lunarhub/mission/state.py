"""Mission state: identity, equipment authorization, active equipment (PLAN.md §6.2).

Pure logic. Methods return an Outcome describing toasts and haptic patterns; the hub applies them.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..haptics import patterns
from ..haptics.effects import Keyframes
from ..profiles.store import Profile, ProfileStore, normalize_uid

EQUIPMENT = ("drill", "rover")


@dataclass
class Outcome:
    ok: bool = True
    toasts: list[tuple[str, str]] = field(default_factory=list)  # (level, text)
    patterns: list[tuple[Keyframes, str]] = field(default_factory=list)  # (pattern, cause)
    reason: str = ""
    profile_changed: bool = False
    equipment_changed: bool = False
    welcome: bool = False  # show the mission-patch splash


class MissionState:
    def __init__(self, store: ProfileStore) -> None:
        self.store = store
        self.profile_id: str | None = None
        self.active_equipment: str | None = None
        self.authorized: set[str] = set()
        self.near: str | None = None
        self.last_uid: str | None = None
        self.unknown_uid: str | None = None  # awaiting enrollment

    @property
    def profile(self) -> Profile | None:
        return self.store.get(self.profile_id)

    def set_near(self, near: str | None) -> None:
        self.near = near if near in EQUIPMENT else None

    # ------------------------------------------------------------- NFC
    def on_scan(self, uid: str) -> Outcome:
        uid = normalize_uid(uid)
        self.last_uid = uid
        profile = self.store.by_uid(uid)
        if profile is None:
            self.unknown_uid = uid
            return Outcome(ok=False, reason="unknown_glove",
                           toasts=[("warn", f"Unknown glove {uid[:8]}… — enroll it to an astronaut (see HUD)")],
                           patterns=[(patterns.denied(), f"unrecognised glove UID {uid}")])
        self.unknown_uid = None
        return self.identify(profile)

    def identify(self, profile: Profile) -> Outcome:
        """Log an astronaut in (from a real scan or the keyboard fallback) and authorize nearby equipment."""
        out = Outcome(welcome=True)
        if profile.id != self.profile_id:
            self.profile_id = profile.id
            self.authorized = set()
            self.active_equipment = None
            out.profile_changed = out.equipment_changed = True
        auth = patterns.AUTH_PATTERNS[profile.auth_pattern]()
        out.patterns.append((auth, f"glove recognised: {profile.name}"))
        if self.near is None:
            out.toasts.append(("ok", f"Welcome, {profile.name}"))
            return out
        out.equipment_changed = True
        self.authorized.add(self.near)
        self.active_equipment = self.near
        out.patterns.append(self._signature(self.near))
        out.toasts.append(("ok", f"{profile.name} — {self.near} profile loaded ({self._settings_blurb(profile)})"))
        return out

    def enroll(self, profile_id: str) -> Outcome:
        if not self.unknown_uid:
            return Outcome(ok=False, reason="nothing_to_enroll", toasts=[("warn", "Scan an unknown glove first")])
        if self.store.get(profile_id) is None:
            return Outcome(ok=False, reason="unknown_profile", toasts=[("error", f"No astronaut '{profile_id}'")])
        profile = self.store.enroll(self.unknown_uid, profile_id)
        uid, self.unknown_uid = self.unknown_uid, None
        out = self.on_scan(uid)
        out.toasts.insert(0, ("ok", f"Glove {uid[:8]}… assigned to {profile.name}"))
        return out

    # ------------------------------------------------------------- equipment
    def request_equipment(self, equipment: str | None) -> Outcome:
        if equipment is None:
            changed = self.active_equipment is not None
            self.active_equipment = None
            return Outcome(equipment_changed=changed)
        if equipment not in EQUIPMENT:
            return Outcome(ok=False, reason="unknown_equipment", toasts=[("error", f"No equipment '{equipment}'")])
        if self.profile is None:
            return Outcome(ok=False, reason="no_profile",
                           toasts=[("warn", "Tap your glove on the reader to identify yourself")],
                           patterns=[(patterns.denied(), "no astronaut identified")])
        if equipment not in self.authorized:
            return Outcome(ok=False, reason="not_authorized",
                           toasts=[("warn", f"Tap glove at the {equipment} to authorize it")],
                           patterns=[(patterns.denied(), f"{equipment} not authorized for this glove")])
        if self.active_equipment == equipment:
            return Outcome()
        self.active_equipment = equipment
        return Outcome(equipment_changed=True, patterns=[self._signature(equipment)],
                       toasts=[("info", f"{equipment.capitalize()} controls active")])

    def logout(self) -> Outcome:
        self.profile_id, self.active_equipment, self.authorized = None, None, set()
        return Outcome(profile_changed=True, equipment_changed=True, toasts=[("info", "Signed out")])

    # ------------------------------------------------------------- views
    def view(self) -> dict:
        p = self.profile
        return {
            "profile": p.summary() | {"patch_url": None, "hand_calibration": p.hand_calibration} if p else None,
            "equipment": {"active": self.active_equipment, "authorized": sorted(self.authorized), "near": self.near},
            "nfc": {"last_uid": self.last_uid, "unknown_uid": self.unknown_uid},
        }

    @staticmethod
    def _signature(equipment: str) -> tuple[Keyframes, str]:
        pat = patterns.equipment_drill() if equipment == "drill" else patterns.equipment_rover()
        return pat, f"{equipment} profile active"

    @staticmethod
    def _settings_blurb(p: Profile) -> str:
        d, r = p.equipment.drill, p.equipment.rover
        return (f"drill sensitivity ×{d.sensitivity:g}, terrain ×{r.terrain_sensitivity:g}, "
                f"slope warn {r.slope_warn_deg:g}°")
