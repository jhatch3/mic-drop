"""Read-only Snowflake-backed catalog endpoints.

- GET /api/songs       — song catalog for the Host song-picker
- GET /api/leaderboard — top players by wins
"""
import logging

from fastapi import APIRouter, HTTPException, Query

from typing import Optional

from data.matches_store import get_leaderboard, get_top_scores
from data.songs_store import get_choreography, list_catalog

router = APIRouter()
log = logging.getLogger(__name__)


@router.get("/songs/{song_id}/choreography")
def song_choreography(song_id: str) -> dict:
    try:
        return get_choreography(song_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        log.exception("choreography fetch failed")
        raise HTTPException(status_code=503, detail=f"snowflake unavailable: {e}")


@router.get("/songs")
def songs() -> list[dict]:
    try:
        return list_catalog()
    except Exception as e:  # noqa: BLE001 — return 503 so the UI can fall back
        log.exception("songs catalog fetch failed")
        raise HTTPException(status_code=503, detail=f"snowflake unavailable: {e}")


@router.get("/leaderboard")
def leaderboard(limit: int = Query(20, ge=1, le=100)) -> list[dict]:
    try:
        return get_leaderboard(limit=limit)
    except Exception as e:  # noqa: BLE001
        log.exception("leaderboard fetch failed")
        # Empty list is a better UX than 5xx — the result screen still renders.
        return []


@router.get("/leaderboard/scores")
def top_scores(
    song_id: Optional[str] = Query(None),
    gamemode: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
) -> list[dict]:
    """Highest individual take scores, optionally filtered to one song_id and/or gamemode."""
    try:
        return get_top_scores(song_id=song_id, gamemode=gamemode, limit=limit)
    except Exception:  # noqa: BLE001
        log.exception("top-scores fetch failed")
        return []
