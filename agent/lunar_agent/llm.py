"""LLM access through the Chalk Model Gateway (OpenAI-compatible), with a direct-xAI fallback for local dev.

Env:
    CHALK_ROUTER_API_KEY, CHALK_ENV_ID, CHALK_ROUTER_BASE (default https://api.chalk.ai/v1/router)
    AGENT_MODEL (e.g. "xai/<grok model>" via the gateway), AGENT_MODEL_ALT (for the alt-model experiment)
    XAI_API_KEY (+ AGENT_MODEL without prefix) when running without the gateway
"""

from __future__ import annotations

import os
from typing import Callable

Completer = Callable[[list[dict], "dict | None"], str]

DEFAULT_ROUTER_BASE = "https://api.chalk.ai/v1/router"
TIMEOUT_S = 12.0


class LlmConfigError(RuntimeError):
    pass


def completer_from_env(alt: bool = False) -> tuple[Completer, str]:
    from openai import BadRequestError, OpenAI

    model = os.environ.get("AGENT_MODEL_ALT" if alt else "AGENT_MODEL", "").strip()
    if not model:
        raise LlmConfigError("AGENT_MODEL_ALT is not set" if alt else "AGENT_MODEL is not set")
    router_key = os.environ.get("CHALK_ROUTER_API_KEY", "").strip()
    if router_key:
        env_id = os.environ.get("CHALK_ENV_ID", "").strip()
        if not env_id:
            raise LlmConfigError("CHALK_ENV_ID is required with the Chalk Model Gateway")
        client = OpenAI(base_url=os.environ.get("CHALK_ROUTER_BASE", DEFAULT_ROUTER_BASE), api_key=router_key,
                        default_headers={"X-Chalk-Env-Id": env_id}, timeout=TIMEOUT_S, max_retries=1)
        via = "chalk-gateway"
    elif os.environ.get("XAI_API_KEY"):
        client = OpenAI(base_url="https://api.x.ai/v1", api_key=os.environ["XAI_API_KEY"], timeout=TIMEOUT_S,
                        max_retries=1)
        model = model.split("/", 1)[-1]  # strip a gateway connection prefix
        via = "xai-direct"
    else:
        raise LlmConfigError("set CHALK_ROUTER_API_KEY (+CHALK_ENV_ID) or XAI_API_KEY")

    structured = {"ok": True}

    def complete(messages: list[dict], schema: dict | None) -> str:
        kwargs: dict = {"model": model, "messages": messages, "temperature": 0.2, "max_tokens": 400}
        if schema is not None:
            kwargs["response_format"] = ({"type": "json_schema", "json_schema": {"name": "assistant_advice",
                                                                                  "schema": schema, "strict": True}}
                                         if structured["ok"] else {"type": "json_object"})
        try:
            resp = client.chat.completions.create(**kwargs)
        except BadRequestError:
            if schema is None or not structured["ok"]:
                raise
            structured["ok"] = False  # provider/route without json_schema support: fall back to JSON mode
            kwargs["response_format"] = {"type": "json_object"}
            resp = client.chat.completions.create(**kwargs)
        return resp.choices[0].message.content or ""

    return complete, f"{model} ({via})"
