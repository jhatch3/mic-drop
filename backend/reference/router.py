"""Reference-track endpoint (Stream D).

POST /api/reference — accept an uploaded video/audio file (mp4, webm, mp3, wav…),
extract its audio, and return a pitch contour to sing against. PyAV pulls the
audio stream out of the container, so an mp4 with an audio track works directly.

The returned contour shares the live stream's hop, so the browser can overlay it
on the live graph and the server can score a take against it (see
common/pitch.score_contours).
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, File, HTTPException, UploadFile

from common.audio import DEFAULT_SR, AudioDecodeError, load_audio
from common.pitch import HOP, contour_from_audio

router = APIRouter()


def _extract(data: bytes) -> dict:
    audio = load_audio(data)
    contour = contour_from_audio(audio)
    return {
        "duration": round(audio.size / DEFAULT_SR, 2),
        "hop_sec": round(HOP / DEFAULT_SR, 4),
        "contour": contour,
    }


@router.post("/reference")
async def reference(file: UploadFile = File(...)) -> dict:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty file")
    try:
        # Decode + full-file pitch extraction is heavy — keep it off the loop.
        return await asyncio.to_thread(_extract, data)
    except AudioDecodeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
