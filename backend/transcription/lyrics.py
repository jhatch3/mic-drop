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
