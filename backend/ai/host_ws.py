"""Real-time voice game-host WebSocket bridge (Stream D).

  browser mic (PCM16 @16k)  ──▶  Gemini Live  ──▶  host voice (PCM16 @24k)  ──▶  browser
                                      │
                                      └─▶ tool calls ─▶ host_tools.dispatch
                                              ├─ play_sound_effect → {sfx} control msg
                                              ├─ get_standings / get_song_info → data → model
                                              └─ start_game / *_turn / end_game → {game} control msg

Protocol
  browser → server : binary = PCM16 16k mic chunks ; JSON {"type":"text","text":...} to type
                     instead of speak ; JSON {"type":"greet"} to (re)trigger the intro.
  server → browser : binary = PCM16 24k host audio ; JSON control:
                     {"type":"sfx","name"} {"type":"game","command"} {"type":"caption","role","text"}
                     {"type":"turn_complete"} {"type":"status","msg"}
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from google.genai import types

from . import config, host_live
from .host_tools import dispatch

log = logging.getLogger(__name__)
router = APIRouter()

GREETING = ("The show is starting — play the game_show_open sound, then welcome the crowd to "
            "MIC DROP. Finish your welcome by asking the players: \"Are we ready to start?\"")


@router.websocket("/ws/host")
async def host_ws(ws: WebSocket) -> None:
    await ws.accept()
    if not config.GEMINI_API_KEY:
        await ws.send_json({"type": "status", "msg": "GEMINI_API_KEY not set"})
        await ws.close()
        return

    try:
        async with host_live.connect() as session:
            await ws.send_json({"type": "status", "msg": "connected"})
            # Kick off the spoken intro.
            await session.send_client_content(
                turns=types.Content(role="user", parts=[types.Part(text=GREETING)]),
                turn_complete=True,
            )

            rx = {"chunks": 0, "bytes": 0}

            async def browser_to_gemini() -> None:
                while True:
                    msg = await ws.receive()
                    if msg.get("type") == "websocket.disconnect":
                        raise WebSocketDisconnect()
                    if (b := msg.get("bytes")) is not None:
                        rx["chunks"] += 1
                        rx["bytes"] += len(b)
                        if rx["chunks"] % 50 == 0:
                            import numpy as np
                            arr = np.frombuffer(b, dtype="<i2")
                            peak = int(np.abs(arr).max()) if arr.size else 0
                            level = "SILENT (mic dead/wrong device)" if peak < 200 else f"OK signal (peak {peak}/32767)"
                            log.warning("host_ws RX mic: %d chunks, %d KB, audio level: %s",
                                        rx["chunks"], rx["bytes"] // 1024, level)
                            await ws.send_json({"type": "debug", "rx_chunks": rx["chunks"],
                                                "rx_kb": rx["bytes"] // 1024, "peak": peak})
                        await session.send_realtime_input(
                            audio=types.Blob(data=b, mime_type=f"audio/pcm;rate={config.LIVE_INPUT_RATE}")
                        )
                    elif (t := msg.get("text")) is not None:
                        import json
                        data = json.loads(t)
                        if data.get("type") == "text" and data.get("text"):
                            await session.send_client_content(
                                turns=types.Content(role="user", parts=[types.Part(text=data["text"])]),
                                turn_complete=True,
                            )
                        elif data.get("type") == "greet":
                            await session.send_client_content(
                                turns=types.Content(role="user", parts=[types.Part(text=GREETING)]),
                                turn_complete=True,
                            )

            async def gemini_to_browser() -> None:
                async for m in session.receive():
                    sc0 = m.server_content
                    log.warning("host_ws RX gemini: tool=%s turn_complete=%s interrupted=%s "
                                "in_tx=%s out_tx=%s model_turn=%s",
                                bool(m.tool_call),
                                getattr(sc0, "turn_complete", None) if sc0 else None,
                                getattr(sc0, "interrupted", None) if sc0 else None,
                                bool(sc0 and sc0.input_transcription and sc0.input_transcription.text),
                                bool(sc0 and sc0.output_transcription and sc0.output_transcription.text),
                                bool(sc0 and sc0.model_turn))
                    if m.tool_call:
                        for fc in m.tool_call.function_calls:
                            response, action = await dispatch(fc.name, dict(fc.args or {}))
                            await session.send_tool_response(
                                function_responses=[types.FunctionResponse(
                                    id=fc.id, name=fc.name, response=response)]
                            )
                            if action:
                                await ws.send_json(action)
                    sc = m.server_content
                    if not sc:
                        continue
                    if sc.output_transcription and sc.output_transcription.text:
                        await ws.send_json({"type": "caption", "role": "host",
                                            "text": sc.output_transcription.text})
                    if sc.input_transcription and sc.input_transcription.text:
                        log.warning("host_ws Gemini heard you: %r", sc.input_transcription.text)
                        await ws.send_json({"type": "caption", "role": "user",
                                            "text": sc.input_transcription.text})
                    if sc.model_turn:
                        for p in sc.model_turn.parts:
                            if p.inline_data and p.inline_data.data:
                                await ws.send_bytes(p.inline_data.data)
                    if sc.turn_complete:
                        await ws.send_json({"type": "turn_complete"})

            await asyncio.gather(browser_to_gemini(), gemini_to_browser())

    except WebSocketDisconnect:
        log.info("host_ws: client disconnected")
    except Exception as e:  # noqa: BLE001
        log.exception("host_ws error")
        try:
            await ws.send_json({"type": "status", "msg": f"error: {type(e).__name__}: {e}"})
        except Exception:
            pass
    finally:
        try:
            await ws.close()
        except Exception:
            pass
