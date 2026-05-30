"""AI router (Stream D).

POST /api/mc-voice — standalone TTS endpoint. Orchestration uses `mc_voice.tts`
directly; this is here so the laptop can preview voice lines on its own if it
ever needs to.
"""
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from ai.mc_voice import tts

router = APIRouter()


class McVoiceRequest(BaseModel):
    text: str


@router.post("/mc-voice")
async def mc_voice(req: McVoiceRequest) -> Response:
    audio = await tts(req.text)
    if audio is None:
        raise HTTPException(status_code=503, detail="tts unavailable")
    return Response(content=audio, media_type="audio/mpeg")
