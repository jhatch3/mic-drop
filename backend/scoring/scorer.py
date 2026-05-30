"""Stub scorer. Replace with real librosa.pyin in Step 3."""
import io

import librosa


def score_take(audio_bytes: bytes, contour: dict, player_id: str) -> dict:
    y, sr = librosa.load(io.BytesIO(audio_bytes), sr=16000, mono=True)
    duration = len(y) / sr
    score = min(100, max(0, int(50 + duration % 50)))
    voiced = [f for f in contour["frames"] if f["voiced"]]
    frames_scored = len(voiced)
    frames_hit = int(score * frames_scored / 100)
    return {
        "song_id": contour["song_id"],
        "player_id": player_id,
        "score": score,
        "frames_scored": frames_scored,
        "frames_hit": frames_hit,
    }
