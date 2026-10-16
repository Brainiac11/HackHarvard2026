import pytest

from lunar_agent import baseline
from lunar_agent.analysis import derive
from lunar_agent.knowledge import RUBRIC, vocabulary
from lunar_agent.schema import FEELINGS, AssistantAdvice, CitedValue, ContextPacket
from lunar_agent.validate import grounding_problems, mentions_uncertainty, safety_problems

PROFILE = {"name": "Cmdr. Ana Rivera", "callsign": "HAWK", "slope_warn_deg": 15}


def ctx(**kw) -> ContextPacket:
    base = {"profile": PROFILE, "authorized": ["drill", "rover"]}
    base.update(kw)
    return ContextPacket.model_validate(base)


def drill_ctx(hardness, stalled=False, contact=True, trigger=1.0, recent=(), dominant="auto", held=True):
    return ctx(mode="drill", active_equipment="drill",
               drill={"held": held, "trigger": trigger, "contact": contact, "hardness": hardness,
                      "target": "hard" if hardness >= .5 else "soft", "stalled": stalled, "depth_m": 0.031,
                      "rate_mps": 0.0002 if hardness >= .5 else 0.01},
               haptics={"dominant": (("drill.hard" if hardness >= .5 else "drill.soft") if dominant == "auto"
                                     else dominant),
                        "recent": list(recent)})


def rover_ctx(speed=2.0, rough=0.1, slope=5.0, measured=True, err=0.6, ahead=6.0, ahead_measured=True,
              recent=(), dominant="rover.speed", levels=None):
    return ctx(mode="rover", active_equipment="rover",
               rover={"speed_mps": speed, "rough": rough, "heading_deg": 90},
               terrain={"lola_slope_deg": slope, "lola_slope_err_deg": err, "measured": measured,
                        "lookahead_max_slope_deg": ahead, "lookahead_max_slope_err_deg": err, "lookahead_at_m": 35,
                        "lookahead_all_measured": ahead_measured, "lat": -89.53, "lon": 197.2, "elev_m": 1874},
               haptics={"dominant": dominant, "recent": list(recent),
                        "levels": levels or ({dominant: 0.3} if dominant else {})})


STALL = {"meaning": "alert.drill_stall", "layer": "alert", "cause": "drill bit not advancing", "t_ago_s": 1.0}
SLOPE = {"meaning": "alert.slope", "layer": "alert", "cause": "LOLA slope 17.2 deg exceeds personal limit 15 deg",
         "t_ago_s": 0.5}
IMPACT_L = {"meaning": "event.impact_left", "layer": "event", "cause": "wheel impact magnitude 0.80", "t_ago_s": 0.4}

CASES = [
    ("no_profile", ContextPacket(), "none", "nominal"),
    ("not_authorized", ctx(near="rover", authorized=[]), "none", "nominal"),
    ("drill_soft", drill_ctx(0.25), "soft_material_hum", "nominal"),
    ("drill_hard", drill_ctx(0.9), "hard_material_grinding", "caution"),
    ("drill_stall", drill_ctx(0.9, stalled=True, recent=[STALL]), "drill_stall_warning", "warning"),
    ("drill_free_spin", drill_ctx(0.9, contact=False, dominant="drill.free_spin"), "drill_free_spin", "nominal"),
    ("drill_idle", drill_ctx(0.25, trigger=0.0, dominant=None), "none", "nominal"),
    ("rover_cruise", rover_ctx(), "rover_speed_rumble", "nominal"),
    ("rover_rough_fast", rover_ctx(speed=3.5, rough=0.8, dominant="rover.terrain",
                                   levels={"rover.terrain": 0.5, "rover.speed": 0.3}), "rough_terrain_both", "caution"),
    ("rover_slope_alert", rover_ctx(slope=17.2, recent=[SLOPE]), "slope_warning", "warning"),
    ("rover_slope_ahead", rover_ctx(ahead=19.0), "rover_speed_rumble", "caution"),
    ("rover_impacts_side", rover_ctx(recent=[IMPACT_L]), "wheel_impact", "caution"),
    ("rover_idle", rover_ctx(speed=0.0, dominant=None), "none", "nominal"),
]


def test_vocabulary_feelings_are_valid_labels():
    assert {v["feeling"] for v in vocabulary().values()} <= set(FEELINGS)


def test_every_rubric_situation_is_covered_by_a_case():
    assert {c[0] for c in CASES} | {"walk", "drill_breakthrough"} == set(RUBRIC)


@pytest.mark.parametrize("situation,context,feeling,hazard", CASES, ids=[c[0] for c in CASES])
def test_derive_and_baseline(situation, context, feeling, hazard):
    d = derive(context)
    assert (d.situation, d.feeling, d.hazard) == (situation, feeling, hazard)
    advice = baseline.advise(context)
    assert advice.feeling == feeling and advice.hazard == hazard
    assert len(advice.explanation) <= 240 and len(advice.action) <= 140
    assert any(t in advice.action.lower() for t in d.action_terms), advice.action
    assert grounding_problems(advice, context, d) == []
    assert safety_problems(advice, d) == []


def test_split_terrain_feeling_left_vs_both():
    left = rover_ctx(rough=0.6, dominant="rover.terrain_left",
                     levels={"rover.terrain_left": 0.5, "rover.terrain_right": 0.05})
    both = rover_ctx(rough=0.6, dominant="rover.terrain_left",
                     levels={"rover.terrain_left": 0.4, "rover.terrain_right": 0.3})
    assert derive(left).feeling == "rough_terrain_left"
    assert derive(both).feeling == "rough_terrain_both"


def test_uncertainty_required_when_interpolated():
    c = rover_ctx(slope=17.2, measured=False, recent=[SLOPE])
    d = derive(c)
    assert d.requires_uncertainty
    advice = baseline.advise(c)
    assert mentions_uncertainty(advice)
    assert not derive(rover_ctx(slope=17.2, recent=[SLOPE])).requires_uncertainty
    assert derive(rover_ctx(ahead=19, ahead_measured=False)).requires_uncertainty


def test_grounding_catches_invented_numbers():
    c = rover_ctx(slope=17.2, recent=[SLOPE])
    d = derive(c)
    good = AssistantAdvice(feeling="slope_warning", hazard="warning", action="Turn across the slope.",
                           explanation="LOLA measures 17.2 degrees here, over your 15 degree limit.",
                           cited_values=[CitedValue(name="lola_slope_deg", value=17.2)])
    assert grounding_problems(good, c, d) == []
    bad = good.model_copy(update={"explanation": "The slope is 23 degrees and the drop is 140 m.",
                                  "cited_values": [CitedValue(name="lola_slope_deg", value=23.0)]})
    problems = grounding_problems(bad, c, d)
    assert len(problems) == 3  # cited 23, prose 23, prose 140
    # unit conversions and small counts are allowed
    ok = good.model_copy(update={"explanation": f"Three beats: you're doing {2.0 * 3.6:.1f} km/h on 17 degrees."})
    assert grounding_problems(ok, c, d) == []


def test_safety_catches_unsafe_advice_and_downgrades():
    c = rover_ctx(slope=17.2, recent=[SLOPE])
    d = derive(c)
    unsafe = AssistantAdvice(feeling="slope_warning", hazard="caution", explanation="Steep.",
                             action="Keep going straight up, you're nearly there.")
    problems = safety_problems(unsafe, d)
    assert len(problems) == 2
    stall = drill_ctx(0.9, stalled=True, recent=[STALL])
    push = AssistantAdvice(feeling="drill_stall_warning", hazard="warning", explanation="Stalled.",
                           action="Press harder to get through the basalt.")
    assert safety_problems(push, derive(stall))


def test_context_is_permissive():
    c = ContextPacket.model_validate({"mode": "rover", "unknown_field": 1, "terrain": {"lola_slope_deg": None}})
    assert derive(c).situation == "no_profile"
