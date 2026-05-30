"""POST /api/match/finish — the one call the laptop makes at the end.

Today: stub. Reads form fields + accepts the two audio blobs (or pose data for
dance mode), returns a hardcoded FinishResponse. Replace `stub_finish` with
real fan-out (score + settle + MC + Snowflake) per `tasks/stream-D-ai-glue.md`
step 4.

gamemode field (default "karaoke"):
  "karaoke" — accepts take_p1 / take_p2 audio uploads (existing path)
  "dance"   — audio uploads are ignored; scoring already happened via
              /api/dance/score per-turn; p1_score / p2_score are passed directly
"""
from typing import Annotated, Literal, Optional

from fastapi import APIRouter, File, Form, UploadFile

from orchestration.finish import stub_finish

router = APIRouter()


@router.post("/match/finish")
async def match_finish(
    match_id: Annotated[str, Form(...)],
    song_id: Annotated[str, Form(...)],
    p1_pubkey: Annotated[str, Form(...)],
    p2_pubkey: Annotated[str, Form(...)],
    gamemode: Annotated[Literal["karaoke", "dance"], Form(...)] = "karaoke",
    # Karaoke mode: audio uploads
    take_p1: Annotated[Optional[UploadFile], File()] = None,
    take_p2: Annotated[Optional[UploadFile], File()] = None,
    # Dance mode: scores already computed per-turn by /api/dance/score
    p1_score: Annotated[Optional[int], Form()] = None,
    p2_score: Annotated[Optional[int], Form()] = None,
) -> dict:
    # Drain audio uploads if present so the connection closes cleanly.
    if take_p1 is not None:
        await take_p1.read()
    if take_p2 is not None:
        await take_p2.read()

    return stub_finish(
        match_id=match_id,
        song_id=song_id,
        p1_pubkey=p1_pubkey,
        p2_pubkey=p2_pubkey,
        gamemode=gamemode,
        p1_score=p1_score,
        p2_score=p2_score,
    )
