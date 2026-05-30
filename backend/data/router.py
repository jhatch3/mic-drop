"""Read-only Snowflake-backed catalog endpoints.

- GET /api/songs       — song catalog for the Host song-picker
- GET /api/leaderboard — top players by wins
"""
import logging

from fastapi import APIRouter, HTTPException, Query

from data.matches_store import get_leaderboard
from data.songs_store import list_catalog

router = APIRouter()
log = logging.getLogger(__name__)


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
