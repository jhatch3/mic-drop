"""Snowflake-backed match history + leaderboard.

`matches` is the system of record for finished games. `leaderboard` is a view
defined in `schema/matches.sql`. Bootstrap with:

    snowsql -f backend/data/schema/matches.sql

All inserts are best-effort: a failure here must NOT block /api/match/finish
from returning (the result screen has to work even if Snowflake is down).
"""
from __future__ import annotations

import logging
import sys
from typing import Iterable

from .snowflake_client import cursor

log = logging.getLogger(__name__)


def insert_match(
    *,
    match_id: str,
    song_id: str,
    p1_pubkey: str,
    p2_pubkey: str,
    p1_score: int,
    p2_score: int,
    p1_frames_hit: int,
    p2_frames_hit: int,
    frames_scored: int,
    winner_pubkey: str | None,
    stake_lamports: int,
    fee_bps: int,
    payout_tx: str | None,
    escrow_mode: str,
    gamemode: str = "karaoke",
) -> None:
    """Idempotent on match_id — re-inserts overwrite the row. `gamemode` is recorded when the
    column exists; if the table hasn't been migrated yet we retry without it so karaoke
    persistence never breaks."""
    def _merge(with_gm: bool) -> None:
        gm_set = ", gamemode = %s" if with_gm else ""
        gm_col = ", gamemode" if with_gm else ""
        gm_val = ", %s" if with_gm else ""
        sql = f"""
            MERGE INTO matches t
            USING (SELECT %s AS match_id) s ON t.match_id = s.match_id
            WHEN MATCHED THEN UPDATE SET
              song_id = %s, p1_pubkey = %s, p2_pubkey = %s,
              p1_score = %s, p2_score = %s,
              p1_frames_hit = %s, p2_frames_hit = %s,
              frames_scored = %s, winner_pubkey = %s,
              stake_lamports = %s, fee_bps = %s,
              payout_tx = %s, escrow_mode = %s{gm_set},
              settled_at = CURRENT_TIMESTAMP()
            WHEN NOT MATCHED THEN INSERT (
              match_id, song_id, p1_pubkey, p2_pubkey,
              p1_score, p2_score, p1_frames_hit, p2_frames_hit,
              frames_scored, winner_pubkey,
              stake_lamports, fee_bps, payout_tx, escrow_mode{gm_col}
            ) VALUES (
              %s, %s, %s, %s, %s, %s, %s, %s,
              %s, %s, %s, %s, %s, %s{gm_val}
            )
        """
        upd = [song_id, p1_pubkey, p2_pubkey, p1_score, p2_score, p1_frames_hit, p2_frames_hit,
               frames_scored, winner_pubkey, stake_lamports, fee_bps, payout_tx, escrow_mode]
        if with_gm:
            upd.append(gamemode)
        ins = [match_id, song_id, p1_pubkey, p2_pubkey, p1_score, p2_score, p1_frames_hit,
               p2_frames_hit, frames_scored, winner_pubkey, stake_lamports, fee_bps, payout_tx, escrow_mode]
        if with_gm:
            ins.append(gamemode)
        with cursor() as cur:
            cur.execute(sql, tuple([match_id] + upd + ins))

    try:
        _merge(True)
    except Exception:
        _merge(False)   # table missing the gamemode column — still persist the row


def get_leaderboard(limit: int = 20) -> list[dict]:
    """Top players by wins, then avg_score. Returns short-form rows for the UI."""
    with cursor() as cur:
        cur.execute(
            "SELECT pubkey, wins, ties, losses, games, avg_score, best_score "
            "FROM leaderboard LIMIT %s",
            (limit,),
        )
        rows = cur.fetchall()
    return [
        {
            "pubkey": r[0],
            "player": (r[0] or "")[:8],     # short form for compact rendering
            "wins": int(r[1] or 0),
            "ties": int(r[2] or 0),
            "losses": int(r[3] or 0),
            "games": int(r[4] or 0),
            "avg_score": int(r[5] or 0),
            "best_score": int(r[6] or 0),
        }
        for r in rows
    ]


def get_top_scores(song_id: str | None = None, gamemode: str | None = None,
                   limit: int = 50) -> list[dict]:
    """Highest individual take scores, newest-first as a tiebreak. Optionally filtered to one
    song and/or one gamemode (karaoke | dance). Each match row holds two takes, so we unpivot
    p1/p2 into one row per take. Best-effort: [] if Snowflake down. If the `gamemode` column
    doesn't exist yet, we transparently fall back to an unfiltered query.
    Returns [{pubkey, player, song_id, score, settled_at}].
    """
    def _run(use_gamemode: bool):
        gm_col = ", gamemode" if use_gamemode else ""
        conds, params = [], []
        if song_id:
            conds.append("song_id = %s"); params.append(song_id)
        if use_gamemode and gamemode:
            conds.append("gamemode = %s"); params.append(gamemode)
        where = ("WHERE " + " AND ".join(conds)) if conds else ""
        params.append(limit)
        with cursor() as cur:
            cur.execute(
                "SELECT pubkey, song_id, score, settled_at FROM ("
                f"  SELECT p1_pubkey AS pubkey, song_id, p1_score AS score, settled_at{gm_col} FROM matches"
                "  UNION ALL"
                f"  SELECT p2_pubkey, song_id, p2_score, settled_at{gm_col} FROM matches"
                f") {where} "
                "ORDER BY score DESC, settled_at DESC LIMIT %s",
                tuple(params),
            )
            return cur.fetchall()

    rows = None
    if gamemode:
        try:
            rows = _run(True)
        except Exception:   # gamemode column not present yet
            rows = None
    if rows is None:
        rows = _run(False)
    return [
        {
            "pubkey": r[0],
            "player": (r[0] or "")[:8],
            "song_id": r[1],
            "score": int(r[2] or 0),
            "settled_at": str(r[3]) if r[3] is not None else None,
        }
        for r in rows
    ]


def _cli(args: Iterable[str]) -> None:
    args = list(args)
    if not args:
        print("usage: python -m backend.data.matches_store [leaderboard]")
        sys.exit(2)
    if args[0] == "leaderboard":
        for r in get_leaderboard():
            print(f"  {r['player']:<10} {r['wins']}W {r['losses']}L {r['ties']}T "
                  f"avg={r['avg_score']} best={r['best_score']}")
    else:
        print(f"unknown command: {args[0]}")
        sys.exit(2)


if __name__ == "__main__":
    _cli(sys.argv[1:])
