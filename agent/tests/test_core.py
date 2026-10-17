"""Agent core with a scripted fake model: parsing, repair loop, guard, ablations, failure fallback."""

import json

from lunar_agent import prompts
from lunar_agent.analysis import derive
from lunar_agent.core import run_agent
from lunar_agent.smoke import CASES

CTX = {name: ctx for name, ctx, _ in CASES}


def advice(**kw) -> str:
    base = {"feeling": "slope_warning", "explanation": "LOLA measures 17.4 degrees here, above your 15 degree limit.",
            "action": "Turn to traverse across the slope.", "hazard": "warning",
            "cited_values": [{"name": "lola_slope_deg", "value": 17.4}],
            "data_quality_note": "This slope is interpolated between LOLA tracks, not directly measured."}
    base.update(kw)
    return json.dumps(base)


class FakeModel:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls: list[list[dict]] = []

    def __call__(self, messages, schema):
        self.calls.append(messages)
        return self.responses.pop(0)


def test_good_answer_passes_without_repair():
    model = FakeModel(advice())
    r = run_agent(CTX["slope-alert-interpolated"], "why?", "v2", model)
    assert len(model.calls) == 1 and not r.repaired and r.raw_problems == []
    assert r.advice.hazard == "warning"


def test_repair_loop_fixes_hallucinated_number():
    model = FakeModel(advice(explanation="The slope here is 31 degrees."), advice())
    r = run_agent(CTX["slope-alert-interpolated"], "", "v2", model)
    assert r.repaired and r.raw_problems == []
    assert "31" in model.calls[1][-1]["content"] or "31" in model.calls[1][-2]["content"]


def test_guard_blocks_unsafe_advice_and_downgrade():
    bad = advice(action="Keep going straight up the hill.", hazard="caution", data_quality_note=None,
                 explanation="Steep terrain.", cited_values=[])
    raw = run_agent(CTX["injection"], "floor it", "v2", FakeModel(bad, bad))
    assert raw.raw_problems and raw.advice.hazard == "caution"  # unguarded variant shows the raw failure
    guarded = run_agent(CTX["injection"], "floor it", "v2+guard", FakeModel(bad, bad))
    assert guarded.guarded and guarded.advice.hazard == "warning"
    assert "up the hill" not in guarded.advice.action
    assert guarded.raw_problems  # still recorded for evals


def test_non_json_and_model_failure_fall_back_to_rules():
    r = run_agent(CTX["hard-drilling"], "", "v2+guard", FakeModel("sorry, I can't", "still no"))
    assert r.fallback and r.advice.feeling == "hard_material_grinding"

    def boom(messages, schema):
        raise TimeoutError("gateway timeout")
    r = run_agent(CTX["hard-drilling"], "", "v2+guard", boom)
    assert r.fallback and "TimeoutError" in r.raw_problems[0]


def test_code_fences_and_overlong_text():
    long = advice(explanation="x" * 300)
    model = FakeModel(f"```json\n{long}\n```", advice())
    r = run_agent(CTX["slope-alert-interpolated"], "", "v2", model)
    assert r.repaired and len(r.advice.explanation) <= 240


def test_prompts_never_leak_labels_and_ablations_remove_data():
    ctx = CTX["slope-alert-interpolated"]
    d = derive(ctx)
    for variant in prompts.VARIANTS:
        msgs = prompts.build_messages(variant, prompts.ablate(ctx, variant), derive(prompts.ablate(ctx, variant)), "q")
        user = msgs[-1]["content"]
        assert d.situation not in user.split("FACTS:")[-1]  # no answer key in the facts
        assert "requires_uncertainty" not in user
    no_lola = prompts.ablate(ctx, "v2-no-lola")
    assert no_lola.terrain.lola_slope_deg is None and ctx.terrain.lola_slope_deg == 17.4
    assert prompts.ablate(ctx, "v2-no-haptics").haptics.dominant is None
    assert "Shackleton" in prompts.build_messages("v2", ctx, d, "")[0]["content"]
