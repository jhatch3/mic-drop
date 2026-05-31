-- Pitch Battle match history + leaderboard (Stream D).
-- One row per finished match. The pitch score is authoritative; only that
-- settles the wager. Lyrics scores are not persisted here.
--
-- payout_tx is the Solana devnet tx signature returned by settle(), or
-- "mock-settle-<short_id>" when ESCROW_MODE=mock.

USE DATABASE MICDROP;
USE SCHEMA   PUBLIC;

CREATE TABLE IF NOT EXISTS matches (
  match_id        VARCHAR       NOT NULL PRIMARY KEY,
  song_id         VARCHAR       NOT NULL,
  p1_pubkey       VARCHAR       NOT NULL,
  p2_pubkey       VARCHAR       NOT NULL,
  p1_score        INTEGER       NOT NULL,
  p2_score        INTEGER       NOT NULL,
  p1_frames_hit   INTEGER       NOT NULL,
  p2_frames_hit   INTEGER       NOT NULL,
  frames_scored   INTEGER       NOT NULL,
  winner_pubkey   VARCHAR,                          -- NULL on tie
  stake_lamports  NUMBER(20,0)  NOT NULL DEFAULT 0,
  fee_bps         INTEGER       NOT NULL DEFAULT 0,
  payout_tx       VARCHAR,
  escrow_mode     VARCHAR       NOT NULL,           -- mock | devnet
  gamemode        VARCHAR       NOT NULL DEFAULT 'karaoke',  -- karaoke | dance
  settled_at      TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

-- Existing tables: add the column once with
--   ALTER TABLE matches ADD COLUMN IF NOT EXISTS gamemode VARCHAR NOT NULL DEFAULT 'karaoke';

-- Per-pubkey aggregate. wins/losses count finished matches with a winner;
-- ties contribute to `ties` only. games = wins + losses + ties.
CREATE OR REPLACE VIEW leaderboard AS
WITH per_player AS (
  SELECT p1_pubkey AS pubkey,
         CASE WHEN winner_pubkey = p1_pubkey THEN 1 ELSE 0 END AS win,
         CASE WHEN winner_pubkey IS NULL      THEN 1 ELSE 0 END AS tie,
         p1_score AS score
  FROM matches
  UNION ALL
  SELECT p2_pubkey,
         CASE WHEN winner_pubkey = p2_pubkey THEN 1 ELSE 0 END,
         CASE WHEN winner_pubkey IS NULL      THEN 1 ELSE 0 END,
         p2_score
  FROM matches
)
SELECT pubkey,
       SUM(win)                   AS wins,
       SUM(tie)                   AS ties,
       COUNT(*) - SUM(win) - SUM(tie) AS losses,
       COUNT(*)                   AS games,
       AVG(score)::INTEGER        AS avg_score,
       MAX(score)                 AS best_score
FROM   per_player
GROUP  BY pubkey
ORDER  BY wins DESC, avg_score DESC;
