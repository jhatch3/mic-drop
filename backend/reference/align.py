"""Forced alignment (Stream D) — real per-word lyric timing.

Aligns KNOWN lyrics (from LRCLIB) to the song audio using torchaudio's MMS
forced-alignment pipeline (wav2vec2 CTC). This is the same forced-alignment
engine WhisperX wraps; we call it directly because the WhisperX package pins
``ctranslate2<4.5.0`` and would break our faster-whisper STT.

We align each LRC line within its own audio slice (using the line's rough LRC
timestamp as an anchor), which is fast and robust, then return precise word
start/end times. The browser wipes characters within each word by fraction, so
you get smooth letter-by-letter highlighting on real timing.
"""

from __future__ import annotations

import re

import numpy as np

_SR = 16000
_model = None
_tokenizer = None
_aligner = None

_KEEP = re.compile(r"[^a-z' ]+")
_LRC_RE = re.compile(r"\[(\d+):(\d+(?:\.\d+)?)\]")


def _load():
    """Lazily load the wav2vec2 alignment model (downloads once, then cached)."""
    global _model, _tokenizer, _aligner
    if _model is None:
        from torchaudio.pipelines import MMS_FA as bundle

        _model = bundle.get_model()
        _model.eval()
        _tokenizer = bundle.get_tokenizer()
        _aligner = bundle.get_aligner()
    return _model, _tokenizer, _aligner


def parse_lrc(text: str) -> list[dict]:
    """Parse synced LRC text → sorted ``[{t, text}]`` (t in seconds)."""
    out: list[dict] = []
    for raw in text.split("\n"):
        stamps = _LRC_RE.findall(raw)
        if not stamps:
            continue
        words = _LRC_RE.sub("", raw).strip()
        for mm, ss in stamps:
            out.append({"t": int(mm) * 60 + float(ss), "text": words})
    out.sort(key=lambda x: x["t"])
    return out


def _norm_word(w: str) -> str:
    return _KEEP.sub("", w.lower()).strip("'")


def _align_slice(audio_slice: np.ndarray, words: list[str], offset: float) -> list[dict]:
    """Forced-align one line's words within an audio slice. Returns word spans."""
    import torch

    model, tokenizer, aligner = _load()
    pairs = [(w, _norm_word(w)) for w in words]
    pairs = [(o, n) for o, n in pairs if n]
    if not pairs or audio_slice.size < _SR // 10:
        return []

    transcript = [n for _, n in pairs]
    wav = torch.from_numpy(np.ascontiguousarray(audio_slice)).unsqueeze(0)
    with torch.inference_mode():
        emission, _ = model(wav)
    token_spans = aligner(emission[0], tokenizer(transcript))
    ratio = wav.size(1) / emission.size(1) / _SR

    out: list[dict] = []
    for (orig, _n), spans in zip(pairs, token_spans):
        out.append(
            {
                "word": orig,
                "start": round(spans[0].start * ratio + offset, 3),
                "end": round(spans[-1].end * ratio + offset, 3),
            }
        )
    return out


def align_song(audio: np.ndarray, lrc_lines: list[dict], pad: float = 0.3) -> list[dict]:
    """Align every LRC line's words to the audio. Returns lines with word timings.

    Each line is aligned inside ``[line.t - pad, next_line.t + pad]`` so the
    rough LRC stamp anchors the search and alignment stays fast and local.
    """
    n = audio.size
    result: list[dict] = []
    for i, line in enumerate(lrc_lines):
        text = (line.get("text") or "").strip()
        start = line["t"]
        end = lrc_lines[i + 1]["t"] if i + 1 < len(lrc_lines) else (start + 6.0)
        if not text:
            result.append({"t": round(start, 3), "text": "", "words": []})
            continue
        s0 = max(0, int((start - pad) * _SR))
        s1 = min(n, int((end + pad) * _SR))
        words = _align_slice(audio[s0:s1], text.split(), offset=s0 / _SR)
        result.append({"t": round(start, 3), "text": text, "words": words})
    return result
