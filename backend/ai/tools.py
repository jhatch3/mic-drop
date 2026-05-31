"""MC tool registry (Stream D) — the "tool use" core for the Gemini host.

`build_mc_tools(match_facts)` returns a fresh list of plain Python callables, each
closing over the current match. Gemini's automatic function calling derives the JSON
schema from the type hints + docstring and runs the tool loop itself, so adding a new
MC capability is a one-function change here.

The immediate match facts (scores, winner, song) are given to the model in the prompt;
these tools exist for *context the model chooses to pull* — song trivia, leaderboard
standing, rivalry history.

Rule: a tool MUST NOT raise. AFC has no error channel — a raised exception aborts the
whole generation. Every tool returns a plain dict/list and swallows its own failures,
so the MC degrades to "no extra context" rather than falling over.

History tools (leaderboard / head-to-head / player stats) return placeholder data until
the matches store (backend/data/store.py) lands; only these bodies change then.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Callable

REPO_ROOT = Path(__file__).resolve().parents[2]
SONGS_DIR = REPO_ROOT / "assets" / "songs"


def _short(pubkey: str) -> str:
    """Human-friendly player handle from a (possibly long) pubkey."""
    return pubkey[:8] if pubkey else "unknown"


def build_mc_tools(match_facts: dict) -> list[Callable]:
    """Return the MC's callable tools, bound to the current match.

    `match_facts` carries: song_id, p1_score, p2_score, winner ("p1"|"p2"|"tie"),
    players ({"p1": pubkey, "p2": pubkey}).
    """
    players: dict = match_facts.get("players", {}) or {}

    def get_song_info(song_id: str) -> dict:
        """Look up a song's title, artist, difficulty (1-5) and duration.

        Args:
            song_id: The song identifier, e.g. "firework".

        Returns:
            A dict with title, artist, difficulty, duration_sec — or {"error": ...}
            if the song is unknown.
        """
        try:
            meta_p = SONGS_DIR / song_id / "meta.json"
            if meta_p.is_file():
                m = json.loads(meta_p.read_text())
                return {
                    "song_id": song_id,
                    "title": m.get("title"),
                    "artist": m.get("artist"),
                    "difficulty": m.get("difficulty"),
                    "duration_sec": m.get("duration_sec"),
                }
            manifest = json.loads((SONGS_DIR / "manifest.json").read_text())
            for row in manifest:
                if row.get("song_id") == song_id:
                    return row
            return {"error": f"unknown song_id: {song_id}"}
        except Exception:
            return {"error": "song catalog unavailable"}

    def get_leaderboard() -> list[dict]:
        """Return the current win/loss leaderboard, most wins first.

        Each row is {player, wins, losses}. Returns an empty list when no match
        history is available yet.
        """
        # TODO: read from backend/data/store.py once the matches store lands.
        return []

    def get_head_to_head(player_a: str, player_b: str) -> dict:
        """Return the prior win/loss record between two players.

        Args:
            player_a: First player's handle or pubkey.
            player_b: Second player's handle or pubkey.

        Returns:
            {player_a, player_b, a_wins, b_wins, prior_matches}. Zeros when these two
            have no recorded history yet (e.g. their first meeting).
        """
        # TODO: read from backend/data/store.py once the matches store lands.
        return {
            "player_a": _short(player_a),
            "player_b": _short(player_b),
            "a_wins": 0,
            "b_wins": 0,
            "prior_matches": 0,
        }

    def get_player_stats(player: str) -> dict:
        """Return a player's career stats.

        Args:
            player: The player's handle or pubkey.

        Returns:
            {player, wins, losses, current_streak}. Zeros for a player with no history.
        """
        # TODO: read from backend/data/store.py once the matches store lands.
        return {"player": _short(player), "wins": 0, "losses": 0, "current_streak": 0}

    return [get_song_info, get_leaderboard, get_head_to_head, get_player_stats]
