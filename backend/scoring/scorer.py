"""Authoritative pitch scoring via librosa.pyin.

Algorithm (see CLAUDE.md + tasks/stream-B-audio.md):
- Decode audio to 16 kHz mono, run pyin at 10 ms hop -> f0 (Hz) per frame.
- Convert f0 -> MIDI (NaN for unvoiced).
- For each voiced target frame, search singer frames within +/-3 frames (+/-30 ms)
  and pick the one closest in pitch. Octave-fold the difference into [-6, 6]
  semitones, convert to cents. A hit is |cents_error| <= 50.
- score = 100 * frames_hit / frames_scored.
"""
import io

import librosa
import numpy as np

HOP_MS = 10
SR = 16000
HIT_CENTS = 50
ALIGN_FRAMES = 3
ALIGN_WINDOW_S = ALIGN_FRAMES * HOP_MS / 1000  # 0.030 s


def score_take(audio_bytes: bytes, contour: dict, player_id: str) -> dict:
    y, sr = librosa.load(io.BytesIO(audio_bytes), sr=SR, mono=True)
    hop = int(sr * HOP_MS / 1000)

    f0, _, _ = librosa.pyin(
        y,
        fmin=librosa.note_to_hz("C2"),
        fmax=librosa.note_to_hz("C7"),
        sr=sr,
        hop_length=hop,
    )
    times = librosa.frames_to_time(np.arange(len(f0)), sr=sr, hop_length=hop)
    with np.errstate(divide="ignore", invalid="ignore"):
        midi = 69 + 12 * np.log2(np.where(f0 > 0, f0, np.nan) / 440)

    voiced = [
        f for f in contour["frames"]
        if f["voiced"] and f["midi"] is not None
    ]
    frames_hit = 0
    for vf in voiced:
        window = np.where(np.abs(times - vf["t"]) <= ALIGN_WINDOW_S)[0]
        if not len(window):
            continue
        candidates = midi[window]
        if np.all(np.isnan(candidates)):
            continue
        best = window[np.nanargmin(np.abs(candidates - vf["midi"]))]
        diff = midi[best] - vf["midi"]
        cents = (diff - 12 * np.round(diff / 12)) * 100  # octave fold
        if abs(cents) <= HIT_CENTS:
            frames_hit += 1

    n = len(voiced)
    return {
        "song_id": contour["song_id"],
        "player_id": player_id,
        "score": round(100 * frames_hit / n) if n else 0,
        "frames_scored": n,
        "frames_hit": frames_hit,
    }
