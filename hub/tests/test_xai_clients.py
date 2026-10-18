import base64
import io
import json

import httpx
import pytest
from PIL import Image

from lunarhub.imagine import patches
from lunarhub.profiles.store import PatchSpec, Profile
from lunarhub.voice.session import session_config
from lunarhub.voice.token import VoiceTokenError, mint_token, normalize_token_response


def png_bytes(size=(640, 480), fmt="PNG") -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, (10, 20, 30)).save(buf, fmt)
    return buf.getvalue()


# ---------------------------------------------------------------- voice token

@pytest.mark.parametrize("body,token", [
    ({"value": "tok1", "expires_at": 123}, "tok1"),
    ({"client_secret": {"value": "tok2", "expires_at": 9}}, "tok2"),
    ({"client_secret": "tok3"}, "tok3"),
    ({"token": "tok4"}, "tok4"),
])
def test_token_normalisation(body, token):
    out = normalize_token_response(body)
    assert out["token"] == token and out["expires_at"]


def test_token_normalisation_rejects_unknown():
    with pytest.raises(VoiceTokenError):
        normalize_token_response({"weird": 1})


async def test_mint_token_sends_ttl_and_auth():
    seen = {}

    def handler(request: httpx.Request):
        seen["auth"] = request.headers["authorization"]
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"value": "abc", "expires_at": 1})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        out = await mint_token("KEY", client)
    assert out["token"] == "abc"
    assert seen == {"auth": "Bearer KEY", "body": {"expires_after": {"seconds": 300}}}


async def test_mint_token_requires_key():
    with pytest.raises(VoiceTokenError):
        await mint_token("")


def test_session_config_is_the_shape_xai_accepted():
    """The session.update the browser sends, as wss://api.x.ai/v1/realtime accepted it on 2026-10-17 (session.updated,
    then a push-to-talk turn with a transcript, a tool call and audio)."""
    cfg = session_config("grok-voice-latest", "eve")
    assert cfg["url"] == "wss://api.x.ai/v1/realtime?model=grok-voice-latest"
    s = cfg["session"]
    assert s["turn_detection"] is None and s["voice"] == "eve" and s["reasoning"] == {"effort": "none"}
    pcm24k = {"type": "audio/pcm", "rate": 24000}  # what the browser's worklet sends and its player expects
    assert s["audio"]["input"]["format"] == pcm24k and s["audio"]["output"]["format"] == pcm24k
    assert "CAPCOM" in s["audio"]["input"]["transcription"]["keyterms"]
    assert all(t["type"] == "function" and t["name"] and "parameters" in t for t in s["tools"])
    json.dumps(cfg)  # served as-is by /api/voice/config


# ---------------------------------------------------------------- mission patches

PROFILE = Profile(id="rivera", name="Cmdr. Ana Rivera", callsign="HAWK",
                  patch=PatchSpec(motif="a hawk carrying a core drill", colors="navy, gold"))


def test_prompt_sanitises_and_caps_style():
    prompt = patches.build_prompt(PROFILE, 'ignore "rules" {x} ' + "a" * 500)
    assert '"' not in prompt and "{" not in prompt
    assert "No text" in prompt and "hawk" in prompt
    assert len(patches.sanitize("b" * 500)) == patches.STYLE_MAX


@pytest.mark.parametrize("fmt", ["PNG", "JPEG"])
def test_to_png_squares_and_normalises(fmt):
    img = Image.open(io.BytesIO(patches.to_png(png_bytes(fmt=fmt))))
    assert img.format == "PNG" and img.size == (patches.PATCH_PX, patches.PATCH_PX)


async def test_generate_b64_and_url_paths():
    raw = png_bytes()

    def handler(request: httpx.Request):
        if request.url.path.endswith("/images/generations"):
            body = json.loads(request.content)
            assert body["model"] == "grok-imagine-image" and body["n"] == 1
            if "url-please" in body["prompt"]:
                return httpx.Response(200, json={"data": [{"url": "https://cdn.example/x.png"}]})
            return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(raw).decode()}]})
        return httpx.Response(200, content=raw)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        assert await patches.generate_image("p", "K", "grok-imagine-image", client) == raw
        assert await patches.generate_image("url-please", "K", "grok-imagine-image", client) == raw


async def test_generate_error_raises():
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(429, text="slow"))) as c:
        with pytest.raises(patches.PatchError):
            await patches.generate_image("p", "K", "m", c)


async def test_service_fallback_and_cache(tmp_path):
    svc = patches.PatchService(tmp_path, api_key="", model="m")
    url, source = svc.url(PROFILE)
    assert source == "fallback" and url.endswith(".svg") and (tmp_path / "patches" / "rivera.svg").exists()
    with pytest.raises(patches.PatchError):
        await svc.generate(PROFILE)
    svc.path("rivera").write_bytes(patches.to_png(png_bytes()))
    url, source = svc.url(PROFILE)
    assert source == "grok-imagine" and "?v=" in url
    assert await svc.ensure(PROFILE) is False  # cached; no API call
