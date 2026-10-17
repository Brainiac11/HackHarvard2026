"""Deterministic pre-analysis of a ContextPacket (PLAN.md §10B.3 step 1).

Produces the derived features the LLM sees, and the rule-based ground truth the evals score against.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

from .knowledge import RUBRIC, vocabulary
from .schema import ContextPacket

ROVER_V_MAX = 4.0
RECENT_ALERT_S = 4.0
RECENT_EVENT_S = 2.0
UNCERTAIN_SLOPE_ERR_DEG = 2.0


@dataclass
class Derived:
    situation: str
    feeling: str
    hazard: str
    requires_uncertainty: bool
    slope_margin_deg: float | None = None  # limit - slope here (negative = over the limit)
    lookahead_margin_deg: float | None = None
    impacts_left_10s: int = 0
    impacts_right_10s: int = 0
    terrain_side: str | None = None  # left | right | both
    speed_kmh: float = 0.0
    depth_cm: float = 0.0
    advance_rate_mm_s: float = 0.0
    action_terms: tuple[str, ...] = field(default_factory=tuple)

    def as_dict(self) -> dict:
        d = asdict(self)
        d["action_terms"] = list(self.action_terms)
        return d


def _feeling_for(meaning: str | None) -> str:
    if not meaning:
        return "none"
    return vocabulary().get(meaning, {}).get("feeling", "none")


def expected_feeling(ctx: ContextPacket) -> str:
    """What the glove is making the astronaut feel right now (ground truth from the haptic engine)."""
    recent = ctx.haptics.recent
    alerts = [e for e in recent if e.layer == "alert" and e.t_ago_s <= RECENT_ALERT_S]
    if alerts:
        return _feeling_for(min(alerts, key=lambda e: e.t_ago_s).meaning)
    events = [e for e in recent if e.layer == "event" and e.t_ago_s <= RECENT_EVENT_S]
    if events:
        return _feeling_for(min(events, key=lambda e: e.t_ago_s).meaning)
    levels = ctx.haptics.levels
    left, right = levels.get("rover.terrain_left", 0.0), levels.get("rover.terrain_right", 0.0)
    if left > 0 and right > 0 and max(left, right) < 2 * min(left, right):
        if ctx.haptics.dominant in ("rover.terrain_left", "rover.terrain_right"):
            return "rough_terrain_both"
    return _feeling_for(ctx.haptics.dominant)


def _situation(ctx: ContextPacket) -> str:
    if ctx.profile is None:
        return "no_profile"
    recent = ctx.haptics.recent
    if ctx.mode == "walk" or ctx.active_equipment is None:
        if ctx.near and ctx.near not in ctx.authorized:
            return "not_authorized"
        if ctx.near:
            return "equipment_ready"
        return "walk"
    if ctx.mode == "drill":
        d = ctx.drill
        if any(e.meaning == "alert.drill_stall" and e.t_ago_s <= RECENT_ALERT_S for e in recent) or (
                d.stalled and d.contact and d.trigger > 0.5):
            return "drill_stall"
        if any(e.meaning == "event.breakthrough" and e.t_ago_s <= RECENT_EVENT_S for e in recent):
            return "drill_breakthrough"
        if not d.held or d.trigger <= 0.02:
            return "drill_idle"
        if not d.contact:
            return "drill_free_spin"
        return "drill_hard" if d.hardness >= 0.5 else "drill_soft"
    # rover
    r, t, limit = ctx.rover, ctx.terrain, ctx.profile.slope_warn_deg
    if any(e.meaning == "alert.slope" and e.t_ago_s <= RECENT_ALERT_S + 1 for e in recent) or (
            t.lola_slope_deg is not None and t.lola_slope_deg > limit):
        return "rover_slope_alert"
    impacts = [e for e in recent if e.meaning.startswith("event.impact")]
    if any(e.t_ago_s <= RECENT_EVENT_S for e in impacts) or len(impacts) >= 2:
        return "rover_impacts_side"
    if t.lookahead_max_slope_deg is not None and t.lookahead_max_slope_deg > limit:
        return "rover_slope_ahead"
    if abs(r.speed_mps) < 0.1:
        return "rover_idle"
    if r.rough > 0.5 and abs(r.speed_mps) > 0.6 * ROVER_V_MAX:
        return "rover_rough_fast"
    return "rover_cruise"


def derive(ctx: ContextPacket) -> Derived:
    situation = _situation(ctx)
    rule = RUBRIC[situation]
    t, limit = ctx.terrain, ctx.profile.slope_warn_deg if ctx.profile else None
    impacts_l = sum(1 for e in ctx.haptics.recent if e.meaning == "event.impact_left")
    impacts_r = sum(1 for e in ctx.haptics.recent if e.meaning == "event.impact_right")
    requires_uncertainty = False
    if situation == "rover_slope_alert":
        requires_uncertainty = t.measured is False or (t.lola_slope_err_deg or 0) > UNCERTAIN_SLOPE_ERR_DEG
    elif situation == "rover_slope_ahead":
        requires_uncertainty = t.lookahead_max_measured is False or (
            t.lookahead_max_slope_err_deg or 0) > UNCERTAIN_SLOPE_ERR_DEG
    lv = ctx.haptics.levels
    left, right = lv.get("rover.terrain_left", 0.0), lv.get("rover.terrain_right", 0.0)
    side = None
    if left or right or lv.get("rover.terrain"):
        side = "both" if (lv.get("rover.terrain") or (left and right and max(left, right) < 2 * min(left, right))) \
            else ("left" if left > right else "right")
    return Derived(
        situation=situation,
        feeling=expected_feeling(ctx),
        hazard=rule.hazard,
        requires_uncertainty=requires_uncertainty,
        slope_margin_deg=round(limit - t.lola_slope_deg, 1) if limit is not None and t.lola_slope_deg is not None
        else None,
        lookahead_margin_deg=round(limit - t.lookahead_max_slope_deg, 1)
        if limit is not None and t.lookahead_max_slope_deg is not None else None,
        impacts_left_10s=impacts_l,
        impacts_right_10s=impacts_r,
        terrain_side=side,
        speed_kmh=round(abs(ctx.rover.speed_mps) * 3.6, 1),
        depth_cm=round(ctx.drill.depth_m * 100, 1),
        advance_rate_mm_s=round(ctx.drill.rate_mps * 1000, 2),
        action_terms=rule.action_terms,
    )
