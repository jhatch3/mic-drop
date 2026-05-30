"""Transcription endpoint (Stream D).

POST /api/transcribe — multipart audio in, transcript + word timestamps out,
plus an optional lenient lyrics score when reference lyrics are supplied.
"""

import asyncio
from typing import Annotated, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from common.audio import AudioDecodeError
from .lyrics import lyrics_score
from .stt import transcribe_bytes

router = APIRouter()


@router.post("/transcribe")
async def transcribe(
    take: Annotated[UploadFile, File(...)],
    reference_lyrics: Annotated[Optional[str], Form()] = None,
) -> dict:
    audio_bytes = await take.read()
    try:
        # STT is CPU-bound and blocking — run it off the event loop.
        result = await asyncio.to_thread(transcribe_bytes, audio_bytes)
    except AudioDecodeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    response: dict = {
        "transcript": result["transcript"],
        "words": result["words"],
        "provider": result["provider"],
    }
    if reference_lyrics:
        response["lyrics_score"] = lyrics_score(result["transcript"], reference_lyrics)
    return response
