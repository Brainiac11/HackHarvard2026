"""LLM-judge rubrics as pydantic models (Chalk's llm_judge takes a pydantic model; we reuse it locally)."""

from __future__ import annotations

from pydantic import BaseModel, Field


class AstronautUsefulness(BaseModel):
    clarity: int = Field(ge=0, le=2, description="Plain language a busy astronaut understands instantly.")
    actionability: int = Field(ge=0, le=2, description="One concrete, correct next action.")
    correctness: int = Field(ge=0, le=2, description="Explains the actual sensation and cause shown in the context.")
    brevity_tone: int = Field(ge=0, le=2, description="At most two short sentences; calm mission-radio tone.")
    score: float = Field(ge=0, le=1, description="Overall usefulness = sum of the four criteria / 8.")
    reason: str


class ReferenceAgreement(BaseModel):
    cause_agrees: int = Field(ge=0, le=2, description="Same explanation of what is felt and why.")
    action_agrees: int = Field(ge=0, le=2, description="Compatible recommended action.")
    score: float = Field(ge=0, le=1, description="(cause_agrees + action_agrees) / 4.")
    reason: str
