"""Roast commentary (Stream D).

`get_commentary()` returns a provider picked by GEMINI_MODE:
  - MockCommentary  — hand-written template, always available, no keys.
  - GeminiCommentary — real, tool-using host (automatic function calling). Falls back
    to the mock on ANY error/timeout so the endpoint always returns a roast.

Contract (spec §8.2): {song, p1_score, p2_score, winner} -> a short punchy 2-3 sentence
roast that names the winner and gently torches the loser.
"""
from __future__ import annotations

import asyncio
from typing import Protocol

from . import config
from .tools import build_mc_tools

SYSTEM_PROMPT = (
    "You are the MC of Pitch Battle, a head-to-head karaoke game where two players "
    "sing and the higher pitch-accuracy score wins the cash pot. Deliver a SHORT, punchy "
    "roast: 2-3 sentences, spoken aloud, PG-13. Name the winner, congratulate them "
    "briefly, then gently torch the loser. Be specific and funny — use the scores and any "
    "context you look up (the song's difficulty, the players' history, the leaderboard). "
    "Call the prize 'cash' or 'the money' — never say 'SOL', 'Solana', or 'crypto'. "
    "Output ONLY the spoken lines — no stage directions, emoji, or markdown."
)

# Appended when expressive=True (voiced by the ElevenLabs v3 model, which performs tags).
EXPRESSIVE_GUIDANCE = (
    " Perform it with emotion using inline audio tags in square brackets, e.g. "
    "[excited], [laughs], [sarcastic], [whispers], [dramatically]. Place tags right "
    "before the words they color. Use 2-4 tags total — don't overdo it."
)


class CommentaryProvider(Protocol):
    async def generate(
        self, *, song: str, p1_score: int, p2_score: int, winner: str, players: dict,
        expressive: bool = False,
    ) -> str: ...


def _winner_label(winner: str) -> tuple[str, str]:
    """(winner_name, loser_name) for the p1/p2 slots."""
    if winner == "p1":
        return "Player 1", "Player 2"
    return "Player 2", "Player 1"


class MockCommentary:
    """Canned roast — the offline/default path (was mc_voice.roast_text)."""

    async def generate(
        self, *, song: str, p1_score: int, p2_score: int, winner: str, players: dict,
        expressive: bool = False,
    ) -> str:
        if winner == "tie":
            tie = (
                f"A tie at {p1_score} apiece on {song}. "
                f"Two voices, equally cursed. The pot goes back to both of you."
            )
            return f"[dramatically] {tie}" if expressive else tie
        w, loser = _winner_label(winner)
        ws = p1_score if winner == "p1" else p2_score
        ls = p2_score if winner == "p1" else p1_score
        if expressive:
            return (
                f"[excited] {w} wins with {ws} points — congratulations! "
                f"[sarcastic] {loser} scored {ls}. I've heard better pitch from a broken "
                f"kazoo. [laughs] The cash goes to {w}."
            )
        return (
            f"{w} wins with {ws} points — congratulations. "
            f"{loser} scored {ls}. I've heard better pitch from a broken kazoo. "
            f"The cash goes to {w}."
        )


class GeminiCommentary:
    """Real roast via Gemini with automatic function calling over the MC tools."""

    def __init__(self) -> None:
        from google import genai  # lazy: only import when GEMINI_MODE=real

        self._genai = genai
        self._client = genai.Client(api_key=config.GEMINI_API_KEY)
        self._fallback = MockCommentary()

    async def generate(
        self, *, song: str, p1_score: int, p2_score: int, winner: str, players: dict,
        expressive: bool = False,
    ) -> str:
        from google.genai import types

        match_facts = {
            "song_id": song,
            "p1_score": p1_score,
            "p2_score": p2_score,
            "winner": winner,
            "players": players or {},
        }
        w, loser = _winner_label(winner) if winner != "tie" else ("nobody", "everybody")
        prompt = (
            f"Match result — song_id: {song}. "
            f"Player 1 scored {p1_score}, Player 2 scored {p2_score}. "
            f"Winner: {winner} ({w}). "
            f"Look up whatever context makes the roast sharper, then deliver it."
        )
        system = SYSTEM_PROMPT + (EXPRESSIVE_GUIDANCE if expressive else "")
        config_obj = types.GenerateContentConfig(
            system_instruction=system,
            tools=build_mc_tools(match_facts),
            automatic_function_calling=types.AutomaticFunctionCallingConfig(
                maximum_remote_calls=config.GEMINI_MAX_TOOL_CALLS,
            ),
        )
        try:
            resp = await asyncio.wait_for(
                self._client.aio.models.generate_content(
                    model=config.GEMINI_MODEL,
                    contents=prompt,
                    config=config_obj,
                ),
                timeout=config.COMMENTARY_TIMEOUT_S,
            )
            text = (resp.text or "").strip()
            if text:
                return text
        except Exception:
            pass
        return await self._fallback.generate(
            song=song, p1_score=p1_score, p2_score=p2_score, winner=winner,
            players=players, expressive=expressive,
        )


def get_commentary() -> CommentaryProvider:
    """Pick the commentary provider from GEMINI_MODE (+ a key being present)."""
    if config.gemini_enabled():
        try:
            return GeminiCommentary()
        except Exception:
            pass
    return MockCommentary()
