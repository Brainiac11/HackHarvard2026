"""Grok Imagine mission patches (PLAN.md §10A).

Patches are generated once per astronaut, cached under data/patches/, and committed so the demo never
waits on image generation. Any failure falls back to a procedural SVG patch.
"""

from __future__ import annotations

import base64
import hashlib
import io
import logging
import re
import shutil
from pathlib import Path

import httpx
from PIL import Image

from ..profiles.store import Profile

log = logging.getLogger("lunarhub.imagine")
IMAGES_URL = "https://api.x.ai/v1/images/generations"
PATCH_PX = 512
STYLE_MAX = 120

PROMPT_TEMPLATE = (
    "Embroidered circular astronaut mission patch, NASA Artemis style, flat embroidery texture, thick stitched "
    "border, central motif: {motif}, set above the rim of Shackleton crater at the lunar south pole with Earth "
    "low on the horizon, color palette: {colors}. No text, no letters, no numbers."
)


class PatchError(RuntimeError):
    pass


def sanitize(text: str, limit: int = STYLE_MAX) -> str:
    text = re.sub(r"[\"'`<>{}\[\]\\]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def build_prompt(profile: Profile, style: str = "") -> str:
    motif = sanitize(profile.patch.motif, 200)
    if style:
        motif = f"{motif}, {sanitize(style)}"
    return PROMPT_TEMPLATE.format(motif=motif, colors=sanitize(profile.patch.colors, 80))


def to_png(raw: bytes) -> bytes:
    """Normalise PNG/JPEG/WebP bytes to a square PATCH_PX PNG."""
    img = Image.open(io.BytesIO(raw)).convert("RGBA")
    side = min(img.size)
    left, top = (img.width - side) // 2, (img.height - side) // 2
    img = img.crop((left, top, left + side, top + side)).resize((PATCH_PX, PATCH_PX), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, "PNG", optimize=True)
    return out.getvalue()


async def generate_image(prompt: str, api_key: str, model: str, client: httpx.AsyncClient) -> bytes:
    resp = await client.post(IMAGES_URL, headers={"Authorization": f"Bearer {api_key}"},
                             json={"model": model, "prompt": prompt, "n": 1, "response_format": "b64_json"})
    if resp.status_code >= 400:
        raise PatchError(f"xAI images returned {resp.status_code}: {resp.text[:200]}")
    data = (resp.json().get("data") or [{}])[0]
    if data.get("b64_json"):
        return base64.b64decode(data["b64_json"])
    if data.get("url"):
        img = await client.get(data["url"])
        img.raise_for_status()
        return img.content
    raise PatchError("image response had neither b64_json nor url")


def fallback_svg(profile: Profile) -> str:
    initials = "".join(w[0] for w in re.findall(r"[A-Za-z]+", profile.name.split(".")[-1])[:2]).upper() or "LH"
    digest = hashlib.sha1(profile.id.encode()).hexdigest()
    hue = int(digest[:2], 16) * 360 // 256
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <circle cx="100" cy="100" r="96" fill="hsl({hue},45%,22%)" stroke="hsl({(hue + 40) % 360},70%,60%)" stroke-width="8"/>
  <circle cx="100" cy="120" r="46" fill="#bdb8ad"/>
  <circle cx="148" cy="58" r="14" fill="#4a8fd8"/>
  <text x="100" y="78" font-family="sans-serif" font-size="34" font-weight="700" text-anchor="middle"
        fill="#f4efe6">{initials}</text>
</svg>"""


class PatchService:
    def __init__(self, data_dir: Path, api_key: str, model: str) -> None:
        self.dir = data_dir / "patches"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.api_key, self.model = api_key, model

    def path(self, profile_id: str) -> Path:
        return self.dir / f"{profile_id}.png"

    def url(self, profile: Profile) -> tuple[str, str]:
        """(url, source) for the HUD; versioned by content hash so browsers refetch after regeneration."""
        p = self.path(profile.id)
        if p.exists():
            return f"/patches/{profile.id}.png?v={hashlib.sha1(p.read_bytes()).hexdigest()[:8]}", "grok-imagine"
        svg = self.dir / f"{profile.id}.svg"
        if not svg.exists():
            svg.write_text(fallback_svg(profile))
        return f"/patches/{profile.id}.svg", "fallback"

    async def ensure(self, profile: Profile) -> bool:
        if self.path(profile.id).exists():
            return False
        await self.generate(profile)
        return True

    async def generate(self, profile: Profile, style: str = "") -> Path:
        if not self.api_key:
            raise PatchError("XAI_API_KEY is not set")
        prompt = build_prompt(profile, style)
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
            raw = await generate_image(prompt, self.api_key, self.model, client)
        png = to_png(raw)
        dest = self.path(profile.id)
        if dest.exists():
            shutil.copy(dest, self.dir / f"{profile.id}.prev.png")
        dest.write_bytes(png)
        log.info("generated mission patch for %s (%d bytes)", profile.id, len(png))
        return dest

    def revert(self, profile_id: str) -> bool:
        prev = self.dir / f"{profile_id}.prev.png"
        if not prev.exists():
            return False
        shutil.copy(prev, self.path(profile_id))
        return True
