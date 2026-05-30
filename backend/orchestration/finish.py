"""Match-finish orchestration (Stream D).

The single call the laptop makes at the end. Composes score(p1) + score(p2),
pick winner, settle, MC voice, leaderboard.

Today: hardcoded `FinishResponse` so Stream C can integrate the result screen.
Will be replaced with real fan-out per `tasks/stream-D-ai-glue.md` step 4.

gamemode="dance" path: p1_score / p2_score are passed in directly because
scoring already happened per-turn via /api/dance/score. The stub still returns
a properly-shaped FinishResponse using those scores.
"""
from __future__ import annotations


def stub_finish(
    match_id: str,
    song_id: str,
    p1_pubkey: str,
    p2_pubkey: str,
    gamemode: str = "karaoke",
    p1_score: int | None = None,
    p2_score: int | None = None,
) -> dict:
    """Hardcoded FinishResponse — matches spec 3.5 shape."""
    if gamemode == "dance" and p1_score is not None and p2_score is not None:
        s1, s2 = p1_score, p2_score
    else:
        # Default stub scores for karaoke / when scores not provided
        s1, s2 = 72, 61

    winner = "p1" if s1 > s2 else ("p2" if s2 > s1 else "tie")

    action = "danced" if gamemode == "dance" else "sang"
    commentary = (
        f"Player 1 {action} with {s1}. Player 2 — {s2} points. "
        + (f"Player 1 takes the SOL." if winner == "p1" else
           f"Player 2 takes the SOL." if winner == "p2" else
           "It's a tie! No winner today.")
    )

    return {
        "scores": [
            {"song_id": song_id, "player_id": "p1", "score": s1, "frames_scored": 100, "frames_hit": s1},
            {"song_id": song_id, "player_id": "p2", "score": s2, "frames_scored": 100, "frames_hit": s2},
        ],
        "winner": winner,
        "commentary": commentary,
        "mc_audio_url": "/mc-audio/fallback.mp3",
        "payout_tx": f"mock-settle-{match_id[:8]}",
        "leaderboard": [
            {"player": p1_pubkey[:8], "wins": 1 if winner == "p1" else 0, "losses": 0 if winner == "p1" else 1},
            {"player": p2_pubkey[:8], "wins": 1 if winner == "p2" else 0, "losses": 0 if winner == "p2" else 1},
        ],
    }
