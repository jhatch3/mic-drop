"""Pitch Battle backend — FastAPI app (Stream D).

Boots the API and mounts every Stream B/D router. See contracts/DIVERGENCES.md
for what diverges from the MVP spec (Socket.io session server, lyrics scoring).
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from ai.router import router as ai_router
from orchestration.router import router as orchestration_router
from reference.router import router as reference_router
from scoring.router import router as scoring_router
from transcription.live_ws import router as live_ws_router
from transcription.router import router as transcription_router

app = FastAPI(title="Pitch Battle API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


_BACKEND = Path(__file__).parent
_STATIC = _BACKEND / "static"
_MC_DIR = _BACKEND / "assets" / "mc"
_MC_DIR.mkdir(parents=True, exist_ok=True)


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.get("/test")
def mic_test_page() -> FileResponse:
    """Browser mic recorder for testing /api/transcribe end-to-end."""
    return FileResponse(_STATIC / "mic_test.html")


@app.get("/live")
def live_page() -> FileResponse:
    """Live mic streaming + real-time pitch viz over /ws/live."""
    return FileResponse(_STATIC / "live.html")


# /api/*
app.include_router(scoring_router, prefix="/api")           # Stream B: /api/score
app.include_router(transcription_router, prefix="/api")     # Stream D: /api/transcribe
app.include_router(reference_router, prefix="/api")         # Stream D: lyrics ref
app.include_router(ai_router, prefix="/api")                # Stream D: /api/mc-voice
app.include_router(orchestration_router, prefix="/api")     # Stream D: /api/match/finish

# WS
app.include_router(live_ws_router)  # /ws/live (no /api prefix)

# Static: MC audio clips. Served at /mc-audio/<match_id>.mp3 + /mc-audio/fallback.mp3.
app.mount("/mc-audio", StaticFiles(directory=_MC_DIR), name="mc-audio")
