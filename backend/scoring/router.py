"""POST /api/score — authoritative scoring endpoint."""
from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from data.songs_store import get_contour
from scoring.scorer import score_take

router = APIRouter()


@router.post("/score")
async def score(
    song_id: str = Form(...),
    player_id: str = Form(...),
    audio: UploadFile = File(...),
) -> dict:
    try:
        contour = get_contour(song_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"unknown song_id: {song_id}")

    audio_bytes = await audio.read()
    return score_take(audio_bytes, contour, player_id)
