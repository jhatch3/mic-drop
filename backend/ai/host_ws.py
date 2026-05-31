"""Real-time voice game-host WebSocket bridge (Stream D).

  Gemini (TEXT, streaming + tool calls)  ──▶  split into sentences  ──▶  ElevenLabs TTS
  (custom voice, PCM 24k)  ──▶  browser speakers  (+ closed captions)

The host's brain is a streaming Gemini chat (manual function calling). As text tokens
arrive they're buffered into whole sentences and each sentence is spoken IMMEDIATELY via
ElevenLabs streaming TTS — so the host starts talking on sentence 1 instead of generating a
whole paragraph and playing it late. Tool calls (start_p1_turn / reveal_scores / sfx / …)
are dispatched manually so we can relay control messages to the browser.

Protocol
  browser → server : JSON {"type":"text","text":...} (your STT reply) ; {"type":"greet"} ;
                     {"type":"mode",...} (accepted, ignored). No mic audio is sent.
  server → browser : binary = PCM16 24k host audio (ElevenLabs) ; JSON control:
                     {"type":"caption","role","text"} {"type":"game","command"}
                     {"type":"sfx","name"} {"type":"turn_complete"} {"type":"status","msg"}
"""
from __future__ import annotations

import asyncio
import json
import logging
import re

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from google import genai
from google.genai import types

from . import config
from .host_live import system_prompt
from .host_tools import TOOL, dispatch
from .mc_voice import get_voice

log = logging.getLogger(__name__)
router = APIRouter()

GREETING = ("The show is starting — play the game_show_open sound, then welcome the crowd to "
            "MIC DROP in ONE short line and ask: \"Player 1, are you ready?\" Then stop and wait — "
            "do not call any tool until Player 1 answers that they're ready.")

HOST_VOICE_ROLE = "mc"   # ElevenLabs persona for the live host (the custom game-show voice)

# AUDIO is spoken a full sentence at a time (one ElevenLabs utterance = smooth, no gaps).
# CAPTIONS are split into small phrases (~0.5–1.25 sentences) and shown on a timeline across
# the sentence's audio, so the words advance with the voice without chopping the speech.
_SENTENCE = re.compile(r"(.+?[.!?]+[\"')\]]*)(\s+|$)", re.S)
_MIN_WORDS = 5
_MAX_WORDS = 14
_SENT_END = re.compile(r"[.!?][\"')\]]*$")
_CLAUSE_END = re.compile(r"[,;:—–]$")


def _phrase_end(buf: str, final: bool) -> int:
    """Index at which to cut the next caption phrase out of `buf`, or -1 to wait for more."""
    words = list(re.finditer(r"\S+", buf))
    if not words:
        return -1
    for i, w in enumerate(words):
        tok = w.group()
        if _SENT_END.search(tok):
            return w.end()
        if i + 1 >= _MIN_WORDS and _CLAUSE_END.search(tok):
            return w.end()
        if i + 1 >= _MAX_WORDS:
            return w.end()
    return len(buf) if final else -1


def _split_phrases(text: str) -> list[str]:
    """Break one sentence into caption-sized phrases."""
    out: list[str] = []
    buf = text.strip()
    while buf:
        i = _phrase_end(buf, True)
        if i <= 0:
            out.append(buf.strip())
            break
        seg = buf[:i].strip()
        if seg:
            out.append(seg)
        buf = buf[i:].lstrip()
    return out or [text.strip()]


@router.websocket("/ws/host")
async def host_ws(ws: WebSocket) -> None:
    await ws.accept()
    if not config.GEMINI_API_KEY:
        await ws.send_json({"type": "status", "msg": "GEMINI_API_KEY not set"})
        await ws.close()
        return

    gamemode = (ws.query_params.get("mode") or "karaoke").lower()
    if gamemode not in ("karaoke", "dance"):
        gamemode = "karaoke"
    client = genai.Client(api_key=config.GEMINI_API_KEY)
    voice = get_voice()

    def make_cfg() -> types.GenerateContentConfig:
        return types.GenerateContentConfig(
            system_instruction=system_prompt(state["gamemode"]),
            tools=[TOOL],
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        )
    # gamemode can also arrive in the first {"type":"mode"} message (robust if the WS query
    # string is stripped by a proxy/tunnel). The system prompt is rebuilt per turn from it.
    state = {"gamemode": gamemode}
    contents: list[types.Content] = []
    turn_lock = asyncio.Lock()   # one host turn generates/speaks at a time

    # Cumulative audio (ms) queued in the CURRENT turn pass — the clock that captions and tool
    # actions are scheduled against, so on-screen events fire exactly when his voice reaches them.
    am = {"ms": 0.0}

    async def speak(sentence: str) -> None:
        """Speak ONE full sentence (smooth ElevenLabs utterance) and send timed phrase captions."""
        sentence = sentence.strip()
        if not sentence:
            return
        phrases = _split_phrases(sentence)
        base = am["ms"]   # audio offset (ms from the pass anchor) where this sentence starts
        total_bytes = 0
        rem = bytearray()
        try:
            async for chunk in voice.stream_pcm(sentence, voice=HOST_VOICE_ROLE):
                total_bytes += len(chunk)
                rem += chunk
                n = len(rem) - (len(rem) % 2)   # browser needs whole 16-bit samples
                if n:
                    await ws.send_bytes(bytes(rem[:n]))
                    del rem[:n]
        except Exception:  # noqa: BLE001 — never let TTS kill the turn
            log.exception("host TTS failed for sentence")
        dur_ms = (total_bytes / 2) / 24000 * 1000 if total_bytes else 0.0
        total_chars = sum(len(p) for p in phrases) or 1
        cues, acc = [], 0
        for p in phrases:
            cues.append({"text": p, "offset_ms": int(base + (acc / total_chars) * dur_ms)})
            acc += len(p)
        am["ms"] = base + dur_ms
        await ws.send_json({"type": "caption_cues", "cues": cues})

    async def flush_sentences(buf: str, *, final: bool) -> str:
        """Speak each complete sentence in `buf`; return the trailing incomplete remainder."""
        while True:
            m = _SENTENCE.match(buf)
            if not m:
                break
            await speak(m.group(1))
            buf = buf[m.end():]
            if not buf:
                break
        if final and buf.strip():
            await speak(buf)
            buf = ""
        return buf

    async def run_turn(user_text: str) -> None:
        async with turn_lock:
            contents.append(types.Content(role="user", parts=[types.Part(text=user_text)]))
            try:
                while True:   # function-calling loop
                    # Anchor this pass's audio clock on the browser, then reset our offset.
                    await ws.send_json({"type": "audio_anchor"})
                    am["ms"] = 0.0
                    text_acc, buf = "", ""
                    fcs: list[tuple[types.FunctionCall, float]] = []   # (call, audio offset ms)
                    stream = await client.aio.models.generate_content_stream(
                        model=config.GEMINI_MODEL, contents=contents, config=make_cfg(),
                    )
                    async for chunk in stream:
                        for cand in (chunk.candidates or []):
                            if not cand.content:
                                continue
                            for p in (cand.content.parts or []):
                                if getattr(p, "text", None):
                                    text_acc += p.text
                                    buf += p.text
                                    buf = await flush_sentences(buf, final=False)
                                if getattr(p, "function_call", None):
                                    fcs.append((p.function_call, am["ms"]))   # tag with WHERE in the audio

                    await flush_sentences(buf, final=True)

                    # record the model's turn in history (text + any tool calls)
                    model_parts: list[types.Part] = []
                    if text_acc:
                        model_parts.append(types.Part(text=text_acc))
                    model_parts.extend(types.Part(function_call=fc) for fc, _ in fcs)
                    if model_parts:
                        contents.append(types.Content(role="model", parts=model_parts))

                    if not fcs:
                        break
                    # run the tools, relay control messages (timed to the audio), feed responses back
                    resp_parts: list[types.Part] = []
                    for fc, at_ms in fcs:
                        response, action = await dispatch(fc.name, dict(fc.args or {}))
                        resp_parts.append(types.Part.from_function_response(name=fc.name, response=response))
                        if action:
                            await ws.send_json({**action, "at_ms": int(at_ms)})
                    contents.append(types.Content(role="user", parts=resp_parts))
            except Exception:  # noqa: BLE001
                log.exception("host turn failed")
            finally:
                await ws.send_json({"type": "turn_complete"})

    await ws.send_json({"type": "status", "msg": "connected"})

    greeted = {"done": False}
    def greet_once() -> None:
        if not greeted["done"]:
            greeted["done"] = True
            asyncio.create_task(run_turn(GREETING))

    # Greet once we know the gamemode (from the mode message), with a short fallback so we
    # never stall if no mode message arrives — by then the query-param default is used.
    async def greet_fallback() -> None:
        await asyncio.sleep(0.5)
        greet_once()
    asyncio.create_task(greet_fallback())

    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            t = msg.get("text")
            if t is None:
                continue   # ignore any binary (no mic audio in this design)
            try:
                data = json.loads(t)
            except Exception:
                continue
            kind = data.get("type")
            if kind == "mode":
                gm = (data.get("gamemode") or "").lower()
                if gm in ("karaoke", "dance"):
                    state["gamemode"] = gm
                greet_once()   # we now know the mode → greet with the right prompt
            elif kind == "text" and data.get("text"):
                greet_once()
                asyncio.create_task(run_turn(data["text"]))
            elif kind == "greet":
                asyncio.create_task(run_turn(GREETING))
            # activity_* are accepted and ignored
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
