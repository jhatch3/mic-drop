"""POST /api/match/finish — the one call the laptop makes at the end.

gamemode field (default "karaoke"):
  "karaoke" — accepts take_p1 / take_p2 audio uploads (existing path)
  "dance"   — audio uploads are ignored; scoring already happened via
              /api/dance/score per-turn; p1_score / p2_score are passed directly
"""
from typing import Annotated, Literal, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from orchestration.finish import handle_finish

router = APIRouter()


@router.post("/match/finish")
async def match_finish(
    match_id: Annotated[str, Form(...)],
    song_id: Annotated[str, Form(...)],
    p1_pubkey: Annotated[str, Form(...)],
    p2_pubkey: Annotated[str, Form(...)],
    gamemode: Annotated[Literal["karaoke", "dance"], Form(...)] = "karaoke",
    take_p1: Annotated[Optional[UploadFile], File()] = None,
    take_p2: Annotated[Optional[UploadFile], File()] = None,
    p1_score: Annotated[Optional[int], Form()] = None,
    p2_score: Annotated[Optional[int], Form()] = None,
    stake_lamports: Annotated[int, Form()] = 0,
    fee_bps: Annotated[int, Form()] = 0,
) -> dict:
    p1_bytes = await take_p1.read() if take_p1 is not None else None
    p2_bytes = await take_p2.read() if take_p2 is not None else None

    if gamemode == "karaoke" and (not p1_bytes or not p2_bytes):
        raise HTTPException(status_code=400, detail="both takes must be non-empty for karaoke mode")

    return await handle_finish(
        match_id=match_id,
        song_id=song_id,
        p1_pubkey=p1_pubkey,
        p2_pubkey=p2_pubkey,
        p1_bytes=p1_bytes,
        p2_bytes=p2_bytes,
        stake_lamports=stake_lamports,
        fee_bps=fee_bps,
        gamemode=gamemode,
        p1_score=p1_score,
        p2_score=p2_score,
    )
