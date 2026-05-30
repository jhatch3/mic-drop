"""Sound effects (Stream D) — generate-then-cache.

A named catalog of game-moment SFX. `get_sfx_path(name)` returns a local mp3, generating
it once via ElevenLabs text-to-sound-effects and caching it under assets/sfx/<name>.mp3;
every later play is served straight from disk (free, instant). If a clip is already
committed there, it's used as-is and no API call is made.

`generate(prompt, duration)` is the ad-hoc path for one-off prompts.

All functions degrade gracefully: a missing key / API error returns None (or a committed
clip if present) rather than raising.
"""
from __future__ import annotations

from . import config

# name -> (prompt, duration_seconds). The MC's standard cue palette.
CATALOG: dict[str, tuple[str, float]] = {
    "airhorn": ("celebratory air horn blast, short and punchy", 1.5),
    "drumroll": ("snare drum roll building to a cymbal crash", 3.0),
    "applause": ("enthusiastic crowd cheering and applause", 3.0),
    "sad_trombone": ("comedic sad trombone, womp womp", 2.0),
    "ding": ("bright correct-answer chime, single ding", 1.0),
    "buzzer": ("harsh game-show wrong-answer buzzer", 1.0),
    "suspense": ("tense game-show suspense sting before a reveal", 3.0),
    "record_scratch": ("vinyl record scratch stop", 1.0),
}


def _cached_path(name: str):
    return config.SFX_ASSET_DIR / f"{name}.mp3"


def _generate_bytes(prompt: str, duration: float) -> bytes | None:
    if not config.elevenlabs_enabled():
        return None
    try:
        from elevenlabs.client import ElevenLabs

        client = ElevenLabs(api_key=config.ELEVENLABS_API_KEY)
        chunks = client.text_to_sound_effects.convert(
            text=prompt,
            duration_seconds=duration,
            prompt_influence=config.SFX_PROMPT_INFLUENCE,
            model_id=config.SFX_MODEL,
        )
        return b"".join(chunks)
    except Exception:
        return None


def get_sfx_path(name: str):
    """Path to a catalog clip, generating + caching on first use. None if unknown/unavailable."""
    if name not in CATALOG:
        return None
    path = _cached_path(name)
    if path.is_file():
        return path
    prompt, duration = CATALOG[name]
    audio = _generate_bytes(prompt, duration)
    if not audio:
        return None
    try:
        config.SFX_ASSET_DIR.mkdir(parents=True, exist_ok=True)
        path.write_bytes(audio)
    except Exception:
        return None
    return path


def generate(prompt: str, duration: float = 3.0) -> bytes | None:
    """Ad-hoc one-off SFX from a free-text prompt (not cached). None if unavailable."""
    return _generate_bytes(prompt, max(0.5, min(duration, 30.0)))


def catalog() -> dict[str, dict]:
    """The named SFX palette: {name: {prompt, duration, cached}}."""
    return {
        name: {"prompt": p, "duration": d, "cached": _cached_path(name).is_file()}
        for name, (p, d) in CATALOG.items()
    }
