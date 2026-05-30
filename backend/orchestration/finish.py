"""Match-finish orchestration (Stream D).

The single call the laptop makes at the end. Composes score(p1) + score(p2),
pick winner, settle, MC voice, leaderboard.

Today: hardcoded `FinishResponse` so Stream C can integrate the result screen.
Will be replaced with real fan-out per `tasks/stream-D-ai-glue.md` step 4.
"""


def stub_finish(match_id: str, song_id: str, p1_pubkey: str, p2_pubkey: str) -> dict:
    """Hardcoded FinishResponse — matches spec 3.5 shape."""
    return {
        "scores": [
            {
                "song_id": song_id,
                "player_id": "p1",
                "score": 72,
                "frames_scored": 100,
                "frames_hit": 72,
            },
            {
                "song_id": song_id,
                "player_id": "p2",
                "score": 61,
                "frames_scored": 100,
                "frames_hit": 61,
            },
        ],
        "winner": "p1",
        "commentary": (
            "Player 1 takes it with 72. Player 2 — 61 points and a lot of "
            "questions. The SOL goes to Player 1."
        ),
        "mc_audio_url": "/mc-audio/fallback.mp3",
        "payout_tx": f"mock-settle-{match_id[:8]}",
        "leaderboard": [
            {"player": p1_pubkey[:8], "wins": 1, "losses": 0},
            {"player": p2_pubkey[:8], "wins": 0, "losses": 1},
        ],
    }
