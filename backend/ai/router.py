"""AI router (Stream D).

POST /api/commentary    — Gemini roast text (spec §8.2). Tool-using when GEMINI_MODE=real.
                          expressive=True asks for inline v3 emotion tags.
POST /api/mc-voice      — ElevenLabs streaming TTS (spec §8.3). Pick a persona/voice and
                          expressive emotion.
GET  /api/voices        — persona map + the account's voices (for a picker).
GET  /api/sfx           — the named sound-effect catalog.
GET  /api/sfx/{name}    — a catalog clip (generated + cached on first use).
POST /api/sfx           — ad-hoc sound effect from a free-text prompt.
"""
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel

from ai import config, sfx, voices
from ai.commentary import get_commentary
from ai.mc_voice import get_voice

router = APIRouter()


@router.get("/ai/status")
def ai_status() -> dict:
    """What the MC will actually do right now — used by the /mc-test page."""
    return {
        "gemini": {
            "mode": config.GEMINI_MODE,
            "active": config.gemini_enabled(),  # real AND a key is present
            "model": config.GEMINI_MODEL,
            "max_tool_calls": config.GEMINI_MAX_TOOL_CALLS,
        },
        "elevenlabs": {
            "mode": config.ELEVENLABS_MODE,
            "active": config.elevenlabs_enabled(),
            "model": config.ELEVENLABS_MODEL,
            "v3_model": config.ELEVENLABS_V3_MODEL,
            "default_voice_role": config.DEFAULT_VOICE_ROLE,
            "fallback_clip": config.FALLBACK_CLIP.is_file(),
        },
    }


# ---- commentary ----

class CommentaryRequest(BaseModel):
    song: str
    p1_score: int
    p2_score: int
    winner: str  # "p1" | "p2" | "tie"
    players: dict[str, str] = {}  # {"p1": pubkey, "p2": pubkey} (optional)
    expressive: bool = False       # emit inline v3 emotion tags


@router.post("/commentary")
async def commentary(req: CommentaryRequest) -> dict:
    text = await get_commentary().generate(
        song=req.song,
        p1_score=req.p1_score,
        p2_score=req.p2_score,
        winner=req.winner,
        players=req.players,
        expressive=req.expressive,
    )
    return {"commentary": text}


# ---- voice ----

class McVoiceRequest(BaseModel):
    text: str
    voice: str | None = None   # persona role ("mc"/"hype"/"villain") or a raw voice_id
    expressive: bool = False   # use the v3 model so [emotion] tags are performed


@router.post("/mc-voice")
async def mc_voice(req: McVoiceRequest) -> StreamingResponse:
    return StreamingResponse(
        get_voice().stream(req.text, voice=req.voice, expressive=req.expressive),
        media_type="audio/mpeg",
    )


@router.get("/voices")
def list_voices() -> dict:
    """Persona role->voice_id map + every voice on the account (for a picker)."""
    return {"personas": voices.personas(), "account": voices.list_account_voices()}


# ---- sound effects ----

@router.get("/sfx")
def sfx_catalog() -> dict:
    """The named SFX palette: {name: {prompt, duration, cached}}."""
    return {"catalog": sfx.catalog()}


@router.get("/sfx/{name}")
def sfx_clip(name: str) -> FileResponse:
    """Serve a catalog clip, generating + caching it on first use."""
    path = sfx.get_sfx_path(name)
    if path is None:
        raise HTTPException(status_code=404, detail=f"sfx unavailable: {name}")
    return FileResponse(path, media_type="audio/mpeg")


class SfxRequest(BaseModel):
    prompt: str
    duration: float = 3.0


@router.post("/sfx")
def sfx_generate(req: SfxRequest) -> Response:
    """Ad-hoc one-off sound effect from a free-text prompt."""
    audio = sfx.generate(req.prompt, req.duration)
    if not audio:
        raise HTTPException(status_code=503, detail="sfx generation unavailable")
    return Response(content=audio, media_type="audio/mpeg")
