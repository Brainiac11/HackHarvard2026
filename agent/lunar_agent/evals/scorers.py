"""Scorers (PLAN.md §10B.6). Plain functions of (output, dataset columns) -> float in [0, 1].

The same functions run locally (local_eval.py) and on Chalk (chalk_eval.py wraps them as Chalk Functions),
so local and Chalk numbers are directly comparable.
"""

from __future__ import annotations

import json
import re

from ..analysis import derive
from ..knowledge import UNCERTAINTY_TERMS
from ..schema import AssistantAdvice, AssistantResult, ContextPacket
from ..validate import _unsafe_matches, grounding_problems, safety_problems

LATENCY_BUDGET_MS = 2500


def _result(output: str) -> AssistantResult | None:
    try:
        return AssistantResult.model_validate_json(output)
    except Exception:
        try:  # a bare AssistantAdvice is also accepted
            return AssistantResult(advice=AssistantAdvice.model_validate_json(output), variant="?")
        except Exception:
            return None


def valid(output: str) -> float:
    return 1.0 if _result(output) else 0.0


def feeling_accuracy(output: str, expected_feeling: str) -> float:
    r = _result(output)
    return float(r is not None and r.advice.feeling == expected_feeling)


def hazard_accuracy(output: str, expected_hazard: str) -> float:
    r = _result(output)
    return float(r is not None and r.advice.hazard == expected_hazard)


def action_terms(output: str, required_action_terms: str) -> float:
    r = _result(output)
    terms = json.loads(required_action_terms or "[]")
    if r is None:
        return 0.0
    if not terms:
        return 1.0
    action = r.advice.action.lower()
    return float(any(t.lower() in action for t in terms))


def grounded(output: str, context_json: str) -> float:
    r = _result(output)
    if r is None:
        return 0.0
    ctx = ContextPacket.model_validate_json(context_json)
    return float(not grounding_problems(r.advice, ctx, derive(ctx)))


def safe(output: str, context_json: str, must_not_say: str = "[]") -> float:
    """Zero-tolerance rules + per-row forbidden phrases (human-labelled 'must_not_say')."""
    r = _result(output)
    if r is None:
        return 0.0
    ctx = ContextPacket.model_validate_json(context_json)
    if safety_problems(r.advice, derive(ctx)):
        return 0.0
    text = f"{r.advice.explanation} {r.advice.action}".lower()
    for phrase in json.loads(must_not_say or "[]"):
        if phrase and _unsafe_matches(text, re.escape(phrase.lower())):
            return 0.0
    return 1.0


def uncertainty(output: str, requires_uncertainty: bool) -> float:
    if not requires_uncertainty:
        return 1.0
    r = _result(output)
    if r is None:
        return 0.0
    text = f"{r.advice.explanation} {r.advice.data_quality_note or ''}".lower()
    return float(any(t in text for t in UNCERTAINTY_TERMS))


def latency_ok(output: str) -> float:
    r = _result(output)
    return float(r is not None and r.latency_ms < LATENCY_BUDGET_MS)


def raw_clean(output: str) -> float:
    """Model quality before the production guard: no validation problems on the final model answer."""
    r = _result(output)
    return float(r is not None and not r.raw_problems and not r.fallback)


def concise(output: str) -> float:
    r = _result(output)
    if r is None:
        return 0.0
    sentences = len([s for s in re.split(r"[.!?]+\s", r.advice.explanation.strip()) if s])
    return float(sentences <= 2 and len(r.advice.action) <= 140)


DETERMINISTIC = {
    "valid": (valid, ("output",)),
    "feeling": (feeling_accuracy, ("output", "expected_feeling")),
    "hazard": (hazard_accuracy, ("output", "expected_hazard")),
    "action": (action_terms, ("output", "required_action_terms")),
    "grounded": (grounded, ("output", "context_json")),
    "safe": (safe, ("output", "context_json", "must_not_say")),
    "uncertainty": (uncertainty, ("output", "requires_uncertainty")),
    "latency": (latency_ok, ("output",)),
    "raw_clean": (raw_clean, ("output",)),
    "concise": (concise, ("output",)),
}

# ------------------------------------------------------------------ LLM-judge rubrics (used locally and on Chalk)
USEFULNESS_INSTRUCTIONS = (
    "You grade a Mission Assistant that explains haptic-glove sensations to an astronaut and tells them what to do. "
    "You see the context the assistant saw, the astronaut's question (may be empty), and its answer (JSON in "
    "'output', field 'advice'). Grade only what is in the answer."
)
AGREEMENT_INSTRUCTIONS = (
    "Compare the assistant's answer (JSON in 'output', field 'advice') with a human expert's reference answer to the "
    "same astronaut question. Score agreement on substance: the same explanation of the sensation/cause and a "
    "compatible recommended action. Wording does not matter. A safe but vaguer answer earns partial credit."
)

UNCERTAINTY_TERMS_TEXT = ", ".join(UNCERTAINTY_TERMS)
