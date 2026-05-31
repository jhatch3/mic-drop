"""MC voice (Stream D).

`get_voice()` returns a provider picked by ELEVENLABS_MODE:
  - MockVoice       — serves the pre-generated fallback clip (or None).
  - ElevenLabsVoice — real streaming TTS. `stream()` yields chunks for a
    StreamingResponse (low latency); `synthesize()` collects the full clip AND saves it
    to MC_ASSET_DIR/<key>.mp3 so the orchestrator can return a served mc_audio_url.

Both calls take a `voice` (persona role like "mc"/"hype"/"villain" or a raw voice_id) and
an `expressive` flag. expressive=True uses the v3 model, which understands inline emotion
audio tags like [excited]/[sarcastic]; expressive=False uses the fast flash model and the
tags are stripped first so they aren't read aloud.

Everything degrades gracefully: a missing key, timeout, or HTTP error yields the fallback
clip (stream) or None (synthesize), never an exception.
"""
from __future__ import annotations

import asyncio
import re
from typing import AsyncIterator, Protocol

from . import config, voices

# Back-compat re-export: roast text now lives with the commentary providers.
from .commentary import MockCommentary  # noqa: E402

_TAG_RE = re.compile(r"\[[^\]\n]{1,40}\]")


def strip_audio_tags(text: str) -> str:
    """Remove [emotion] audio tags + tidy whitespace (for non-v3 models)."""
    return re.sub(r"\s{2,}", " ", _TAG_RE.sub("", text)).strip()


def roast_text(song: str, p1_score: int, p2_score: int, winner: str) -> str:
    """Synchronous canned roast (delegates to MockCommentary). Kept for callers that
    want a quick line without the async provider."""
    return asyncio.run(
        MockCommentary().generate(
            song=song, p1_score=p1_score, p2_score=p2_score, winner=winner, players={}
        )
    )


async def _aiter_sync_stream(make_gen) -> AsyncIterator[bytes]:
    """Drive a *synchronous* chunk generator from async code via a worker thread."""
    queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def produce() -> None:
        try:
            for chunk in make_gen():
                if chunk:
                    loop.call_soon_threadsafe(queue.put_nowait, bytes(chunk))
        except Exception:
            pass
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    fut = loop.run_in_executor(None, produce)
    try:
        while True:
            chunk = await queue.get()
            if chunk is None:
                break
            yield chunk
    finally:
        await fut


class VoiceProvider(Protocol):
    def stream(
        self, text: str, voice: str | None = None, expressive: bool = False
    ) -> AsyncIterator[bytes]: ...
    async def synthesize(
        self, text: str, key: str | None = None, voice: str | None = None,
        expressive: bool = False,
    ) -> bytes | None: ...


class MockVoice:
    """Serves the committed fallback clip; no network, no keys."""

    def _fallback_bytes(self) -> bytes | None:
        p = config.FALLBACK_CLIP
        return p.read_bytes() if p.is_file() else None

    async def stream(
        self, text: str, voice: str | None = None, expressive: bool = False
    ) -> AsyncIterator[bytes]:
        data = self._fallback_bytes()
        if data:
            yield data

    async def synthesize(
        self, text: str, key: str | None = None, voice: str | None = None,
        expressive: bool = False,
    ) -> bytes | None:
        return self._fallback_bytes()


class ElevenLabsVoice:
    """Real ElevenLabs streaming TTS with persona + emotion support."""

    def __init__(self) -> None:
        from elevenlabs.client import ElevenLabs  # lazy: only when ELEVENLABS_MODE=real

        self._client = ElevenLabs(api_key=config.ELEVENLABS_API_KEY)
        self._fallback = MockVoice()

    def _make_gen(self, text: str, voice: str | None, expressive: bool):
        model_id = config.ELEVENLABS_V3_MODEL if expressive else config.ELEVENLABS_MODEL
        if not expressive:
            text = strip_audio_tags(text)  # flash would read tags aloud
        return self._client.text_to_speech.stream(
            text=text,
            voice_id=voices.resolve(voice),
            model_id=model_id,
        )

    async def stream(
        self, text: str, voice: str | None = None, expressive: bool = False
    ) -> AsyncIterator[bytes]:
        produced = False
        try:
            async for chunk in _aiter_sync_stream(
                lambda: self._make_gen(text, voice, expressive)
            ):
                produced = True
                yield chunk
        except Exception:
            pass
        if not produced:  # nothing came back — serve the fallback clip
            async for chunk in self._fallback.stream(text):
                yield chunk

    async def _collect_all(self, text: str, voice: str | None, expressive: bool) -> bytes:
        chunks: list[bytes] = []
        async for chunk in _aiter_sync_stream(
            lambda: self._make_gen(text, voice, expressive)
        ):
            chunks.append(chunk)
        return b"".join(chunks)

    async def synthesize(
        self, text: str, key: str | None = None, voice: str | None = None,
        expressive: bool = False,
    ) -> bytes | None:
        try:
            audio = await asyncio.wait_for(
                self._collect_all(text, voice, expressive), timeout=config.TTS_TIMEOUT_S
            )
        except Exception:
            audio = b""
        if not audio:
            return await self._fallback.synthesize(text, key)
        if key:
            try:
                config.MC_ASSET_DIR.mkdir(parents=True, exist_ok=True)
                (config.MC_ASSET_DIR / f"{key}.mp3").write_bytes(audio)
            except Exception:
                pass
        return audio


def get_voice() -> VoiceProvider:
    """Pick the voice provider from ELEVENLABS_MODE (+ a key being present)."""
    if config.elevenlabs_enabled():
        try:
            return ElevenLabsVoice()
        except Exception:
            pass
    return MockVoice()
