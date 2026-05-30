"""Speech-to-text (Stream D).

Turns captured audio into a transcript plus word-level timestamps. One call
feeds two consumers: captions (the transcript/words) and a lenient lyrics score
(see ``lyrics.py``).

Provider is chosen by ``STT_PROVIDER``:
  - ``mock``    : canned output, no model — always works offline.
  - ``whisper`` : local faster-whisper (CTranslate2), word timestamps.

Gemini / ElevenLabs Scribe can be added later behind the same interface.

⚠️ STT on *singing* is unreliable (sustained vowels, melisma, backing bleed).
Treat the transcript as approximate; the lyrics score it feeds is bonus-only and
never the authoritative ("money") score. See docs/speech-agent.md §3.
"""

from __future__ import annotations

import os
from typing import Protocol, TypedDict

import numpy as np

from common.audio import DEFAULT_SR, load_audio


class Word(TypedDict):
    word: str
    start: float
    end: float


class Transcript(TypedDict):
    transcript: str
    words: list[Word]
    provider: str


class STTProvider(Protocol):
    name: str

    def transcribe(self, audio: np.ndarray) -> Transcript: ...


class MockSTT:
    """Deterministic canned transcript — no model, runs anywhere."""

    name = "mock"

    def transcribe(self, audio: np.ndarray) -> Transcript:
        duration = float(len(audio)) / DEFAULT_SR
        text = "la la la singing into the microphone"
        tokens = text.split()
        # Spread fake words evenly across the clip's duration.
        step = (duration / len(tokens)) if tokens and duration > 0 else 0.3
        return {
            "transcript": text,
            "words": [
                {"word": w, "start": round(i * step, 3), "end": round((i + 1) * step, 3)}
                for i, w in enumerate(tokens)
            ],
            "provider": self.name,
        }


class WhisperSTT:
    """Local speech-to-text via faster-whisper with word-level timestamps."""

    name = "whisper"

    def __init__(self) -> None:
        self._model = None  # lazy: don't load the model until first use

    def _get_model(self):
        if self._model is None:
            from faster_whisper import WhisperModel

            model_name = os.getenv("WHISPER_MODEL", "base.en")
            device = os.getenv("WHISPER_DEVICE", "cpu")
            compute = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
            self._model = WhisperModel(model_name, device=device, compute_type=compute)
        return self._model

    def transcribe(self, audio: np.ndarray) -> Transcript:
        model = self._get_model()
        # faster-whisper accepts a float32 mono numpy array directly.
        segments, _info = model.transcribe(audio, word_timestamps=True)
        text_parts: list[str] = []
        words: list[Word] = []
        for seg in segments:
            text_parts.append(seg.text)
            for w in seg.words or []:
                words.append(
                    {
                        "word": w.word.strip(),
                        "start": round(float(w.start), 3),
                        "end": round(float(w.end), 3),
                    }
                )
        return {
            "transcript": " ".join(p.strip() for p in text_parts).strip(),
            "words": words,
            "provider": self.name,
        }


_PROVIDERS = {"mock": MockSTT, "whisper": WhisperSTT}
_instance: STTProvider | None = None


def get_provider() -> STTProvider:
    """Return the configured STT provider (cached singleton)."""
    global _instance
    if _instance is None:
        mode = os.getenv("STT_PROVIDER", "mock").lower()
        provider_cls = _PROVIDERS.get(mode, MockSTT)
        _instance = provider_cls()
    return _instance


def transcribe_bytes(audio_bytes: bytes) -> Transcript:
    """Decode encoded upload bytes and transcribe them."""
    audio = load_audio(audio_bytes)
    return get_provider().transcribe(audio)
