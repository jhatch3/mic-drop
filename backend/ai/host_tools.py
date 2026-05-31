"""Tools the live voice host can call (Stream D).

Each tool returns `(response, action)`:
  - `response`: dict sent back to Gemini as the function result (what the model "learns").
  - `action`:   optional control message relayed to the browser over the WS — e.g. play a
                sound effect, or drive the game (start/turn/end). None = nothing to relay.

Game-control tools (start_game / start_p1_turn / ...) currently emit a browser action that the
page logs and can forward to the game socket; deeper wiring into the live match comes next.
Info tools (get_standings / get_song_info) return real data. play_sound_effect uses the cached
SFX library.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

from google.genai import types

from . import sfx
from .tools import SONGS_DIR  # reuse the songs dir constant

# ── Declarations Gemini sees (kept minimal + punchy so the host calls them) ──
DECLARATIONS = [
    types.FunctionDeclaration(
        name="play_sound_effect",
        description="Play a sound effect over the speakers. Use for hype moments.",
        parameters=types.Schema(
            type="OBJECT",
            properties={"name": types.Schema(
                type="STRING",
                description="One of: airhorn, drumroll, applause, sad_trombone, ding, buzzer, suspense, record_scratch",
            )},
            required=["name"],
        ),
    ),
    types.FunctionDeclaration(
        name="get_standings",
        description="Get the current leaderboard standings (wins/losses by player).",
        parameters=types.Schema(type="OBJECT", properties={}),
    ),
    types.FunctionDeclaration(
        name="get_song_info",
        description="Look up a song's title, artist and difficulty by song_id.",
        parameters=types.Schema(
            type="OBJECT",
            properties={"song_id": types.Schema(type="STRING")},
            required=["song_id"],
        ),
    ),
    types.FunctionDeclaration(
        name="start_game",
        description="Start the match once both players are ready.",
        parameters=types.Schema(type="OBJECT", properties={}),
    ),
    types.FunctionDeclaration(
        name="start_p1_turn",
        description="Begin Player 1's singing turn (start recording).",
        parameters=types.Schema(type="OBJECT", properties={}),
    ),
    types.FunctionDeclaration(
        name="start_p2_turn",
        description="Begin Player 2's singing turn (start recording).",
        parameters=types.Schema(type="OBJECT", properties={}),
    ),
    types.FunctionDeclaration(
        name="end_game",
        description="End the match and trigger scoring + the final roast.",
        parameters=types.Schema(type="OBJECT", properties={}),
    ),
]

TOOL = types.Tool(function_declarations=DECLARATIONS)


def _get_song_info(song_id: str) -> dict:
    try:
        meta_p = SONGS_DIR / song_id / "meta.json"
        if meta_p.is_file():
            m = json.loads(meta_p.read_text())
            return {"song_id": song_id, "title": m.get("title"), "artist": m.get("artist"),
                    "difficulty": m.get("difficulty")}
        manifest = json.loads((SONGS_DIR / "manifest.json").read_text())
        for row in manifest:
            if row.get("song_id") == song_id:
                return row
        return {"error": f"unknown song_id {song_id}"}
    except Exception:
        return {"error": "song catalog unavailable"}


def _get_standings() -> dict:
    try:
        from data.matches_store import get_leaderboard
        return {"standings": get_leaderboard(limit=10)}
    except Exception:
        return {"standings": []}


async def dispatch(name: str, args: dict) -> tuple[dict, dict | None]:
    """Run a tool call. Returns (response_to_gemini, browser_action_or_None)."""
    args = args or {}
    if name == "play_sound_effect":
        sfx_name = args.get("name", "airhorn")
        # warm the cache (generate on first use) off the event loop
        await asyncio.to_thread(sfx.get_sfx_path, sfx_name)
        return {"played": sfx_name}, {"type": "sfx", "name": sfx_name}
    if name == "get_standings":
        return await asyncio.to_thread(_get_standings), None
    if name == "get_song_info":
        return await asyncio.to_thread(_get_song_info, args.get("song_id", "")), None
    if name in ("start_game", "start_p1_turn", "start_p2_turn", "end_game"):
        return {"status": "ok", "command": name}, {"type": "game", "command": name}
    return {"error": f"unknown tool {name}"}, None
