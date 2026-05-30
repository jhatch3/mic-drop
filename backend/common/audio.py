"""Shared audio ingestion (Stream D).

Decodes whatever the browser uploads (webm/opus, wav, mp3, m4a, aiff, ...) into a
mono float32 numpy array at a fixed sample rate. Uses PyAV (which bundles the
ffmpeg libraries) so no system ffmpeg binary is required. 16 kHz is plenty for
both vocal pitch and speech-to-text and keeps frame timestamps aligned with the
scoring grid.

See docs/speech-agent.md §1.
"""

from __future__ import annotations

import io

import av
import numpy as np

DEFAULT_SR = 16000


class AudioDecodeError(RuntimeError):
    """Raised when the supplied audio cannot be decoded."""


def load_audio(source: bytes | str, sr: int = DEFAULT_SR) -> np.ndarray:
    """Decode audio bytes (or a file path) to mono float32 PCM at ``sr`` Hz.

    Args:
        source: raw encoded audio bytes, or a path to an audio file.
        sr: target sample rate in Hz.

    Returns:
        1-D float32 numpy array of mono samples in [-1, 1]. Empty array if the
        stream contains no audio frames.
    """
    handle: io.BytesIO | str = io.BytesIO(source) if isinstance(source, bytes) else source

    try:
        container = av.open(handle)
    except av.error.FFmpegError as exc:
        raise AudioDecodeError(f"could not open audio: {exc}") from exc

    try:
        if not container.streams.audio:
            raise AudioDecodeError("no audio stream found in input")
        stream = container.streams.audio[0]

        # Resample to mono float32 at the target rate as we decode.
        resampler = av.audio.resampler.AudioResampler(
            format="flt", layout="mono", rate=sr
        )

        chunks: list[np.ndarray] = []
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                # plane 0 holds interleaved mono float32 samples
                chunks.append(out.to_ndarray().reshape(-1))
        # Flush the resampler's internal buffer.
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray().reshape(-1))
    except av.error.FFmpegError as exc:
        raise AudioDecodeError(f"failed to decode audio: {exc}") from exc
    finally:
        container.close()

    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return np.ascontiguousarray(np.concatenate(chunks), dtype=np.float32)
