# Stream D — Backend & AI Build Guide (my stream)

**This is the doc I build from.** It hyper-focuses on **Stream D = the Python/FastAPI
backend AI + glue**. Everything else is a *guide*, not my work:

- `docs /pitch-battle-mvp-spec (1).md` — the overall contract (§3 is the source of truth, §8 is my stream).
- `docs /speech-agent.md` — how audio→pitch→STT works (I implement the **STT** half).
- `tasks/stream-D-ai-glue.md` — my checklist.
- `contracts/index.ts` — **frozen** shared types. Read-only for me unless I announce a change.

> **Lane discipline:** the *pitch scorer* (`backend/scoring/`) is **Stream B's**. I read its
> `Score`, I never compute it. The *frontend* (`/frontend`) is **Stream C's**. I expose
> HTTP/WS endpoints; I don't touch React.

---

## What I own

```
backend/
  ai/            # Gemini roast commentary + ElevenLabs MC voice          [scaffolded, mock]
  transcription/ # STT: transcript + lyrics score (faster-whisper)        [NEW — to build]
  session/       # session REST + WebSocket phone-control server          [NEW — to build]
  data/          # Snowflake client: match logging + leaderboard          [NEW — to build]
  orchestration/ # /api/match/finish — ties B + A + ai + data together    [scaffolded, mock]
  common/        # shared audio-load helper, settings, mode switches      [NEW — small]
```

Current scaffold state (what's a stub today):
- `ai/router.py` → `/api/commentary` returns a canned string.
- `ai/mc_voice.py` → `synthesize_voice()` returns `b""`.
- `orchestration/finish.py` → scores both takes (B's mock), picks winner, calls commentary
  + voice, returns hardcoded `payout_tx="mock-tx-signature"` and empty leaderboard.
- `session/`, `data/`, `transcription/`, `common/` → **do not exist yet**.

---

## The one rule for every module: mock ⇄ real behind a switch

Every external dependency (Gemini, ElevenLabs, Snowflake, escrow) flips via an env var so
the backend **always runs**, even with no keys and no heavy ML installed. This mirrors the
project's mock-everywhere philosophy (`.env.example`):

```
GEMINI_MODE=mock|real
ELEVENLABS_MODE=mock|real
SNOWFLAKE_MODE=mock|real
ESCROW_MODE=mock|devnet
STT_PROVIDER=mock|whisper|gemini|elevenlabs   # (add to .env.example)
```

Pattern for each service module:

```python
def get_X():
    return RealX() if settings.X_MODE == "real" else MockX()   # same interface
```

---

## Contracts I must honor (from `contracts/index.ts` — do not drift)

- **`Score`** `{ song_id, player_id, score, frames_scored, frames_hit }` — I **read** this from B.
- **`FinishResponse`** `{ scores: Score[], winner: "p1"|"p2"|"tie", commentary, mc_audio_url,
  payout_tx: string|null, leaderboard: LeaderboardRow[] }` — my orchestrator's output.
- **`LeaderboardRow`** `{ player, wins, losses }` — my Snowflake aggregation.
- **`SessionState`** `{ session_id, phase: "lobby"|"ready"|"in_match"|"result",
  players[{slot,pubkey,connected,ready}], current_turn }` — broadcast on every change.
- **`PhoneMsg`** = `ready | unready | done_singing` (phone → server).
- **`LaptopMsg`** = `set_turn | set_phase` (laptop → server).
- **`EscrowClient.settle(matchId, winner)`** — Stream A's; I call it with the oracle key.

> ⚠️ `FinishResponse.winner` is `"p1"|"p2"|"tie"` and `payout_tx` is **nullable**. The current
> scaffold types `winner: str` / `payout_tx: str` — tighten these to match the contract when I
> touch `finish.py`.

---

## Build order (my phases)

### Phase 1 — Real Gemini commentary  (`ai/`)
- `ai/commentary.py`: `MockCommentary` (canned) + `GeminiCommentary` (real), one
  `generate(song, p1_score, p2_score, winner) -> str` interface; pick via `GEMINI_MODE`.
- Real call uses `google-generativeai` (already in `requirements.txt`) + `GEMINI_API_KEY`.
- Prompt: a short, punchy 2–3 sentence roast that **names the winner** and gently torches the
  loser. Keep it PG and fast.
- `ai/router.py` keeps the `/api/commentary` contract; just delegates to the selected impl.
- **Done-when:** `GEMINI_MODE=real` returns a real roast; `mock` still works offline.

### Phase 2 — Real ElevenLabs MC voice  (`ai/mc_voice.py`)
- `synthesize_voice(text) -> bytes` with mock (`b""`) + real (streaming TTS via `elevenlabs`
  SDK + `ELEVENLABS_API_KEY`), picked by `ELEVENLABS_MODE`.
- Decide audio delivery: write the clip to `assets/mc/<match_id>.mp3` and return a served URL,
  **or** return a `data:` URL. Add a static mount (e.g. `/assets`) if file-serving.
- Add `GET /api/mc-voice` (or keep it internal to `finish`) per the contract seam.
- **Done-when:** real audio plays in the browser; missing audio degrades gracefully (empty url).

### Phase 3 — STT / transcription  (`transcription/` — the speech-agent half I own)
Implements §3 of `docs /speech-agent.md`. Two outputs from one call: **transcript** (captions)
and a **lenient lyrics score**.
- `common/audio.py`: `load_audio(path|bytes, sr=16000) -> np.ndarray` (ffmpeg → mono 16 kHz,
  read via `soundfile`). Shared so STT and B's scorer can both use it.
- `transcription/stt.py`: `transcribe(audio) -> {transcript, words[]}` behind `STT_PROVIDER`
  (`mock` canned; `whisper` = `faster-whisper` with `word_timestamps=True`; later `gemini` /
  `elevenlabs`).
- `transcription/lyrics.py`: `lyrics_score(recognized, reference) -> float` via `rapidfuzz`
  `token_sort_ratio` after lowercase/strip/collapse normalization.
- `transcription/router.py`: `POST /api/transcribe` (multipart audio) → `{transcript, words,
  lyrics_score?}`.
- New deps (add to `requirements.txt`): `faster-whisper`, `rapidfuzz`. `torch`/`torchcrepe`
  are **Stream B's** for pitch — not mine.
- **Caveat to bake in:** STT on *singing* is unreliable; lyrics score is **bonus-only, never
  the money score**. Lean on word timestamps + fuzzy match to reference lyrics.
- **Done-when:** spoken clip transcribes near-verbatim; sung clip degrades but returns words +
  a sane `lyrics_score`; with no whisper installed it falls back to mock.

### Phase 4 — Session server  (`session/`)
- `POST /api/session/create` → `{ session_id, join_url }` (laptop renders QR).
- `POST /api/session/join` → verify signed nonce (sign-in-with-Solana), assign `p1`/`p2` by
  order, store authenticated pubkey → `{ player_slot, ok }`.
- `WS /ws/session/<id>` → hold `SessionState`, apply `PhoneMsg`/`LaptopMsg`, **broadcast full
  state on every change** (use `websockets`, already a dep; or FastAPI WebSocket).
- **Dev stub:** auto-assign two fake players + canned `SessionState` so Stream C can build
  without real auth.
- **Done-when:** two phones join → both ready → laptop advances, all over WS.

### Phase 5 — Snowflake  (`data/`)
- Schema: `matches(match_id, song_id, p1, p2, p1_score, p2_score, winner, stake, payout_tx, ts)`
  and `players(player, wins, losses)`.
- `data/store.py`: `record_match(row)` + `leaderboard() -> LeaderboardRow[]` behind
  `SNOWFLAKE_MODE` (`mock` = in-memory dict / local SQLite; `real` =
  `snowflake-connector-python`, already a dep, creds from `.env`).
- **Done-when:** a finished match writes a row; `leaderboard()` reflects it; mock works offline.

### Phase 6 — Orchestrator  (`orchestration/finish.py`) — wire LAST
The single call the laptop makes at the end. Sequence:
```
finish(match_id, song_id, players[pubkeys], take_p1, take_p2):
  s1, s2   = B.score_take(take_p1), B.score_take(take_p2)          # read Score
  winner   = "tie" if s1==s2 else higher                           # "p1"|"p2"|"tie"
  payout   = EscrowClient.settle(match_id, winner_pubkey)  | refund() on tie   # Stream A, oracle key
  roast    = ai.commentary.generate(...)                           # Phase 1
  mc_url   = ai.mc_voice.synthesize_voice(roast) -> served url     # Phase 2
  data.record_match(...)                                           # Phase 5
  board    = data.leaderboard()
  return FinishResponse{ scores, winner, commentary, mc_audio_url, payout_tx, leaderboard }
```
- Pay the **winner's authenticated phone pubkey** (from `players[]`), even though demo
  keypairs fund the pot. Tie → `refund()`, `payout_tx` may be null.
- Run scoring + STT concurrently where possible (`asyncio.gather`).
- **Done-when:** one scripted call with two fixture takes returns real scores, a settle tx
  (or mock), real roast text, a playable clip, and a new leaderboard row.

---

## Wiring into `backend/main.py`

Register the new routers alongside the existing three:
```python
app.include_router(scoring_router)        # B (exists)
app.include_router(ai_router)             # me (exists)
app.include_router(orchestration_router)  # me (exists)
app.include_router(transcription_router)  # me — Phase 3
app.include_router(session_router)        # me — Phase 4
# session WS endpoint registered on the app directly
```

## Run / verify locally
```
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
# health:   GET  http://localhost:8000/health
# swagger:  http://localhost:8000/docs   ← exercise every endpoint here
```
All endpoints must pass with **all modes = mock** before any real key is added. Then flip one
switch at a time (`GEMINI_MODE`, `ELEVENLABS_MODE`, `STT_PROVIDER`, `SNOWFLAKE_MODE`,
`ESCROW_MODE`) and re-test that seam.

## Done-when (whole stream)
- [ ] `/api/commentary` → real Gemini roast (mock fallback works)
- [ ] `/api/mc-voice` → real ElevenLabs audio (graceful when missing)
- [ ] `/api/transcribe` → transcript + words + lyrics_score (mock fallback)
- [ ] Session server: phone join + ready + turn control over WS
- [ ] Matches log to Snowflake; leaderboard reads back
- [ ] `/api/match/finish` runs the full sequence end-to-end
- [ ] Everything runs with external APIs down (all-mock mode)
