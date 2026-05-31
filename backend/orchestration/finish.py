"""Match-finish orchestration (Stream D).

The one call the laptop makes at the end of a match:

    POST /api/match/finish
      match_id, song_id, p1_pubkey, p2_pubkey, stake_lamports, fee_bps
      take_p1 (file), take_p2 (file)
      gamemode (default "karaoke"), p1_score / p2_score (dance mode)

Fan-out:
  1. Score both takes concurrently (karaoke) or use provided scores (dance).
  2. Pick winner (score, tiebreak by frames_hit).
  3. Settle on Solana (devnet) or stub a tx string (mock) — concurrent with TTS.
  4. ElevenLabs MC voice → save under /assets/mc/<match_id>.mp3.
  5. Persist the match row to Snowflake (best-effort).
  6. Fetch leaderboard (best-effort, empty list on failure).

Returns the FinishResponse shape from contracts/.
"""
from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from typing import Any

from ai.mc_voice import roast_text, tts
from data.matches_store import get_leaderboard, insert_match
from data.songs_store import get_contour
from scoring.scorer import score_take

log = logging.getLogger(__name__)

_BACKEND = Path(__file__).resolve().parent.parent
MC_DIR = _BACKEND / "assets" / "mc"
MC_DIR.mkdir(parents=True, exist_ok=True)
FALLBACK_MC = MC_DIR / "fallback.mp3"


def _escrow_mode() -> str:
    return os.getenv("ESCROW_MODE", "mock").lower()


async def _score_pair(p1_bytes: bytes, p2_bytes: bytes, contour: dict) -> tuple[dict, dict]:
    s1, s2 = await asyncio.gather(
        asyncio.to_thread(score_take, p1_bytes, contour, "p1"),
        asyncio.to_thread(score_take, p2_bytes, contour, "p2"),
    )
    return s1, s2


def _pick_winner(s1: dict, s2: dict) -> str:
    """'p1' | 'p2' | 'tie' — score wins, then frames_hit, else tie."""
    if s1["score"] != s2["score"]:
        return "p1" if s1["score"] > s2["score"] else "p2"
    if s1["frames_hit"] != s2["frames_hit"]:
        return "p1" if s1["frames_hit"] > s2["frames_hit"] else "p2"
    return "tie"


async def _settle(
    *,
    match_id: str,
    winner_label: str,
    p1_pubkey: str,
    p2_pubkey: str,
) -> str:
    """Returns the tx signature (or a mock-* string in mock mode). Never raises —
    settle failures must not block the result screen.
    """
    mode = _escrow_mode()
    if mode != "devnet":
        return f"mock-settle-{match_id[:8]}"

    # Defer the chain import so the module loads even if solders isn't installed.
    try:
        from chain import escrow  # noqa: WPS433 — lazy by design
    except ImportError as e:
        log.warning("escrow import failed (%s); falling back to mock settle", e)
        return f"mock-settle-{match_id[:8]}"

    try:
        if winner_label == "tie":
            res = await asyncio.to_thread(escrow.refund, match_id, p1_pubkey, p2_pubkey)
        else:
            winner_pk = p1_pubkey if winner_label == "p1" else p2_pubkey
            res = await asyncio.to_thread(escrow.settle, match_id, winner_pk)
        return res.signature
    except Exception as e:  # noqa: BLE001
        log.exception("on-chain settle failed for match %s", match_id)
        return f"settle-failed-{match_id[:8]}: {type(e).__name__}"


async def _mc_audio_bytes(song_id: str, s1_score: int, s2_score: int, winner: str) -> bytes | None:
    text = roast_text(song_id, s1_score, s2_score, winner)
    audio = await tts(text)
    if audio:
        return audio
    if FALLBACK_MC.exists():
        return FALLBACK_MC.read_bytes()
    return None


def _save_mc(audio: bytes | None, match_id: str) -> str:
    if not audio:
        return "/mc-audio/fallback.mp3" if FALLBACK_MC.exists() else ""
    out = MC_DIR / f"{match_id}.mp3"
    out.write_bytes(audio)
    return f"/mc-audio/{match_id}.mp3"


def _persist(
    *,
    match_id: str,
    song_id: str,
    p1_pubkey: str,
    p2_pubkey: str,
    s1: dict,
    s2: dict,
    winner_label: str,
    stake_lamports: int,
    fee_bps: int,
    payout_tx: str,
) -> None:
    winner_pubkey: str | None
    if winner_label == "p1":
        winner_pubkey = p1_pubkey
    elif winner_label == "p2":
        winner_pubkey = p2_pubkey
    else:
        winner_pubkey = None

    try:
        insert_match(
            match_id=match_id,
            song_id=song_id,
            p1_pubkey=p1_pubkey,
            p2_pubkey=p2_pubkey,
            p1_score=int(s1["score"]),
            p2_score=int(s2["score"]),
            p1_frames_hit=int(s1["frames_hit"]),
            p2_frames_hit=int(s2["frames_hit"]),
            frames_scored=int(s1.get("frames_scored") or s2.get("frames_scored") or 0),
            winner_pubkey=winner_pubkey,
            stake_lamports=stake_lamports,
            fee_bps=fee_bps,
            payout_tx=payout_tx,
            escrow_mode=_escrow_mode(),
        )
    except Exception:  # noqa: BLE001
        log.exception("snowflake match insert failed for %s", match_id)


def _safe_leaderboard() -> list[dict]:
    try:
        return get_leaderboard(limit=10)
    except Exception:  # noqa: BLE001
        log.exception("leaderboard fetch failed")
        return []


async def handle_finish(
    *,
    match_id: str,
    song_id: str,
    p1_pubkey: str,
    p2_pubkey: str,
    p1_bytes: bytes | None = None,
    p2_bytes: bytes | None = None,
    stake_lamports: int = 0,
    fee_bps: int = 0,
    gamemode: str = "karaoke",
    p1_score: int | None = None,
    p2_score: int | None = None,
) -> dict[str, Any]:
    if gamemode == "dance" and p1_score is not None and p2_score is not None:
        s1: dict = {"song_id": song_id, "player_id": "p1", "score": p1_score, "frames_scored": 0, "frames_hit": p1_score}
        s2: dict = {"song_id": song_id, "player_id": "p2", "score": p2_score, "frames_scored": 0, "frames_hit": p2_score}
    else:
        contour = get_contour(song_id)
        s1, s2 = await _score_pair(p1_bytes, p2_bytes, contour)  # type: ignore[arg-type]

    winner = _pick_winner(s1, s2)
    commentary = roast_text(song_id, int(s1["score"]), int(s2["score"]), winner)

    # 4. Settle + TTS concurrently.
    payout_tx, mc_audio = await asyncio.gather(
        _settle(
            match_id=match_id,
            winner_label=winner,
            p1_pubkey=p1_pubkey,
            p2_pubkey=p2_pubkey,
        ),
        _mc_audio_bytes(song_id, int(s1["score"]), int(s2["score"]), winner),
    )
    mc_url = _save_mc(mc_audio, match_id)

    _persist(
        match_id=match_id,
        song_id=song_id,
        p1_pubkey=p1_pubkey,
        p2_pubkey=p2_pubkey,
        s1=s1, s2=s2,
        winner_label=winner,
        stake_lamports=stake_lamports,
        fee_bps=fee_bps,
        payout_tx=payout_tx,
    )

    leaderboard = _safe_leaderboard()

    return {
        "scores": [s1, s2],
        "winner": winner,
        "commentary": commentary,
        "mc_audio_url": mc_url,
        "payout_tx": payout_tx,
        "leaderboard": leaderboard,
    }
