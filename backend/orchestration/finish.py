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

import json

from ai.commentary import get_commentary
from ai.mc_voice import tts
from data.matches_store import get_leaderboard, insert_match
from data.songs_store import get_contour
from scoring.scorer import score_take
from transcription.lyrics import lyrics_score
from transcription.stt import transcribe_bytes

log = logging.getLogger(__name__)

_BACKEND = Path(__file__).resolve().parent.parent
MC_DIR = _BACKEND / "assets" / "mc"
MC_DIR.mkdir(parents=True, exist_ok=True)
FALLBACK_MC = MC_DIR / "fallback.mp3"
SONGS_DIR = _BACKEND.parent / "assets" / "songs"

# Final score = (1-w)*pitch + w*lyrics. Pitch stays dominant; lyrics is a real but
# minority factor. Tune via LYRICS_WEIGHT (0 = pitch only, 1 = lyrics only).
LYRICS_WEIGHT = float(os.getenv("LYRICS_WEIGHT", "0.3"))


def _escrow_mode() -> str:
    return os.getenv("ESCROW_MODE", "mock").lower()


def _reference_lyrics(song_id: str) -> str:
    """Join the song's reference lyric lines into one string for fuzzy matching."""
    try:
        data = json.loads((SONGS_DIR / song_id / "lyrics.json").read_text())
        return " ".join(ln.get("text", "") for ln in data.get("lines", []))
    except Exception:
        return ""


def _grade_take(audio_bytes: bytes, contour: dict, reference: str, player: str) -> dict:
    """Pitch score (authoritative) blended with a lyrics score from STT.

    Blends only when we actually got a transcript + have reference lyrics; otherwise
    falls back to pitch alone so missing/failed STT never tanks the score.
    """
    s = score_take(audio_bytes, contour, player)
    pitch = int(s["score"])
    lyrics, transcript = 0.0, ""
    try:
        transcript = (transcribe_bytes(audio_bytes) or {}).get("transcript", "")
        if reference and transcript:
            lyrics = lyrics_score(transcript, reference)
    except Exception:  # noqa: BLE001 — STT is best-effort; never block scoring
        log.exception("STT/lyrics failed for %s", player)
    blended = round((1 - LYRICS_WEIGHT) * pitch + LYRICS_WEIGHT * lyrics) if (reference and transcript) else pitch
    s["pitch_score"] = pitch
    s["lyrics_score"] = lyrics
    s["transcript"] = transcript
    s["score"] = blended
    return s


async def _score_pair(
    p1_bytes: bytes, p2_bytes: bytes, contour: dict, reference: str
) -> tuple[dict, dict]:
    return await asyncio.gather(
        asyncio.to_thread(_grade_take, p1_bytes, contour, reference, "p1"),
        asyncio.to_thread(_grade_take, p2_bytes, contour, reference, "p2"),
    )


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


async def _commentary(song_id: str, s1_score: int, s2_score: int, winner: str) -> str:
    return await get_commentary().generate(
        song=song_id, p1_score=s1_score, p2_score=s2_score, winner=winner, players={})


async def _mc_audio_bytes(text: str) -> bytes | None:
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

    # 1. Contour + reference lyrics for the song.
    contour = get_contour(song_id)
    reference = _reference_lyrics(song_id)

    # 2. Score in parallel — pitch (authoritative) blended with STT lyrics score.
    s1, s2 = await _score_pair(p1_bytes, p2_bytes, contour, reference)

    # 3. Winner.
    winner = _pick_winner(s1, s2)

    # 4. Commentary (async Gemini/mock) + settle concurrently, then voice the roast.
    commentary, payout_tx = await asyncio.gather(
        _commentary(song_id, int(s1["score"]), int(s2["score"]), winner),
        _settle(
            match_id=match_id,
            winner_label=winner,
            p1_pubkey=p1_pubkey,
            p2_pubkey=p2_pubkey,
        ),
    )
    mc_audio = await _mc_audio_bytes(commentary)
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
