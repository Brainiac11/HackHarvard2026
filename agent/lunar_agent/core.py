"""Mission Assistant core (PLAN.md §10B.3): deterministic pre-analysis -> LLM -> validate -> repair -> guard.

Pure and dependency-injected (the `complete` callable), so it runs identically inside the Chalk Function,
in local evals, and in tests with a fake model.
"""

from __future__ import annotations

import json
import re
import time

from pydantic import ValidationError

from . import baseline, prompts
from .analysis import Derived, derive
from .knowledge import RUBRIC
from .llm import Completer
from .schema import AssistantAdvice, AssistantResult, ContextPacket
from .validate import grounding_problems, mentions_uncertainty, safety_problems

MAX_EXPLANATION = 240
MAX_ACTION = 140


def _extract_json(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    return json.loads(text[start:end + 1] if start >= 0 else text)


def parse_and_check(raw: str, ctx: ContextPacket, d: Derived) -> tuple[AssistantAdvice | None, list[str]]:
    try:
        data = _extract_json(raw)
    except (json.JSONDecodeError, ValueError):
        return None, ["response was not valid JSON"]
    problems: list[str] = []
    for key, limit in (("explanation", MAX_EXPLANATION), ("action", MAX_ACTION)):
        if isinstance(data.get(key), str) and len(data[key]) > limit:
            problems.append(f"{key} is {len(data[key])} characters; the limit is {limit}")
            data[key] = data[key][:limit]
    try:
        advice = AssistantAdvice.model_validate(data)
    except ValidationError as exc:
        return None, [f"schema error: {e['loc']}: {e['msg']}" for e in exc.errors()][:6]
    problems += grounding_problems(advice, ctx, d) + safety_problems(advice, d)
    if d.requires_uncertainty and not mentions_uncertainty(advice):
        problems.append("the relevant slope is interpolated/uncertain but the answer does not say so")
    return advice, problems


def guard(advice: AssistantAdvice, ctx: ContextPacket, d: Derived) -> tuple[AssistantAdvice, bool]:
    """Production safety net. Rule-derived warnings can't be downgraded; unsafe or ungrounded text is replaced."""
    changed = False
    update: dict = {}
    if d.hazard == "warning" and advice.hazard != "warning":
        update["hazard"] = "warning"
    if safety_problems(advice.model_copy(update=update), d):
        update["action"] = RUBRIC[d.situation].guidance
    if grounding_problems(advice, ctx, d):
        fallback = baseline.advise(ctx)
        update["explanation"] = fallback.explanation
        update["cited_values"] = fallback.cited_values
    if d.requires_uncertainty and not mentions_uncertainty(advice):
        update["data_quality_note"] = baseline.UNCERTAINTY_NOTE
    if update:
        advice = advice.model_copy(update=update)
        changed = True
    return advice, changed


def run_agent(context: ContextPacket | str, question: str, variant: str, complete: Completer,
              model: str = "") -> AssistantResult:
    ctx = context if isinstance(context, ContextPacket) else ContextPacket.model_validate_json(context)
    use_guard = variant.endswith("+guard")
    full = derive(ctx)  # validation/guard always use the full context
    view = prompts.ablate(ctx, variant)
    messages = prompts.build_messages(variant, view, derive(view), question)
    start = time.perf_counter()

    advice, problems, repaired, fallback = None, ["no response"], False, False
    try:
        raw = complete(messages, prompts.ADVICE_JSON_SCHEMA)
        advice, problems = parse_and_check(raw, ctx, full)
        if problems:
            raw2 = complete(messages + [{"role": "assistant", "content": raw}, prompts.repair_message(problems)],
                            prompts.ADVICE_JSON_SCHEMA)
            advice2, problems2 = parse_and_check(raw2, ctx, full)
            if advice2 is not None and (advice is None or len(problems2) <= len(problems)):
                advice, problems, repaired = advice2, problems2, True
    except Exception as exc:  # network/model failure: fall back to rules rather than fail the request
        problems = [f"llm error: {type(exc).__name__}: {exc}"[:200]]
    if advice is None:
        advice, fallback = baseline.advise(ctx), True
    raw_problems = list(problems)
    guarded = False
    if use_guard and not fallback:
        advice, guarded = guard(advice, ctx, full)
    return AssistantResult(advice=advice, variant=variant, model=model, repaired=repaired,
                           latency_ms=int((time.perf_counter() - start) * 1000), source="chalk",
                           raw_problems=raw_problems, guarded=guarded, fallback=fallback)
