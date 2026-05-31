"""Gemini Live session for the real-time voice game-show host (Stream D).

The Live models on this key output native AUDIO only, so the host speaks in a Gemini
voice (config.HOST_VOICE). Input is PCM 16kHz, output PCM 24kHz. Tools from host_tools
are handled manually in the WS bridge (host_ws), not auto-executed.
"""
from __future__ import annotations

from google import genai
from google.genai import types

from . import config
from .host_tools import TOOL

SYSTEM_PROMPT = (
    "You are MIC DROP's MC: a high-energy, witty game-show host for a head-to-head "
    "karaoke battle where two players sing and the higher pitch-accuracy score wins a "
    "SOL wager. Personality: hype, fast, a little cheeky — think a Vegas game-show host. "
    "Keep spoken turns SHORT (1-2 sentences) and punchy. "
    "Use your tools to run the show: play_sound_effect for hype moments (airhorn on a win, "
    "drumroll before a reveal, sad_trombone for a flop), start_game / start_p1_turn / "
    "start_p2_turn / end_game to drive the match, get_standings and get_song_info to ground "
    "your patter in real data. When you first greet the room, play the game_show_open sound, "
    "THEN welcome the crowd to MIC DROP. Use airhorn for wins, not for the opening. "
    "Talk directly to the players; never narrate stage directions."
)


def build_config() -> types.LiveConnectConfig:
    return types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        system_instruction=SYSTEM_PROMPT,
        tools=[TOOL],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=config.HOST_VOICE),
            ),
        ),
        output_audio_transcription=types.AudioTranscriptionConfig(),  # captions of what the host says
        input_audio_transcription=types.AudioTranscriptionConfig(),   # captions of what the user says
    )


def client() -> genai.Client:
    return genai.Client(api_key=config.GEMINI_API_KEY)


def connect():
    """Async context manager: `async with connect() as session: ...`"""
    return client().aio.live.connect(model=config.GEMINI_LIVE_MODEL, config=build_config())
