"""POST /api/dance/score — authoritative dance scoring.

Accepts a JSON body with the player's captured pose sequence and the song ID,
loads the reference choreography from disk, and returns a DanceScore.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from dance.scorer import score_take

router = APIRouter()

_ASSETS = Path(__file__).parent.parent.parent / "assets" / "songs"


class DanceScoreRequest(BaseModel):
    song_id: str
    player_id: str
    frames: list[dict[str, Any]]  # list[PoseFrame]


def _load_choreography(song_id: str) -> dict:
    path = _ASSETS / song_id / "choreography.json"
    if not path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"choreography.json not found for song '{song_id}'",
        )
    return json.loads(path.read_text())


@router.post("/dance/score")
async def dance_score(body: DanceScoreRequest) -> dict:
    contour = _load_choreography(body.song_id)
    return score_take(
        singer_frames=body.frames,
        contour=contour,
        player_id=body.player_id,
    )
