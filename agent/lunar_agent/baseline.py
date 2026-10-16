"""Rule-based Mission Assistant (no LLM). Hub offline fallback and the `baseline-rules` eval experiment."""

from __future__ import annotations

import time

from .analysis import Derived, derive
from .knowledge import RUBRIC, vocabulary
from .schema import AssistantAdvice, AssistantResult, CitedValue, ContextPacket

FEELING_SENSATION = {v["feeling"]: v["sensation"] for v in reversed(list(vocabulary().values()))}
FEELING_SENSATION.update({"none": "nothing from the glove", "rough_terrain_both": "random taps across the hand"})

UNCERTAINTY_NOTE = "This slope is interpolated between LOLA laser tracks, not directly measured."


def _detail(ctx: ContextPacket, d: Derived) -> tuple[str, list[CitedValue]]:
    t, p = ctx.terrain, ctx.profile
    s = d.situation
    if s == "rover_slope_alert" and t.lola_slope_deg is not None and p:
        return (f"LOLA measures {t.lola_slope_deg:.1f}° here, above your {p.slope_warn_deg:g}° limit.",
                [CitedValue(name="lola_slope_deg", value=t.lola_slope_deg),
                 CitedValue(name="slope_warn_deg", value=p.slope_warn_deg)])
    if s == "rover_slope_ahead" and t.lookahead_max_slope_deg is not None and p:
        return (f"Ground {t.lookahead_at_m or 0:.0f} m ahead reaches {t.lookahead_max_slope_deg:.1f}°, over your "
                f"{p.slope_warn_deg:g}° limit.",
                [CitedValue(name="lookahead_max_slope_deg", value=t.lookahead_max_slope_deg)])
    if s == "rover_impacts_side":
        side = "left" if d.impacts_left_10s >= d.impacts_right_10s else "right"
        return f"Your {side} wheels struck obstacles.", []
    if s in ("rover_rough_fast", "rover_cruise"):
        return f"Speed {d.speed_kmh:.1f} km/h.", [CitedValue(name="speed_kmh", value=d.speed_kmh)]
    if s in ("drill_hard", "drill_stall") and ctx.drill.contact:
        return (f"Depth {d.depth_cm:.1f} cm, advancing {d.advance_rate_mm_s:.2f} mm/s.",
                [CitedValue(name="depth_cm", value=d.depth_cm)])
    return "", []


def advise(ctx: ContextPacket) -> AssistantAdvice:
    d = derive(ctx)
    rule = RUBRIC[d.situation]
    sensation = FEELING_SENSATION.get(d.feeling, "a glove pattern")
    signal = next((v["signal"] for v in vocabulary().values() if v["feeling"] == d.feeling), "")
    detail, cited = _detail(ctx, d)
    head = f"You're feeling {sensation}" + (f": {signal}." if signal else ".")
    explanation = f"{head} {detail}".strip()[:240]
    return AssistantAdvice(
        feeling=d.feeling, explanation=explanation, action=rule.guidance[:140], hazard=d.hazard,
        cited_values=cited, data_quality_note=UNCERTAINTY_NOTE if d.requires_uncertainty else None,
    )


def run(ctx: ContextPacket) -> AssistantResult:
    start = time.perf_counter()
    advice = advise(ctx)
    return AssistantResult(advice=advice, variant="baseline-rules", model="rules",
                           latency_ms=int((time.perf_counter() - start) * 1000), source="local")
