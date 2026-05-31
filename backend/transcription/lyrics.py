"""Lyrics scoring (Stream D).

Compares what STT *heard* against the song's known reference lyrics and returns a
0–100 coverage score. STT on singing is noisy, so this is deliberately lenient:
normalize aggressively, then fuzzy token-match. This is a bonus signal only — it
NEVER contributes to the authoritative pitch/timing score.

See docs/speech-agent.md §3.
"""

from __future__ import annotations

import re

from rapidfuzz import fuzz

_PUNCT = re.compile(r"[^\w\s]")


def normalize(text: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace."""
    return " ".join(_PUNCT.sub(" ", text.lower()).split())


def lyrics_score(recognized: str, reference: str) -> float:
    """Return a 0–100 similarity between recognized and reference lyrics.

    Uses token-sort ratio so word-order differences and minor STT errors are
    tolerated. Returns 0.0 if either side is empty after normalization.
    """
    rec, ref = normalize(recognized), normalize(reference)
    if not rec or not ref:
        return 0.0
    return round(float(fuzz.token_sort_ratio(rec, ref)), 1)


def _expand_reference_words(lines: list[dict]) -> list[dict]:
    """Spread each reference line's words across [t, end] → [{word, t}]."""
    out: list[dict] = []
    for ln in lines or []:
        toks = [w for w in normalize(ln.get("text", "")).split() if w]
        if not toks:
            continue
        t0 = float(ln.get("t", 0.0)); t1 = float(ln.get("end", t0))
        dur = max(0.001, t1 - t0)
        for i, w in enumerate(toks):
            out.append({"word": w, "t": t0 + (i + 0.5) / len(toks) * dur})
    return out


def timed_lyrics_score(recognized_words: list[dict], reference_lines: list[dict],
                       window: float = 2.0) -> float:
    """Timing-aware lyrics score (0–100): each reference word must be recognized
    AND sung near its expected time. Rewards right words at the right moment, not
    just the right words. `recognized_words` = STT [{word,start,end}].
    """
    ref = _expand_reference_words(reference_lines)
    if not ref:
        return 0.0
    rec = [{"word": normalize(w.get("word", "")),
            "t": (float(w.get("start", 0)) + float(w.get("end", 0))) / 2}
           for w in (recognized_words or [])]
    rec = [r for r in rec if r["word"]]
    used = [False] * len(rec)
    matched = 0
    for rw in ref:
        for j, hw in enumerate(rec):
            if used[j]:
                continue
            if abs(hw["t"] - rw["t"]) <= window and fuzz.ratio(hw["word"], rw["word"]) >= 80:
                used[j] = True; matched += 1
                break
    return round(100 * matched / len(ref), 1)
