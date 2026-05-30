"""POST /api/match/finish — the one call the laptop makes at the end."""
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from orchestration.finish import handle_finish

router = APIRouter()


@router.post("/match/finish")
async def match_finish(
    match_id: Annotated[str, Form(...)],
    song_id: Annotated[str, Form(...)],
    p1_pubkey: Annotated[str, Form(...)],
    p2_pubkey: Annotated[str, Form(...)],
    take_p1: Annotated[UploadFile, File(...)],
    take_p2: Annotated[UploadFile, File(...)],
    stake_lamports: Annotated[int, Form()] = 0,
    fee_bps: Annotated[int, Form()] = 0,
) -> dict:
    p1_bytes = await take_p1.read()
    p2_bytes = await take_p2.read()
    if not p1_bytes or not p2_bytes:
        raise HTTPException(status_code=400, detail="both takes must be non-empty")

    return await handle_finish(
        match_id=match_id,
        song_id=song_id,
        p1_pubkey=p1_pubkey,
        p2_pubkey=p2_pubkey,
        p1_bytes=p1_bytes,
        p2_bytes=p2_bytes,
        stake_lamports=stake_lamports,
        fee_bps=fee_bps,
    )
