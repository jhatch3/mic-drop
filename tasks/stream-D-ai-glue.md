# Stream D — AI + Glue (ElevenLabs, Orchestration)

**You own:** `backend/ai/`, `backend/orchestration/`, `backend/main.py`

---

## Your files
```
backend/
  main.py                     ← FastAPI app, register all routers
  ai/
    mc_voice.py               ← ElevenLabs TTS
    router.py                 ← POST /api/mc-voice (optional standalone)
  orchestration/
    finish.py                 ← POST /api/match/finish (wire LAST)
    router.py
```

---

## Step 1 — Ship first (unblocks C)

Wire `backend/main.py` so the server starts:
```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from scoring.router import router as scoring_router
from ai.router import router as ai_router
from orchestration.router import router as orch_router

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.include_router(scoring_router, prefix="/api")
app.include_router(ai_router, prefix="/api")
app.include_router(orch_router, prefix="/api")
```

Then stub `POST /api/match/finish` to return a hardcoded `FinishResponse`:
```python
return {
    "scores": [
        {"song_id": song_id, "player_id": "p1", "score": 72, "frames_scored": 100, "frames_hit": 72},
        {"song_id": song_id, "player_id": "p2", "score": 61, "frames_scored": 100, "frames_hit": 61},
    ],
    "winner": "p1",
    "mc_audio_url": "/assets/mc_fallback.mp3",
    "payout_tx": "mock-settle-abc123",
}
```

This lets C build and test the result screen immediately.

## Step 2 — ElevenLabs (`ai/mc_voice.py`)

```python
import os, httpx

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "pNInz6obpgDQGcFmaJgB")  # Adam

def roast_text(song: str, p1_score: int, p2_score: int, winner: str) -> str:
    w = "Player 1" if winner == "p1" else "Player 2"
    l = "Player 2" if winner == "p1" else "Player 1"
    ls = p2_score if winner == "p1" else p1_score
    ws = p1_score if winner == "p1" else p2_score
    return (f"{w} wins with {ws} points — congratulations. "
            f"{l} scored {ls}. I've heard better pitch from a broken kazoo. "
            f"The SOL goes to {w}.")

async def tts(text: str) -> bytes | None:
    if not ELEVENLABS_API_KEY:
        return None
    async with httpx.AsyncClient(timeout=4.0) as client:
        r = await client.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}",
            headers={"xi-api-key": ELEVENLABS_API_KEY},
            json={"text": text, "model_id": "eleven_monolingual_v1",
                  "voice_settings": {"stability": 0.5, "similarity_boost": 0.75}},
        )
        return r.content if r.is_success else None
```

**Pre-generate the fallback clip before demo day:**
```bash
# Run once, commit the mp3
python -c "
import asyncio, ai.mc_voice as mc
audio = asyncio.run(mc.tts(mc.roast_text('your-song', 85, 62, 'p1')))
open('backend/assets/mc_fallback.mp3', 'wb').write(audio)
"
```
Serve it at `/mc-audio/fallback.mp3` from FastAPI using `StaticFiles`.

**Runtime rule:** attempt live ElevenLabs call; if no response in 2s, serve fallback. The crowd never knows.

## Step 3 — Serve the MC audio file
```python
from fastapi.staticfiles import StaticFiles
app.mount("/mc-audio", StaticFiles(directory="assets/mc"), name="mc-audio")
```
Save generated clips to `/tmp/pitch-battle-mc/<match_id>.mp3` and return the URL.

## Step 4 — Wire `/api/match/finish` for real (do this last)

```python
# orchestration/finish.py
import asyncio, json
from pathlib import Path
from scoring.scorer import score_take
from ai.mc_voice import roast_text, tts

ESCROW_MODE = os.getenv("ESCROW_MODE", "mock")
SONGS_DIR = Path(__file__).parent.parent.parent / "assets" / "songs"
FALLBACK_CLIP = Path(__file__).parent.parent / "assets" / "mc_fallback.mp3"

async def handle_finish(match_id, song_id, p1_pubkey, p2_pubkey, p1_bytes, p2_bytes):
    contour = json.loads((SONGS_DIR / song_id / "contour.json").read_text())

    # score both concurrently
    s1, s2 = await asyncio.gather(
        asyncio.to_thread(score_take, p1_bytes, contour, "p1"),
        asyncio.to_thread(score_take, p2_bytes, contour, "p2"),
    )

    # pick winner (tiebreak by frames_hit)
    if s1["score"] != s2["score"]:
        winner = "p1" if s1["score"] > s2["score"] else "p2"
    else:
        winner = "p1" if s1["frames_hit"] >= s2["frames_hit"] else "p2"
    winner_pubkey = p1_pubkey if winner == "p1" else p2_pubkey

    # settle + MC audio concurrently
    payout_tx, mc_audio = await asyncio.gather(
        _settle(match_id, winner_pubkey),
        _mc_audio(song_id, s1["score"], s2["score"], winner),
    )
    mc_url = _save_audio(mc_audio, match_id)

    return {"scores": [s1, s2], "winner": winner,
            "mc_audio_url": mc_url, "payout_tx": payout_tx}

async def _settle(match_id, winner_pubkey):
    if ESCROW_MODE == "mock":
        return f"mock-settle-{match_id[:8]}"
    # TODO: load oracle keypair, call DevnetEscrowClient.settle()
    return f"mock-settle-{match_id[:8]}"

async def _mc_audio(song_id, p1_score, p2_score, winner):
    text = roast_text(song_id, p1_score, p2_score, winner)
    audio = await tts(text)
    return audio or (FALLBACK_CLIP.read_bytes() if FALLBACK_CLIP.exists() else None)

def _save_audio(audio, match_id):
    if not audio: return ""
    out = Path("/tmp/pitch-battle-mc")
    out.mkdir(exist_ok=True)
    path = out / f"{match_id}.mp3"
    path.write_bytes(audio)
    return f"/mc-audio/{match_id}.mp3"
```

## Done-when
```
✓ Server starts: uvicorn main:app --reload
✓ Stub /api/match/finish returns valid FinishResponse (C can integrate)
✓ Live ElevenLabs call returns audio in < 4s
✓ Fallback clip plays when ELEVENLABS_API_KEY is empty
✓ Full /api/match/finish with two real WAV fixtures returns real scores + settle tx
```

## Env vars you need
```
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=pNInz6obpgDQGcFmaJgB
ESCROW_MODE=mock   # → devnet when A deploys
ORACLE_KEYPAIR_PATH=./oracle-keypair.json   # for devnet settle
```

## Integration points
- **← B**: imports `score_take()` from `scoring/scorer.py`
- **← A**: loads oracle keypair to call `DevnetEscrowClient.settle()` (devnet mode only)
- **→ C**: returns `FinishResponse` — C plays `mc_audio_url` and shows `payout_tx`
