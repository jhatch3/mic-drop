"""Pitch Battle backend — FastAPI app (Stream D).

Boots the API and registers routers. Today only the transcription (STT) router
is implemented; the scoring (Stream B), ai, and orchestration routers are empty
scaffolds and get mounted here as they land.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from transcription.router import router as transcription_router
from transcription.live_ws import router as live_ws_router
from reference.router import router as reference_router

app = FastAPI(title="Pitch Battle API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


_STATIC = Path(__file__).parent / "static"


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


app.include_router(transcription_router, prefix="/api")
app.include_router(reference_router, prefix="/api")
app.include_router(live_ws_router)  # /ws/live (no /api prefix)

# As these land, mount them here:
# from scoring.router import router as scoring_router            # Stream B
# from ai.router import router as ai_router                      # Stream D
# from orchestration.router import router as orchestration_router  # Stream D
# app.include_router(scoring_router, prefix="/api")
# app.include_router(ai_router, prefix="/api")
# app.include_router(orchestration_router, prefix="/api")
