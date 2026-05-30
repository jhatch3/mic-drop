"""Live mic WebSocket (Stream D).

Real-time pipeline over a single WebSocket:

  client → server  binary frames: Float32 mono PCM @ 16 kHz (one frame per message)
  client → server  text JSON:
        {"type": "config", "reference_lyrics": "..."}   # optional, send first
        {"type": "stop"}                                 # finish → transcribe
  server → client  text JSON:
        {"type": "ready", "sr": 16000, "frame": 2048}
        {"type": "pitch", "t": <sec>, "midi": <float|null>, "voiced": <bool>, "conf": <float>}
        {"type": "transcript", "transcript": "...", "words": [...], "provider": "...",
                               "lyrics_score": <float?>}

Pitch is computed per frame and streamed back immediately for the live graph.
Audio is accumulated; on "stop" the whole take is transcribed (Whisper is too
slow to run per-frame). See docs/speech-agent.md.
"""

from __future__ import annotations

import asyncio
import json

import numpy as np
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from common.pitch import HOP as FRAME
from common.pitch import DEFAULT_SR, detect_pitch, score_contours
from .lyrics import lyrics_score
from .stt import get_provider

router = APIRouter()


@router.websocket("/ws/live")
async def live(ws: WebSocket) -> None:
    await ws.accept()
    sr = DEFAULT_SR
    chunks: list[np.ndarray] = []
    singer_frames: list[dict] = []
    total_samples = 0
    reference_lyrics: str | None = None
    reference_contour: list[dict] | None = None

    await ws.send_json({"type": "ready", "sr": sr, "frame": FRAME})

    try:
        while True:
            msg = await ws.receive()

            if msg["type"] == "websocket.disconnect":
                break

            data = msg.get("bytes")
            if data is not None:
                frame = np.frombuffer(data, dtype=np.float32)
                if frame.size == 0:
                    continue
                chunks.append(frame)
                t = total_samples / sr
                total_samples += frame.size

                midi, conf = detect_pitch(frame, sr)
                singer_frames.append(
                    {"t": round(t, 3), "midi": round(midi, 2) if midi is not None else None}
                )
                await ws.send_json(
                    {
                        "type": "pitch",
                        "t": round(t, 3),
                        "midi": round(midi, 2) if midi is not None else None,
                        "voiced": midi is not None,
                        "conf": round(conf, 3),
                    }
                )
                continue

            text = msg.get("text")
            if text is None:
                continue

            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                continue

            kind = payload.get("type")
            if kind == "config":
                reference_lyrics = payload.get("reference_lyrics") or None
                reference_contour = payload.get("reference") or None
            elif kind == "reset":
                chunks.clear()
                singer_frames.clear()
                total_samples = 0
            elif kind == "stop":
                audio = (
                    np.concatenate(chunks)
                    if chunks
                    else np.zeros(0, dtype=np.float32)
                )
                # Whisper is blocking + slow — run it off the event loop.
                result = await asyncio.to_thread(get_provider().transcribe, audio)
                response: dict = {"type": "transcript", **result}
                if reference_lyrics:
                    response["lyrics_score"] = lyrics_score(
                        result["transcript"], reference_lyrics
                    )
                if reference_contour:
                    response["pitch_score"] = score_contours(
                        singer_frames, reference_contour
                    )
                await ws.send_json(response)
                # ready for another take on the same socket
                chunks.clear()
                singer_frames.clear()
                total_samples = 0
    except WebSocketDisconnect:
        pass
