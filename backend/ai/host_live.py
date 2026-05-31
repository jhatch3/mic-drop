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
    "karaoke battle where two players sing and the higher pitch-accuracy score wins the "
    "cash pot. Personality: hype, fast, a little cheeky — think a Vegas game-show host. "
    "MONEY: always call the prize 'cash', 'money', 'the cash pot', or 'the prize money' when "
    "you speak — NEVER say 'SOL', 'Solana', 'crypto', 'wallet', or 'tokens' out loud. "
    "Keep spoken turns SHORT (1-2 sentences) and punchy. "
    "Use your tools to run the show: play_sound_effect for hype moments (airhorn on a win, "
    "drumroll before a reveal, sad_trombone for a flop), start_game / start_p1_turn / "
    "start_p2_turn / end_game to drive the match, get_standings and get_song_info to ground "
    "your patter in real data. When you first greet the room, play the game_show_open sound, "
    "THEN welcome the crowd to MIC DROP. Use airhorn for wins, not for the opening. "
    "Talk directly to the players; never narrate stage directions. "
    "PACING — this is critical: your opening is ONLY the fanfare, a short welcome, and the "
    "question \"Are we ready to start?\". After you ask it, STOP and WAIT — say nothing more. "
    "Do NOT call start_game or start_p1_turn in your opening or on your own. "
    "ONLY after the players actually answer that they're ready (e.g. 'yes', 'ready', "
    "'let's go') do you then call start_game, hype them briefly, and call start_p1_turn."
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
        # Explicit voice-activity detection so the host reliably hears speech start and
        # replies ~0.5s after you stop talking.
        realtime_input_config=types.RealtimeInputConfig(
            automatic_activity_detection=types.AutomaticActivityDetection(
                disabled=False,
                start_of_speech_sensitivity=types.StartSensitivity.START_SENSITIVITY_HIGH,
                end_of_speech_sensitivity=types.EndSensitivity.END_SENSITIVITY_HIGH,
                prefix_padding_ms=200,
                silence_duration_ms=600,
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
