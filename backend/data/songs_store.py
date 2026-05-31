"""Snowflake-backed song store.

Snowflake = source of truth; local assets/songs/<id>/ = serving cache. The
laptop fetches static files from disk; the backend lazy-fetches from Snowflake
on cache miss and writes them to disk. Hackathon WiFi never sits on the hot path.
"""
import json
import sys
from pathlib import Path

from .snowflake_client import cursor

REPO_ROOT = Path(__file__).resolve().parents[2]
CACHE_ROOT = REPO_ROOT / "assets" / "songs"
MAX_MP3_BYTES = 8 * 1024 * 1024  # Snowflake BINARY cap


def upsert_song(song_id: str, asset_dir: Path | None = None) -> None:
    """Read prepped files in assets/songs/<id>/ and MERGE into Snowflake.

    Karaoke songs need contour.json (+ optional lyrics.json).
    Dance songs need choreography.json. Both need meta.json + instrumental.mp3.
    gamemode is inferred from which JSON files are present.
    """
    asset_dir = asset_dir or (CACHE_ROOT / song_id)
    meta = json.loads((asset_dir / "meta.json").read_text())
    mp3_bytes = (asset_dir / "instrumental.mp3").read_bytes()

    if len(mp3_bytes) > MAX_MP3_BYTES:
        raise ValueError(
            f"{song_id}: instrumental.mp3 is {len(mp3_bytes):,} bytes "
            f"(> {MAX_MP3_BYTES:,} BINARY cap). Re-encode at a lower bitrate."
        )

    contour_path = asset_dir / "contour.json"
    lyrics_path = asset_dir / "lyrics.json"
    choreo_path = asset_dir / "choreography.json"

    contour = json.loads(contour_path.read_text()) if contour_path.exists() else None
    lyrics = json.loads(lyrics_path.read_text()) if lyrics_path.exists() else None
    choreo = json.loads(choreo_path.read_text()) if choreo_path.exists() else None

    gamemode = "dance" if choreo is not None else "karaoke"

    with cursor() as cur:
        cur.execute(
            """
            MERGE INTO songs t
            USING (
              SELECT %s AS song_id, %s AS title, %s AS artist, %s AS difficulty,
                     %s AS duration_sec, %s AS segment_start_sec,
                     %s AS segment_end_sec, %s AS hop_ms, %s AS gamemode,
                     %s AS mp3_bytes,
                     PARSE_JSON(%s) AS contour_json,
                     PARSE_JSON(%s) AS lyrics_json,
                     PARSE_JSON(%s) AS choreography_json
            ) s ON t.song_id = s.song_id
            WHEN MATCHED THEN UPDATE SET
              title = s.title, artist = s.artist, difficulty = s.difficulty,
              duration_sec = s.duration_sec,
              segment_start_sec = s.segment_start_sec,
              segment_end_sec = s.segment_end_sec,
              hop_ms = s.hop_ms, gamemode = s.gamemode,
              mp3_bytes = s.mp3_bytes,
              contour_json = s.contour_json,
              lyrics_json = s.lyrics_json,
              choreography_json = s.choreography_json,
              updated_at = CURRENT_TIMESTAMP()
            WHEN NOT MATCHED THEN INSERT (
              song_id, title, artist, difficulty, duration_sec,
              segment_start_sec, segment_end_sec, hop_ms, gamemode,
              mp3_bytes, contour_json, lyrics_json, choreography_json
            ) VALUES (
              s.song_id, s.title, s.artist, s.difficulty, s.duration_sec,
              s.segment_start_sec, s.segment_end_sec, s.hop_ms, s.gamemode,
              s.mp3_bytes, s.contour_json, s.lyrics_json, s.choreography_json
            )
            """,
            (
                song_id, meta["title"], meta["artist"], meta["difficulty"],
                meta["duration_sec"], meta["segment_start_sec"],
                meta["segment_end_sec"], contour.get("hop_ms", 10) if contour else 10,
                gamemode, mp3_bytes,
                json.dumps(contour) if contour else None,
                json.dumps(lyrics) if lyrics else None,
                json.dumps(choreo) if choreo else None,
            ),
        )
    summary = f"upserted {song_id} ({gamemode}): {len(mp3_bytes):,} bytes mp3"
    if contour:
        summary += f", {len(contour['frames'])} contour frames"
    if choreo:
        summary += f", {len(choreo['frames'])} choreo frames"
    print(summary)


def _parse_variant(val) -> dict | None:
    if val is None:
        return None
    if isinstance(val, (bytes, bytearray)):
        val = val.decode()
    if isinstance(val, str):
        return json.loads(val)
    return val


def _fetch_row(song_id: str) -> dict:
    with cursor() as cur:
        cur.execute(
            """
            SELECT title, artist, difficulty, duration_sec,
                   segment_start_sec, segment_end_sec, hop_ms, gamemode,
                   mp3_bytes, contour_json, lyrics_json, choreography_json
            FROM songs WHERE song_id = %s
            """,
            (song_id,),
        )
        row = cur.fetchone()
    if not row:
        raise KeyError(f"unknown song_id: {song_id}")
    return {
        "song_id": song_id,
        "title": row[0], "artist": row[1], "difficulty": int(row[2]),
        "duration_sec": float(row[3]),
        "segment_start_sec": float(row[4]),
        "segment_end_sec": float(row[5]),
        "hop_ms": int(row[6]),
        "gamemode": row[7] or "karaoke",
        "mp3_bytes": bytes(row[8]),
        "contour": _parse_variant(row[9]),
        "lyrics": _parse_variant(row[10]),
        "choreography": _parse_variant(row[11]),
    }


def _ensure_cached(song_id: str) -> Path:
    """Pull song from Snowflake to local cache if missing. Returns the asset dir."""
    out = CACHE_ROOT / song_id
    mp3_p = out / "instrumental.mp3"
    # Check that the mp3 and at least one JSON asset are present.
    has_json = any((out / f).is_file() for f in
                   ("contour.json", "choreography.json"))
    if mp3_p.is_file() and has_json:
        return out

    data = _fetch_row(song_id)
    out.mkdir(parents=True, exist_ok=True)
    mp3_p.write_bytes(data["mp3_bytes"])
    (out / "meta.json").write_text(json.dumps({
        "song_id": song_id,
        "title": data["title"], "artist": data["artist"],
        "difficulty": data["difficulty"],
        "duration_sec": data["duration_sec"],
        "segment_start_sec": data["segment_start_sec"],
        "segment_end_sec": data["segment_end_sec"],
        "gamemode": data["gamemode"],
    }, indent=2))
    if data["contour"] is not None:
        (out / "contour.json").write_text(
            json.dumps(data["contour"], separators=(",", ":")))
    if data["lyrics"] is not None:
        (out / "lyrics.json").write_text(
            json.dumps(data["lyrics"], separators=(",", ":")))
    if data["choreography"] is not None:
        (out / "choreography.json").write_text(
            json.dumps(data["choreography"], separators=(",", ":")))
    print(f"  cached {song_id} ({data['gamemode']}) from Snowflake -> {out.relative_to(REPO_ROOT)}")
    return out


def get_contour(song_id: str) -> dict:
    asset_dir = _ensure_cached(song_id)
    return json.loads((asset_dir / "contour.json").read_text())


def get_choreography(song_id: str) -> dict:
    asset_dir = _ensure_cached(song_id)
    p = asset_dir / "choreography.json"
    if not p.exists():
        raise KeyError(f"{song_id} has no choreography")
    return json.loads(p.read_text())


def get_instrumental_path(song_id: str) -> Path:
    return _ensure_cached(song_id) / "instrumental.mp3"


def list_catalog() -> list[dict]:
    """Return the song catalog (no contour/mp3) for /api/songs."""
    with cursor() as cur:
        cur.execute(
            "SELECT song_id, title, artist, difficulty, duration_sec "
            "FROM songs_catalog ORDER BY title"
        )
        rows = cur.fetchall()
    return [
        {
            "song_id": r[0],
            "title": r[1],
            "artist": r[2],
            "difficulty": int(r[3]),
            "duration_sec": float(r[4]),
        }
        for r in rows
    ]


def sync_manifest() -> Path:
    """Regenerate assets/songs/manifest.json from the Snowflake catalog."""
    with cursor() as cur:
        cur.execute(
            "SELECT song_id, title, artist, difficulty "
            "FROM songs_catalog ORDER BY title"
        )
        rows = cur.fetchall()
    manifest = [
        {"song_id": r[0], "title": r[1], "artist": r[2], "difficulty": int(r[3])}
        for r in rows
    ]
    CACHE_ROOT.mkdir(parents=True, exist_ok=True)
    p = CACHE_ROOT / "manifest.json"
    p.write_text(json.dumps(manifest, indent=2) + "\n")
    return p


def migrate() -> None:
    """Add gamemode, lyrics_json, choreography_json columns to existing table."""
    with cursor() as cur:
        for stmt in [
            "ALTER TABLE songs ADD COLUMN IF NOT EXISTS gamemode VARCHAR DEFAULT 'karaoke'",
            "ALTER TABLE songs ADD COLUMN IF NOT EXISTS lyrics_json VARIANT",
            "ALTER TABLE songs ADD COLUMN IF NOT EXISTS choreography_json VARIANT",
        ]:
            cur.execute(stmt)
            print(f"  ok: {stmt}")
    print("migration complete")


def _cli():
    if len(sys.argv) < 2:
        print("usage: python -m data.songs_store "
              "[migrate | upload <song_id> | sync-manifest | list]")
        sys.exit(2)
    cmd = sys.argv[1]
    if cmd == "migrate":
        migrate()
    elif cmd == "upload":
        upsert_song(sys.argv[2])
        p = sync_manifest()
        print(f"manifest -> {p.relative_to(REPO_ROOT)}")
    elif cmd == "sync-manifest":
        p = sync_manifest()
        print(f"wrote {p.relative_to(REPO_ROOT)}")
    elif cmd == "list":
        with cursor() as cur:
            cur.execute("SELECT song_id, title, artist, difficulty, "
                        "duration_sec FROM songs_catalog ORDER BY title")
            for r in cur.fetchall():
                print(f"  {r[0]:<20} {r[1]} - {r[2]}  diff={r[3]}  {r[4]:.1f}s")
    else:
        print(f"unknown command: {cmd}")
        sys.exit(2)


if __name__ == "__main__":
    _cli()
