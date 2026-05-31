"""AI settings (Stream D).

Single source of truth for the Gemini commentary + ElevenLabs voice config. Every
external dependency flips mock<->real via an env var so the backend always boots,
even with no keys (see docs /stream-d-backend.md, "the one rule"). Reads .env at the
repo root like data/snowflake_client.py.
"""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(REPO_ROOT / ".env")

_BACKEND = Path(__file__).resolve().parents[1]

# --- Gemini (roast commentary) ---
GEMINI_MODE = os.getenv("GEMINI_MODE", "mock").lower()           # mock | real
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
GEMINI_MAX_TOOL_CALLS = int(os.getenv("GEMINI_MAX_TOOL_CALLS", "6"))
COMMENTARY_TIMEOUT_S = float(os.getenv("COMMENTARY_TIMEOUT_S", "8.0"))

# --- Gemini Live (real-time voice host) ---
# Live models on this key output native AUDIO only (no TEXT modality), so the
# host speaks in a Gemini voice. PCM in @16k, out @24k.
GEMINI_LIVE_MODEL = os.getenv("GEMINI_LIVE_MODEL", "gemini-3.1-flash-live-preview")
HOST_VOICE = os.getenv("HOST_VOICE", "Puck")          # Puck=upbeat; also Charon/Kore/Fenrir/Aoede
LIVE_INPUT_RATE = 16000
LIVE_OUTPUT_RATE = 24000

# --- ElevenLabs (MC voice) ---
ELEVENLABS_MODE = os.getenv("ELEVENLABS_MODE", "mock").lower()    # mock | real
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "pNInz6obpgDQGcFmaJgB")  # Adam
ELEVENLABS_MODEL = os.getenv("ELEVENLABS_MODEL", "eleven_flash_v2_5")       # fast, streaming
ELEVENLABS_V3_MODEL = os.getenv("ELEVENLABS_V3_MODEL", "eleven_v3")         # expressive (audio tags)
TTS_TIMEOUT_S = float(os.getenv("TTS_TIMEOUT_S", "4.0"))

# Named voice personas (role -> ElevenLabs voice_id). Override any via env.
# Defaults: mc -> the account's "Game show V1" custom voice; others -> fitting premades.
VOICES: dict[str, str] = {
    "mc": os.getenv("VOICE_MC", "8otVbphNkUJz2PMN1jYQ"),       # Game show V1 (custom)
    "hype": os.getenv("VOICE_HYPE", "TX3LPaxmHKxFdv7VOQHJ"),   # Liam — energetic
    "villain": os.getenv("VOICE_VILLAIN", "N2lVS1w4EtoT3dr4eOWO"),  # Callum — husky trickster
}
DEFAULT_VOICE_ROLE = os.getenv("DEFAULT_VOICE_ROLE", "mc")

# --- Sound effects (ElevenLabs text-to-sound, generate-then-cache) ---
SFX_MODEL = os.getenv("SFX_MODEL", "eleven_text_to_sound_v2")
SFX_PROMPT_INFLUENCE = float(os.getenv("SFX_PROMPT_INFLUENCE", "0.5"))

# --- shared ---
# Served at /mc-audio/<name>.mp3 and created by main.py; fallback.mp3 lives here too.
MC_ASSET_DIR = _BACKEND / "assets" / "mc"
FALLBACK_CLIP = MC_ASSET_DIR / "fallback.mp3"
# Cached/committed sound-effect clips, served at /sfx-audio/<name>.mp3.
SFX_ASSET_DIR = _BACKEND / "assets" / "sfx"


def gemini_enabled() -> bool:
    return GEMINI_MODE == "real" and bool(GEMINI_API_KEY)


def elevenlabs_enabled() -> bool:
    return ELEVENLABS_MODE == "real" and bool(ELEVENLABS_API_KEY)
