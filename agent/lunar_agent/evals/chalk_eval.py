"""Run the eval suite on Chalk Evaluations (PLAN.md §10B.6).

    set -a; source .env; set +a
    uv run --project hub --extra chalk python -m lunar_agent.evals.chalk_eval \\
        --variants baseline-rules,v1,v2,v2+guard,v2-no-lola,v2-no-haptics --datasets lh-synthetic,lh-adversarial,lh-questions

Tasks and scorers below are Chalk Functions defined at module top level (Chalk re-imports this module in every
worker); everything that uploads or runs lives under __main__. Scorer logic is evals/scorers.py, shared with the
local runner.
"""

from __future__ import annotations

import os

import chalkcompute
from chalkcompute import Secret

from . import judges
from . import scorers as S

IMAGE = chalkcompute.Image.debian_slim().pip_install(["openai>=1.40", "pydantic>=2.7"])
SECRETS = [Secret.from_local_env(n) for n in ("CHALK_ROUTER_API_KEY", "CHALK_ENV_ID", "AGENT_MODEL")]
SUITE = "lunarhaptics-assistant"


def _run(context_json: str, question: str, variant: str) -> str:
    from lunar_agent.core import run_agent
    from lunar_agent.llm import completer_from_env

    complete, model = completer_from_env(alt=variant.startswith("v2-alt-model"))
    return run_agent(context_json, question, variant, complete, model).model_dump_json()


# ------------------------------------------------------------------ tasks (one per variant)
@chalkcompute.function(image=IMAGE)
def task_baseline_rules(context_json: str, question: str) -> str:
    from lunar_agent import baseline
    from lunar_agent.schema import ContextPacket

    return baseline.run(ContextPacket.model_validate_json(context_json)).model_dump_json()


@chalkcompute.function(image=IMAGE, secrets=SECRETS)
def task_v1(context_json: str, question: str) -> str:
    return _run(context_json, question, "v1")


@chalkcompute.function(image=IMAGE, secrets=SECRETS)
def task_v2(context_json: str, question: str) -> str:
    return _run(context_json, question, "v2")


@chalkcompute.function(image=IMAGE, secrets=SECRETS)
def task_v2_guard(context_json: str, question: str) -> str:
    return _run(context_json, question, "v2+guard")


@chalkcompute.function(image=IMAGE, secrets=SECRETS)
def task_v2_no_lola(context_json: str, question: str) -> str:
    return _run(context_json, question, "v2-no-lola")


@chalkcompute.function(image=IMAGE, secrets=SECRETS)
def task_v2_no_haptics(context_json: str, question: str) -> str:
    return _run(context_json, question, "v2-no-haptics")


TASKS = {"baseline-rules": task_baseline_rules, "v1": task_v1, "v2": task_v2, "v2+guard": task_v2_guard,
         "v2-no-lola": task_v2_no_lola, "v2-no-haptics": task_v2_no_haptics}


# ------------------------------------------------------------------ scorers (custom functions; shared logic)
@chalkcompute.function(image=IMAGE)
def feeling(output: str, expected_feeling: str) -> float:
    return S.feeling_accuracy(output, expected_feeling)


@chalkcompute.function(image=IMAGE)
def hazard(output: str, expected_hazard: str) -> float:
    return S.hazard_accuracy(output, expected_hazard)


@chalkcompute.function(image=IMAGE)
def action(output: str, required_action_terms: str) -> float:
    return S.action_terms(output, required_action_terms)


@chalkcompute.function(image=IMAGE)
def grounded(output: str, context_json: str) -> float:
    return S.grounded(output, context_json)


@chalkcompute.function(image=IMAGE)
def safe(output: str, context_json: str, must_not_say: str) -> float:
    return S.safe(output, context_json, must_not_say)


@chalkcompute.function(image=IMAGE)
def uncertainty(output: str, requires_uncertainty: bool) -> float:
    return S.uncertainty(output, requires_uncertainty)


@chalkcompute.function(image=IMAGE)
def raw_clean(output: str) -> float:
    return S.raw_clean(output)


@chalkcompute.function(image=IMAGE)
def latency(output: str) -> float:
    return S.latency_ok(output)


@chalkcompute.function(image=IMAGE)
def concise(output: str) -> float:
    return S.concise(output)


VALID = chalkcompute.scorers.json_valid(inputs=("output",), name="valid")
_JUDGE_MODEL = os.environ.get("JUDGE_MODEL") or None
USEFULNESS = chalkcompute.scorers.llm_judge(
    judges.AstronautUsefulness, name="usefulness", inputs=("output", "context_json", "question"),
    instructions=S.USEFULNESS_INSTRUCTIONS, **({"model": _JUDGE_MODEL} if _JUDGE_MODEL else {}),
    completion_kwargs={"temperature": 0})
AGREEMENT = chalkcompute.scorers.llm_judge(
    judges.ReferenceAgreement, name="agreement", inputs=("output", "question", "reference_answer"),
    instructions=S.AGREEMENT_INSTRUCTIONS, **({"model": _JUDGE_MODEL} if _JUDGE_MODEL else {}),
    completion_kwargs={"temperature": 0})
BASE_SCORERS = [VALID, feeling, hazard, action, grounded, safe, uncertainty, raw_clean, latency, concise, USEFULNESS]


def main() -> None:
    import argparse

    import pyarrow  # noqa: F401  (DatasetClient.read returns a pyarrow table)

    from . import report
    from .build_dataset import load

    ap = argparse.ArgumentParser()
    ap.add_argument("--variants", default="baseline-rules,v1,v2,v2+guard")
    ap.add_argument("--datasets", default="lh-synthetic,lh-adversarial,lh-questions")
    args = ap.parse_args()

    suite = next((s for s in chalkcompute.EvaluationSuite.list_all() if s.name == SUITE), None) \
        or chalkcompute.EvaluationSuite.create(SUITE)
    client = chalkcompute.DatasetClient()
    scored = []
    for ds_name in args.datasets.split(","):
        rows = load(ds_name)
        if not rows:
            print(f"skip {ds_name}: no rows")
            continue
        dataset = client.upload(ds_name, rows)
        scorer_list = BASE_SCORERS + ([AGREEMENT] if ds_name == "lh-questions" else [])
        for variant in args.variants.split(","):
            ev = chalkcompute.Evaluation.create(f"{ds_name}:{variant}", dataset=dataset, task=TASKS[variant],
                                                scorers=scorer_list, suite_id=suite.id,
                                                metadata={"variant": variant, "dataset": ds_name})
            run = ev.run(metadata={"variant": variant}).wait(timeout=1800, raise_on_failure=False)
            print(f"{ds_name}:{variant} -> {run.status} {run.error_message or ''}")
            if run.result_dataset is None:
                continue
            table = client.read(run.result_dataset).to_pylist()
            for r in table:
                output = r.get("output") or "{}"
                try:
                    import json
                    parsed = json.loads(output)
                except Exception:
                    parsed = {}
                scores = {name: r.get(f"{name}_value") for name in report.SCORE_ORDER
                          if r.get(f"{name}_value") is not None}
                scored.append({**{k: r.get(k) for k in ("id", "slice", "question", "expected_feeling",
                                                        "expected_hazard")},
                               "variant": variant, "scores": scores, "latency_ms": parsed.get("latency_ms", 0),
                               "output_advice": parsed.get("advice", {})})
    if scored:
        agg = report.aggregate(scored)
        path = report.save(agg, scored, "Chalk Evaluations run", {"suite": SUITE, "datasets": args.datasets,
                                                                  "runner": "chalk", "model": os.environ.get("AGENT_MODEL", "")})
        print(f"report -> {path}")


if __name__ == "__main__":
    main()
