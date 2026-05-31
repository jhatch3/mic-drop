"""Voice personas (Stream D).

A small registry mapping a role ("mc" / "hype" / "villain") to an ElevenLabs voice_id,
so callers ask for a *role* and we resolve the id (overridable per env in config.VOICES).
`resolve()` also accepts a raw voice_id and passes it through unchanged.

`list_account_voices()` returns the voices on the configured ElevenLabs account so the
test page / frontend can populate a picker. Returns [] when ElevenLabs is mocked or down.
"""
from __future__ import annotations

from . import config


def resolve(voice: str | None) -> str:
    """role name -> voice_id; a raw voice_id passes through; None -> default role."""
    if not voice:
        voice = config.DEFAULT_VOICE_ROLE
    return config.VOICES.get(voice, voice)


def personas() -> dict[str, str]:
    """The configured role -> voice_id map."""
    return dict(config.VOICES)


def list_account_voices() -> list[dict]:
    """All voices on the account: [{voice_id, name, category}]. [] if unavailable."""
    if not config.elevenlabs_enabled():
        return []
    try:
        from elevenlabs.client import ElevenLabs

        client = ElevenLabs(api_key=config.ELEVENLABS_API_KEY)
        result = client.voices.get_all()
        items = getattr(result, "voices", result) or []
        return [
            {
                "voice_id": v.voice_id,
                "name": v.name,
                "category": getattr(v, "category", None),
            }
            for v in items
        ]
    except Exception:
        return []
