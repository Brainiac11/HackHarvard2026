"""Mission Assistant client: calls the Chalk-deployed agent, falls back to local rules (PLAN.md §10B.7)."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path

from lunar_agent import baseline
from lunar_agent.schema import AssistantResult, ContextPacket

log = logging.getLogger("lunarhub.assistant")
CHALK_TIMEOUT_S = 6.0
FUNCTION_NAME = "mission_assistant"


class AssistantClient:
    def __init__(self, backend: str, variant: str, session_log: Path | None) -> None:
        """backend: 'chalk' (Chalk Function, local fallback) or 'local' (rules only)."""
        self.backend = backend
        self.variant = variant
        self.session_log = session_log
        self._fn = None
        self._lock = asyncio.Lock()
        self.last_error = ""

    def _remote(self):
        if self._fn is None:
            import chalkcompute  # optional dependency: uv sync --extra chalk

            self._fn = chalkcompute.RemoteFunction.from_name(FUNCTION_NAME)
        return self._fn

    async def ask(self, ctx: ContextPacket, question: str = "", trigger: str = "manual") -> AssistantResult:
        async with self._lock:  # one request in flight
            result = None
            if self.backend == "chalk":
                start = time.perf_counter()
                try:
                    raw = await asyncio.wait_for(
                        asyncio.to_thread(lambda: self._remote().remote(ctx.model_dump_json(), question, self.variant)),
                        CHALK_TIMEOUT_S)
                    result = AssistantResult.model_validate_json(raw) if isinstance(raw, str) else \
                        AssistantResult.model_validate(raw)
                    result.source = "chalk"
                    result.latency_ms = int((time.perf_counter() - start) * 1000)
                    self.last_error = ""
                except Exception as exc:
                    self.last_error = f"{type(exc).__name__}: {exc}"[:200]
                    log.warning("Chalk assistant failed, using local rules: %s", self.last_error)
            if result is None:
                result = baseline.run(ctx)
            self._log(ctx, question, trigger, result)
            return result

    def _log(self, ctx: ContextPacket, question: str, trigger: str, result: AssistantResult) -> None:
        if self.session_log is None:
            return
        self.session_log.parent.mkdir(parents=True, exist_ok=True)
        with self.session_log.open("a") as fh:
            fh.write(json.dumps({"ts": time.time(), "trigger": trigger, "question": question,
                                 "context": ctx.model_dump(mode="json"),
                                 "result": result.model_dump(mode="json")}) + "\n")
