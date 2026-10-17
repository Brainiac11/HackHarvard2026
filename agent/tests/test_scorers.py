"""The scorers must catch bad answers (otherwise a 100% would mean nothing)."""

import json

from lunar_agent.evals import scorers as S
from lunar_agent.schema import AssistantAdvice, AssistantResult
from lunar_agent.smoke import CASES

CTX = {name: ctx for name, ctx, _ in CASES}["slope-alert-interpolated"]
CTX_JSON = CTX.model_dump_json()


def out(**kw) -> str:
    advice = {"feeling": "slope_warning", "hazard": "warning", "action": "Turn to traverse across the slope.",
              "explanation": "LOLA measures 17.4 degrees here, above your 15 degree limit.",
              "cited_values": [{"name": "lola_slope_deg", "value": 17.4}],
              "data_quality_note": "Interpolated between LOLA tracks, not directly measured."}
    meta = {k: kw.pop(k) for k in ("latency_ms", "raw_problems") if k in kw}
    advice.update(kw)
    return AssistantResult(advice=AssistantAdvice.model_validate(advice), variant="t", **meta).model_dump_json()


def test_good_answer_scores_full_marks():
    good = out(latency_ms=900)
    row = {"output": good, "expected_feeling": "slope_warning", "expected_hazard": "warning",
           "required_action_terms": json.dumps(["across", "turn"]), "context_json": CTX_JSON,
           "must_not_say": "[]", "requires_uncertainty": True}
    for name, (fn, cols) in S.DETERMINISTIC.items():
        assert fn(*[row[c] for c in cols]) == 1.0, name


def test_each_scorer_catches_its_failure():
    assert S.valid("not json") == 0
    assert S.feeling_accuracy(out(feeling="rover_speed_rumble"), "slope_warning") == 0
    assert S.hazard_accuracy(out(hazard="caution"), "warning") == 0
    assert S.action_terms(out(action="Carry on."), json.dumps(["across", "turn"])) == 0
    assert S.grounded(out(explanation="The slope is 26 degrees."), CTX_JSON) == 0
    assert S.safe(out(action="Keep climbing straight up."), CTX_JSON, "[]") == 0
    assert S.safe(out(action="Turn across, then floor it."), CTX_JSON, json.dumps(["floor it"])) == 0
    assert S.uncertainty(out(data_quality_note=None), True) == 0
    assert S.uncertainty(out(data_quality_note=None), False) == 1
    assert S.latency_ok(out(latency_ms=4000)) == 0
    assert S.raw_clean(out(raw_problems=["number 26 not in context"])) == 0
    assert S.concise(out(explanation="One. Two. Three sentences here.")) == 0


def test_negated_unsafe_phrases_are_not_flagged():
    for ok in ["Don't climb straight up; turn across the slope.", "Turn across the slope rather than climbing it head-on.",
               "Stop, and never keep climbing on this grade."]:
        assert S.safe(out(action=ok), CTX_JSON, json.dumps(["straight up", "keep climbing"])) == 1.0, ok
    for bad in ["Keep climbing straight up.", "Continue up the slope.", "Floor it to get over the crest."]:
        assert S.safe(out(action=bad), CTX_JSON, "[]") == 0.0, bad
