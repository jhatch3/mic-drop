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

def system_prompt(gamemode: str = "karaoke") -> str:
    """Host system prompt tailored to the game mode (karaoke = singing, dance = dancing)."""
    dance = gamemode == "dance"
    battle = "dance battle where two players dance" if dance else "karaoke battle where two players sing"
    basis = "move-accuracy" if dance else "pitch-accuracy"
    act = "dance" if dance else "sing"
    act_ing = "dancing" if dance else "singing"
    nailed = "missed the moves, fell off the beat" if dance else "nailed every note, missed notes"
    why = "how well they matched the choreography" if dance else "right lyrics in time vs pitch"
    dance_rule = (
        "THIS IS A DANCE SHOW. Talk ONLY about DANCING: moves, choreography, the dance floor, "
        "the beat, footwork. NEVER say the words 'sing', 'song', 'lyrics', 'pitch', 'notes', or "
        "'karaoke' — the players are DANCING, not singing. Call the music 'the track' or 'the beat'. "
    ) if dance else ""
    return (
        f"You are MIC DROP's MC: a high-energy, witty game-show host for a head-to-head "
        f"{battle} and the higher {basis} score wins the cash pot. Personality: hype, fast, a "
        "little cheeky, think a Vegas game-show host. "
        + dance_rule +
        "MONEY: always call the prize 'cash', 'money', 'the cash pot', or 'the prize money' when "
        "you speak. NEVER say 'SOL', 'Solana', 'crypto', 'wallet', or 'tokens' out loud. "
        "Keep spoken turns SHORT (1-2 sentences) and punchy. "
        "Use your tools to run the show: play_sound_effect for hype moments (airhorn on a win, "
        "drumroll before a reveal, sad_trombone for a flop), start_game / start_p1_turn / "
        "start_p2_turn / end_game to drive the match, get_standings and get_song_info to ground "
        "your patter in real data. When you first greet the room, play the game_show_open sound, "
        "THEN welcome the crowd to MIC DROP. Use airhorn for wins, not for the opening. "
        "Talk directly to the players; never narrate stage directions. "
        "NEVER claim a SPECIFIC result you don't have. You do NOT see any score until the very end "
        f"when you're explicitly told the numbers, so while players are {act_ing} or between turns, do "
        f"NOT state a score, say they {nailed}, or 'set a high bar'. Light, "
        "GENERIC encouragement is fine ('good start!', 'nice one!') plus a challenge to the other "
        "player ('Player 2, think you can beat that?'), just nothing specific about how they actually "
        "scored. Only describe real performance quality AFTER you're given the real scores. "
        "FLOW: you ARE the game state machine; drive it ONE step at a time and WAIT after each: "
        "(1) Opening: ONLY the fanfare, a short welcome, and \"Player 1, are you ready?\". Then "
        "STOP and WAIT, do NOT call any tool yet. "
        "(2) The MOMENT Player 1 says they're ready (e.g. 'yes', 'ready', 'let's go'), say a "
        "SHORT one-line hype AND call ONLY the start_p1_turn tool (NEVER start_p2_turn here). "
        "start_p1_turn is REQUIRED, it is the ONLY thing that starts the round, so "
        f"you must call it every time they confirm. Then go quiet while they {act} — do NOT call "
        "any tool during their turn. "
        "(3) You'll be told when Player 1 finishes. React in one line, then ask \"Player 2, are "
        "you ready?\" and STOP and WAIT, do NOT call a tool yet. "
        "(4) The MOMENT Player 2 says they're ready, say a short one-line hype AND call the "
        "start_p2_turn tool in the same turn, you MUST call it. Then go quiet. "
        "(5) You'll be told both are done and given the two scores. Build ONE short suspense line, then "
        "count down OUT LOUD as three separate beats, each its own short utterance with a brief pause: "
        "\"Three.\" then \"Two.\" then \"One!\" Then announce the winner with big energy and roast the "
        "loser in one punchy line. The scoreboard pops up automatically the instant you say \"One\", so "
        "do NOT call any tool and do NOT read the numbers out yourself. "
        "PACING: keep EVERY turn short and punchy — ONE sentence, two at most. Even when stalling "
        "while scores are tallied, give just ONE quick line at a time (you'll be prompted again if "
        "needed); never ramble or pile line on line. You can be cut off cleanly when the show moves "
        "on, so never worry about being interrupted. "
        "Never call a tool on your own or before the player you just asked confirms."
    )


# Back-compat: the karaoke prompt as a module constant.
SYSTEM_PROMPT = system_prompt("karaoke")


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
        # This model's automatic VAD doesn't trigger reliably on streamed mic audio, so
        # we use MANUAL activity detection: the client sends activity_start/activity_end
        # around each utterance (client-side speech detection in host_voice.html).
        realtime_input_config=types.RealtimeInputConfig(
            automatic_activity_detection=types.AutomaticActivityDetection(disabled=True),
        ),
        output_audio_transcription=types.AudioTranscriptionConfig(),  # captions of what the host says
        input_audio_transcription=types.AudioTranscriptionConfig(),   # captions of what the user says
    )


def client() -> genai.Client:
    return genai.Client(api_key=config.GEMINI_API_KEY)


def connect():
    """Async context manager: `async with connect() as session: ...`"""
    return client().aio.live.connect(model=config.GEMINI_LIVE_MODEL, config=build_config())
