"""Real-time pitch detection (Stream D).

A small, dependency-light (numpy only) autocorrelation pitch tracker for the live
viz. It estimates the fundamental frequency of a short mono frame and returns it
as a MIDI note number (float) plus a 0–1 confidence.

This is the *fast, for-the-graph* estimate (see the spec's "two scores, two
places"): good enough to draw a live pitch trail, never the authoritative score.
The authoritative scorer (Stream B, CREPE/pyin) is separate.

    midi = 69 + 12 * log2(f0_hz / 440)
"""

from __future__ import annotations

import numpy as np

DEFAULT_SR = 16000
HOP = 2048        # samples per analysis frame (~128 ms @ 16 kHz); live + reference share it
FMIN_HZ = 65.0    # ~C2
FMAX_HZ = 1000.0  # ~B5
CONF_THRESHOLD = 0.5
RMS_GATE = 1e-3   # silence below this RMS → unvoiced


def detect_pitch(
    frame: np.ndarray,
    sr: int = DEFAULT_SR,
    fmin: float = FMIN_HZ,
    fmax: float = FMAX_HZ,
) -> tuple[float | None, float]:
    """Estimate pitch of a mono frame.

    Returns ``(midi, confidence)``. ``midi`` is ``None`` when the frame is
    silent, unvoiced, or too short to resolve ``fmin``.
    """
    x = np.asarray(frame, dtype=np.float64).reshape(-1)
    n = x.size
    if n < 2:
        return None, 0.0

    x = x - x.mean()
    rms = float(np.sqrt(np.mean(x * x)))
    if rms < RMS_GATE:
        return None, 0.0

    # Autocorrelation via FFT (zero-padded to avoid circular wrap).
    w = x * np.hanning(n)
    spec = np.fft.rfft(w, 2 * n)
    acf = np.fft.irfft(spec * np.conj(spec))[:n]
    acf /= acf[0] + 1e-12  # normalize so acf[0] == 1

    min_lag = max(1, int(sr / fmax))
    max_lag = min(n - 1, int(sr / fmin))
    if max_lag <= min_lag:
        return None, 0.0

    segment = acf[min_lag:max_lag]
    best = int(np.argmax(segment)) + min_lag
    conf = float(acf[best])
    if conf < CONF_THRESHOLD:
        return None, conf

    # Parabolic interpolation around the peak for sub-sample lag precision.
    if 1 <= best < n - 1:
        a, b, c = acf[best - 1], acf[best], acf[best + 1]
        denom = a - 2 * b + c
        shift = (0.5 * (a - c) / denom) if denom != 0 else 0.0
        lag = best + shift
    else:
        lag = float(best)

    f0 = sr / lag
    midi = 69.0 + 12.0 * np.log2(f0 / 440.0)
    return float(midi), conf


def contour_from_audio(
    audio: np.ndarray, sr: int = DEFAULT_SR, hop: int = HOP
) -> list[dict]:
    """Detect pitch over a whole signal → list of ``{"t", "midi"}`` frames.

    ``midi`` is ``None`` on unvoiced/silent frames. Frame ``t`` is the frame's
    start time in seconds, on the same hop the live stream uses, so a reference
    contour and a live take line up directly in time.
    """
    out: list[dict] = []
    n = audio.size
    for i in range(0, max(0, n - hop + 1), hop):
        midi, _conf = detect_pitch(audio[i : i + hop], sr)
        out.append(
            {"t": round(i / sr, 3), "midi": round(midi, 2) if midi is not None else None}
        )
    return median_smooth(out)


def median_smooth(contour: list[dict], win: int = 5, jump_semi: float = 3.0) -> list[dict]:
    """Replace each frame's pitch with the local median and drop lone spikes.

    A frame survives only if it has >=3 voiced neighbors and agrees with their
    median within ``jump_semi`` semitones — mirrors the viz's outlier rejection
    so the reference line is clean and scoring isn't fooled by single-frame
    octave jumps. Dropped frames become ``midi=None``.
    """
    midis = [p["midi"] for p in contour]
    out: list[dict] = []
    half = win // 2
    for i, p in enumerate(contour):
        if p["midi"] is None:
            out.append({"t": p["t"], "midi": None})
            continue
        window = [
            midis[j]
            for j in range(max(0, i - half), min(len(midis), i + half + 1))
            if midis[j] is not None
        ]
        if len(window) < 3:
            out.append({"t": p["t"], "midi": None})
            continue
        med = float(np.median(window))
        if abs(p["midi"] - med) > jump_semi:
            out.append({"t": p["t"], "midi": None})
        else:
            out.append({"t": p["t"], "midi": round(med, 2)})
    return out


def octave_folded_cents(a: float, b: float) -> float:
    """Pitch error in cents, folded into [-600, 600] so octave-off still scores."""
    diff = a - b
    folded = diff - 12.0 * round(diff / 12.0)
    return abs(folded * 100.0)


def score_contours(
    singer: list[dict],
    reference: list[dict],
    max_dt: float = 0.12,
    tol_cents: float = 150.0,
) -> dict:
    """Score a singer contour against a reference contour, aligned by time.

    For each voiced reference frame, find the nearest singer frame within
    ``max_dt`` seconds; it's a hit if the octave-folded pitch error is within
    ``tol_cents``. Lenient by design (crude live detector + human timing) — a
    fun/demo score, not the authoritative CREPE scorer. Returns
    ``{score, frames_scored, frames_hit}`` (score 0–100).
    """
    s_t = np.array([p["t"] for p in singer if p["midi"] is not None], dtype=np.float64)
    s_m = np.array([p["midi"] for p in singer if p["midi"] is not None], dtype=np.float64)
    scored = sum(1 for r in reference if r["midi"] is not None)
    if scored == 0:
        return {"score": 0.0, "frames_scored": 0, "frames_hit": 0}
    if s_t.size == 0:
        return {"score": 0.0, "frames_scored": scored, "frames_hit": 0}

    hit = 0
    for r in reference:
        if r["midi"] is None:
            continue
        idx = int(np.argmin(np.abs(s_t - r["t"])))
        if abs(s_t[idx] - r["t"]) <= max_dt and (
            octave_folded_cents(s_m[idx], r["midi"]) <= tol_cents
        ):
            hit += 1
    return {
        "score": round(100.0 * hit / scored, 1),
        "frames_scored": scored,
        "frames_hit": hit,
    }
