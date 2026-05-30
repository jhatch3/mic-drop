-- Pitch Battle song catalog (Stream B).
-- One row per song. mp3_bytes is the vocals-removed instrumental; contour_json
-- is the offline pyin analysis (10 ms hop, segment-relative t, midi+voiced).
-- Backend serves these to the laptop by syncing rows to local assets/songs/<id>/
-- on cold start or on cache miss. Local disk is the serving layer; this table
-- is the source of truth.

USE DATABASE MICDROP;
USE SCHEMA   PUBLIC;

CREATE OR REPLACE TABLE songs (
  song_id            VARCHAR       NOT NULL PRIMARY KEY,
  title              VARCHAR       NOT NULL,
  artist             VARCHAR       NOT NULL,
  difficulty         INTEGER       NOT NULL,                 -- 1..5
  duration_sec       FLOAT         NOT NULL,                 -- length of the prepped segment
  segment_start_sec  FLOAT         NOT NULL,                 -- offset into the source track
  segment_end_sec    FLOAT         NOT NULL,
  hop_ms             INTEGER       NOT NULL DEFAULT 10,      -- contour frame spacing
  -- Snowflake BINARY caps at 8 MB. 1-3 min @ 128 kbps mp3 is ~1.5-3 MB.
  mp3_bytes          BINARY        NOT NULL,
  -- contour shape: { song_id, hop_ms, frames: [{t, midi, voiced}, ...] }
  -- VARIANT holds ~16 MB compressed (a 60 s contour is well under 200 KB).
  contour_json       VARIANT       NOT NULL,
  created_at         TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  updated_at         TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

-- Lightweight catalog view: everything except the binary blob and the contour.
-- Use this for the /api/songs list endpoint and any joins from matches.
CREATE OR REPLACE VIEW songs_catalog AS
SELECT song_id, title, artist, difficulty, duration_sec,
       segment_start_sec, segment_end_sec, hop_ms,
       created_at, updated_at
FROM   songs;

-- Reference INSERT (run from the Python connector — see backend/data/songs_store.py
-- once Stream D builds it; the pattern is:
--
--   cur.execute(
--     """
--     INSERT INTO songs(song_id, title, artist, difficulty, duration_sec,
--                       segment_start_sec, segment_end_sec, hop_ms,
--                       mp3_bytes, contour_json)
--     SELECT %s, %s, %s, %s, %s, %s, %s, %s, %s, PARSE_JSON(%s)
--     """,
--     (song_id, title, artist, difficulty, duration_sec,
--      seg_start, seg_end, hop_ms,
--      mp3_bytes,            -- raw bytes object
--      json.dumps(contour))  -- JSON string, PARSE_JSON wraps to VARIANT
--   )
--
-- For an upsert, do the same as a MERGE on song_id.
