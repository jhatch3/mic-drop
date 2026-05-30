"""POST /api/match/finish — the one call the laptop makes at the end.

Today: stub. Reads form fields + accepts the two audio blobs, returns a hardcoded
FinishResponse. Replace `stub_finish` with real fan-out (score + settle + MC +
Snowflake) per `tasks/stream-D-ai-glue.md` step 4.
"""
from typing import Annotated

from fastapi import APIRouter, File, Form, UploadFile

from orchestration.finish import stub_finish

router = APIRouter()


@router.post("/match/finish")
async def match_finish(
    match_id: Annotated[str, Form(...)],
    song_id: Annotated[str, Form(...)],
    p1_pubkey: Annotated[str, Form(...)],
    p2_pubkey: Annotated[str, Form(...)],
    take_p1: Annotated[UploadFile, File(...)],
    take_p2: Annotated[UploadFile, File(...)],
) -> dict:
    # Drain the uploads so the connection closes cleanly even though we
    # discard the bytes in stub mode.
    await take_p1.read()
    await take_p2.read()
    return stub_finish(match_id, song_id, p1_pubkey, p2_pubkey)
