"""MC voice (Stream D).

`roast_text` builds the script; `tts` calls ElevenLabs. Both are best-effort —
the caller MUST fall back to `assets/mc_fallback.mp3` if `tts` returns None.
"""
import os

import httpx

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "pNInz6obpgDQGcFmaJgB")  # Adam
TTS_TIMEOUT_S = 4.0


def roast_text(song: str, p1_score: int, p2_score: int, winner: str) -> str:
    """Hand-written roast template — replace with Gemini once /api/commentary lands."""
    if winner == "tie":
        return (f"A tie at {p1_score} apiece on {song}. "
                f"Two voices, equally cursed. The pot goes back to both of you.")
    w = "Player 1" if winner == "p1" else "Player 2"
    loser = "Player 2" if winner == "p1" else "Player 1"
    ws = p1_score if winner == "p1" else p2_score
    ls = p2_score if winner == "p1" else p1_score
    return (f"{w} wins with {ws} points — congratulations. "
            f"{loser} scored {ls}. I've heard better pitch from a broken kazoo. "
            f"The SOL goes to {w}.")


async def tts(text: str) -> bytes | None:
    """ElevenLabs streaming TTS. Returns None on missing key, timeout, or HTTP error.

    Caller is responsible for serving a fallback clip when this returns None.
    """
    if not ELEVENLABS_API_KEY:
        return None
    try:
        async with httpx.AsyncClient(timeout=TTS_TIMEOUT_S) as client:
            r = await client.post(
                f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}",
                headers={"xi-api-key": ELEVENLABS_API_KEY},
                json={
                    "text": text,
                    "model_id": "eleven_monolingual_v1",
                    "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
                },
            )
        return r.content if r.is_success else None
    except httpx.HTTPError:
        return None
