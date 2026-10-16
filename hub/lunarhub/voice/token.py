"""Mint short-lived xAI Realtime tokens for the browser (PLAN.md §10.1). The API key never leaves the hub."""

from __future__ import annotations

import time

import httpx

CLIENT_SECRETS_URL = "https://api.x.ai/v1/realtime/client_secrets"
TOKEN_TTL_S = 300


class VoiceTokenError(RuntimeError):
    pass


def normalize_token_response(body: dict) -> dict:
    """The response schema is undocumented; accept the OpenAI-style and flat shapes."""
    candidates = [
        body.get("value"),
        (body.get("client_secret") or {}).get("value") if isinstance(body.get("client_secret"), dict) else None,
        body.get("client_secret") if isinstance(body.get("client_secret"), str) else None,
        body.get("token"),
        body.get("secret"),
    ]
    token = next((c for c in candidates if isinstance(c, str) and c), None)
    if not token:
        raise VoiceTokenError(f"unrecognised token response keys: {sorted(body)}")
    expires = body.get("expires_at")
    if expires is None and isinstance(body.get("client_secret"), dict):
        expires = body["client_secret"].get("expires_at")
    return {"token": token, "expires_at": expires or int(time.time()) + TOKEN_TTL_S}


async def mint_token(api_key: str, client: httpx.AsyncClient | None = None) -> dict:
    if not api_key:
        raise VoiceTokenError("XAI_API_KEY is not set")
    own = client is None
    client = client or httpx.AsyncClient(timeout=10.0)
    try:
        resp = await client.post(CLIENT_SECRETS_URL, headers={"Authorization": f"Bearer {api_key}"},
                                 json={"expires_after": {"seconds": TOKEN_TTL_S}})
        if resp.status_code >= 400:
            raise VoiceTokenError(f"xAI returned {resp.status_code}: {resp.text[:200]}")
        return normalize_token_response(resp.json())
    finally:
        if own:
            await client.aclose()
