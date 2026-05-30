"""Reference-lyrics lookup via LRCLIB (Stream D).

LRCLIB (https://lrclib.net) is a free, no-key, open lyrics database. We use it to
pull *real* reference lyrics for a song by title/artist, so the lyrics score
compares the singer against the actual words rather than a noisy transcript.

Returns plain lyrics (for scoring) and synced lyrics (LRC, for future karaoke
highlighting) when available.
"""

from __future__ import annotations

import httpx

BASE = "https://lrclib.net/api"
_HEADERS = {"User-Agent": "PitchBattle/0.1 (https://github.com/; hackathon)"}


def _shape(item: dict) -> dict:
    return {
        "id": item.get("id"),
        "track": item.get("trackName"),
        "artist": item.get("artistName"),
        "album": item.get("albumName"),
        "duration": item.get("duration"),
        "instrumental": item.get("instrumental", False),
        "plain_lyrics": item.get("plainLyrics") or "",
        "synced_lyrics": item.get("syncedLyrics") or "",
    }


def fetch_lyrics(
    track: str,
    artist: str | None = None,
    album: str | None = None,
    duration: int | None = None,
) -> dict | None:
    """Look up lyrics for a song.

    Tries the exact-match ``/get`` endpoint first (best when artist is known),
    then falls back to ``/search`` and takes the top hit with lyrics. Returns a
    shaped dict, or ``None`` if nothing usable is found.
    """
    with httpx.Client(timeout=10.0, headers=_HEADERS) as client:
        # 1) exact signature match — most precise
        if artist:
            params = {"track_name": track, "artist_name": artist}
            if album:
                params["album_name"] = album
            if duration:
                params["duration"] = str(duration)
            r = client.get(f"{BASE}/get", params=params)
            if r.status_code == 200:
                item = r.json()
                if item.get("plainLyrics") or item.get("syncedLyrics"):
                    return _shape(item)

        # 2) fuzzy search — take the first result that actually has lyrics
        params = {"track_name": track}
        if artist:
            params["artist_name"] = artist
        r = client.get(f"{BASE}/search", params=params)
        if r.status_code == 200:
            for item in r.json():
                if item.get("plainLyrics") or item.get("syncedLyrics"):
                    return _shape(item)

    return None
