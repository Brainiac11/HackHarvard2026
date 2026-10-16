"""Grok Voice session configuration served to the browser (PLAN.md §10.2)."""

from __future__ import annotations

from ..commands.tools import TOOLS

INSTRUCTIONS = (
    "You are CAPCOM for a lunar EVA on the Shackleton crater rim at the Moon's south pole. Be brief: one or two "
    "sentences, calm, mission-radio style. ALWAYS call a tool to read or change equipment state; never invent "
    "numbers. For any question about what the astronaut is feeling, why the glove is vibrating, or what they should "
    "do, call ask_mission_assistant and relay its explanation and action. If a tool returns ok=false, explain the "
    "reason plainly and give its hint. Units: metres, degrees, km/h. Terrain data comes from NASA's Lunar Orbiter "
    "Laser Altimeter (LOLA); say 'LOLA' when citing slopes."
)

KEYTERMS = ["LunarHaptics", "CAPCOM", "Shackleton", "Artemis", "LOLA", "rover", "drill", "regolith", "basalt",
            "haptic", "haptics", "sensitivity", "terrain", "mission patch"]


def session_config(model: str, voice: str = "eve") -> dict:
    return {
        "model": model,
        "url": f"wss://api.x.ai/v1/realtime?model={model}",
        "session": {
            "voice": voice,
            "instructions": INSTRUCTIONS,
            "reasoning": {"effort": "none"},
            "turn_detection": None,  # push-to-talk (noisy judging hall)
            "audio": {
                "input": {"format": {"type": "audio/pcm", "rate": 24000},
                          "transcription": {"keyterms": KEYTERMS}},
                "output": {"format": {"type": "audio/pcm", "rate": 24000}},
            },
            "tools": TOOLS,
        },
    }
