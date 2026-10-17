"""Run the eval suite locally (no Chalk Compute needed; LLM calls still go through the configured gateway).

    uv run --project hub --extra chalk python -m lunar_agent.evals.local_eval --variants baseline-rules
    set -a; source .env; set +a
    uv run --project hub --extra chalk python -m lunar_agent.evals.local_eval \\
        --variants baseline-rules,v1,v2,v2+guard,v2-no-lola,v2-no-haptics --judge --limit 120

Same scorers as the Chalk run (evals/scorers.py), so numbers are comparable. Writes docs/EVALS.md.
"""

from __future__ import annotations

import argparse
import json
import random
from concurrent.futures import ThreadPoolExecutor

from .. import baseline
from ..core import run_agent
from ..schema import AssistantResult, ContextPacket
from . import judges, report, scorers
from .build_dataset import load

DATASETS = ["lh-synthetic", "lh-adversarial", "lh-replay", "lh-questions"]


def run_variant(variant: str, row: dict, completers: dict) -> str:
    ctx = ContextPacket.model_validate_json(row["context_json"])
    if variant == "baseline-rules":
        return baseline.run(ctx).model_dump_json()
    complete, model = completers["alt" if variant.startswith("v2-alt-model") else "main"]
    return run_agent(ctx, row["question"], variant, complete, model).model_dump_json()


def judge_scores(row: dict, output: str, complete) -> dict:
    """LLM judges (different model family recommended: set JUDGE_MODEL)."""
    out = {}
    advice = json.loads(output).get("advice", {})
    rubrics = [("usefulness", judges.AstronautUsefulness, scorers.USEFULNESS_INSTRUCTIONS,
                f"CONTEXT: {row['context_json']}\nQUESTION: {row['question'] or '(none)'}\nANSWER: {json.dumps(advice)}")]
    if row.get("reference_answer"):
        rubrics.append(("agreement", judges.ReferenceAgreement, scorers.AGREEMENT_INSTRUCTIONS,
                        f"QUESTION: {row['question']}\nREFERENCE: {row['reference_answer']}\n"
                        f"ANSWER: {json.dumps(advice)}"))
    for name, model, instructions, content in rubrics:
        schema = model.model_json_schema()
        schema["additionalProperties"] = False
        try:
            raw = complete([{"role": "system", "content": instructions + " Respond with JSON matching: "
                             + json.dumps(schema)}, {"role": "user", "content": content}], None)
            start, end = raw.find("{"), raw.rfind("}")
            out[name] = float(model.model_validate_json(raw[start:end + 1]).score)
        except Exception:
            pass  # a failed judgement is skipped, not scored as zero
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--variants", default="baseline-rules")
    ap.add_argument("--datasets", default=",".join(DATASETS))
    ap.add_argument("--limit", type=int, default=0, help="random sample of N rows per dataset (0 = all)")
    ap.add_argument("--judge", action="store_true", help="also run LLM judges (needs JUDGE_MODEL or AGENT_MODEL)")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()

    variants = [v.strip() for v in args.variants.split(",") if v.strip()]
    rows = []
    rng = random.Random(args.seed)
    for name in args.datasets.split(","):
        data = load(name)
        if args.limit and len(data) > args.limit:
            data = rng.sample(data, args.limit)
        rows += [dict(r, dataset=name) for r in data]
    if not rows:
        raise SystemExit("no dataset rows: run `python -m lunar_agent.evals.build_dataset` first")

    completers: dict = {}
    needs_llm = any(v != "baseline-rules" for v in variants)
    if needs_llm or args.judge:
        import os

        from ..llm import completer_from_env
        if needs_llm:
            completers["main"] = completer_from_env()
            if any(v.startswith("v2-alt-model") for v in variants):
                completers["alt"] = completer_from_env(alt=True)
        if args.judge:
            judge_model = os.environ.get("JUDGE_MODEL") or os.environ.get("AGENT_MODEL")
            os.environ["AGENT_MODEL_ALT"] = judge_model or ""
            completers["judge"] = completer_from_env(alt=True)

    def evaluate(job):
        variant, row = job
        output = run_variant(variant, row, completers)
        scores = {name: fn(*[output if c == "output" else row[c] for c in cols])
                  for name, (fn, cols) in scorers.DETERMINISTIC.items()}
        if args.judge:
            scores.update(judge_scores(row, output, completers["judge"][0]))
        result = AssistantResult.model_validate_json(output)
        return {**row, "variant": variant, "scores": scores, "latency_ms": result.latency_ms,
                "output_advice": result.advice.model_dump()}

    jobs = [(v, r) for v in variants for r in rows]
    print(f"evaluating {len(rows)} rows x {len(variants)} variants = {len(jobs)} runs")
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        scored = list(pool.map(evaluate, jobs))
    agg = report.aggregate(scored)
    meta = {"datasets": args.datasets, "rows": len(rows), "runner": "local",
            "model": completers["main"][1] if "main" in completers else "rules",
            "judge": completers["judge"][1] if "judge" in completers else "none"}
    path = report.save(agg, scored, "Local evaluation run", meta)
    for v, a in agg.items():
        print(f"{v:16s} " + "  ".join(f"{k}={100 * x:.0f}%" for k, x in a["overall"].items())
              + f"  p50={a['latency_p50']}ms")
    print(f"report -> {path}")


if __name__ == "__main__":
    main()
