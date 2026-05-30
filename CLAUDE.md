# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

## What this is

**Pitch Battle** — a PvP, hot-seat karaoke game with a devnet SOL wager and an AI MC.
Two players take turns singing into a laptop; the higher pitch-accuracy score wins the
staked pot, and an AI host roasts the loser. Hackathon project against five sponsor
tracks: **Solana · Snowflake · Google/Gemini · ElevenLabs** (+ the offline audio stack).

**The build contract is [`docs /pitch-battle-mvp-spec (1).md`](docs%20/pitch-battle-mvp-spec%20(1).md).**
Section 3 (Shared Contracts) of that spec is the source of truth — read it first.

> There is also `docs /MicDrop-FINAL-spec.pdf`, an **earlier/alternative** concept where the
> game runs over a single Twilio phone call with Gemini as the voice host. The current
> build follows the Pitch Battle MVP spec (laptop + phone-controllers, no Twilio). If the
> two ever conflict, the markdown spec wins.

## Current repo status

This repo currently contains **specs only** — no application code has landed yet. The
sections below describe the *intended* structure so new code lands in the right place.

- `docs /pitch-battle-mvp-spec (1).md` — authoritative MVP build contract.
- `docs /MicDrop-FINAL-spec.pdf` — earlier Twilio-call concept (reference only).
- `README.md`, `LICENSE`, `.gitignore`.

> Note: the `docs ` folder name has a trailing space. Quote it in shell commands:
> `cat "docs /pitch-battle-mvp-spec (1).md"`.

## The device model (decided — do not violate)

- **Laptop = the karaoke station.** It owns the USB mic, plays the backing track, draws
  the live pitch graph, and captures audio. All audio lives here.
- **Phones = controllers only.** They join by QR, authenticate with a Solana wallet, and
  ready-up / advance turns. **No audio ever leaves a phone; nothing audio-related crosses
  the network.** This is the deliberate choice that avoids the live-audio-streaming trap.
- Cross-device traffic is small JSON session state over WebSocket (joined / ready / who's
  up) — robust on hostile demo WiFi in a way live audio never would be.

## Two scores, two places (core invariant)

- The **laptop** computes a fast client-side pitch estimate purely to *draw* the live
  graph. It is **never trusted for money**.
- The **backend** recomputes the **authoritative** score from the uploaded audio. Only
  the backend score settles the wager.

## Shared contracts = source of truth

All cross-stream shapes live in `/contracts` as **TypeScript types AND JSON Schema**.
Any shape change happens **there first**, with a heads-up to affected streams. Key types:

- **Pitch is always MIDI note number (float), never Hz**, in stored/transmitted data.
  `midi = 69 + 12*log2(f0_hz/440)`.
- **Scoring primitive — octave-folded cents error:**
  `diff = singer_midi - target_midi; folded = diff - 12*round(diff/12); cents_error = folded*100`.
  A **hit** is `|cents_error| <= 50`.
- `contour.json` (target, offline): 10 ms hop (100 fps), segment-relative `t`,
  `frames[].{t, midi, voiced}`; `midi` is `null` exactly when `voiced=false`.
- `Score` (backend → frontend): `{ song_id, player_id, score (0–100 = 100*hit/scored),
  frames_scored, frames_hit }`.
- `POST /api/match/finish` → `FinishResponse { scores, winner, commentary, mc_audio_url,
  payout_tx, leaderboard }` — the single call the laptop makes at the end.
- `EscrowClient` interface (TS) with `MockEscrowClient` + `DevnetEscrowClient`, flipped by
  `ESCROW_MODE=mock|devnet`.
- Session protocol (3.8): `POST /api/session/{create,join}` + WS `/ws/session/<id>`
  broadcasting `SessionState`; phones send `PhoneMsg`, laptop sends `LaptopMsg`.

## Architecture & repo layout (intended)

```
/contracts          # 3.x types + JSON schema — SOURCE OF TRUTH
/program            # Anchor (Rust) escrow program — Stream A
/client-solana      # EscrowClient + mock + devnet + sign-in helpers — A
/backend            # FastAPI (Python) — B + D
  /scoring          #   B: /api/score + scorer
  /ai               #   D: /api/commentary (Gemini), /api/mc-voice (ElevenLabs)
  /data             #   D: Snowflake client + /api/match*, /api/leaderboard
  /session          #   D: session REST + WS server (contract 3.8)
  /orchestration    #   D: /api/match/finish (wire LAST)
/frontend           # React (Vite, TS) — Stream C
  /station          #   laptop karaoke station (state machine, live graph, capture)
  /controller       #   phone controller route (/controller?session=...)
/assets/songs       # prepped song assets (instrumental.mp3 · contour.json · meta.json) — B
/tools/prep         # offline Demucs/CREPE script — B (build-time only)
```

## Tech stack

- **Backend:** Python + **FastAPI**.
- **Frontend:** **React + Vite** (TypeScript); Web Audio API (`getUserMedia`,
  `AudioContext`, `AnalyserNode`, `MediaRecorder`); `pitchy`/YIN for the live graph;
  canvas via `requestAnimationFrame`.
- **Chain:** **Solana devnet**, **Anchor** (Rust) escrow program, `@solana/web3.js`,
  sign-in-with-Solana for phone auth.
- **Audio scoring:** `torchcrepe` (runtime, `/api/score`); `demucs` + CREPE offline prep
  (build-time only — no GPU at runtime).
- **AI:** **Gemini** (roast commentary), **ElevenLabs** (streaming TTS for the MC voice).
- **Data:** **Snowflake** (`matches` + `players` tables, leaderboard aggregation);
  dev stub = in-memory dict / local SQLite.

## Four parallel streams

| Stream | Builds | Contracts |
|---|---|---|
| **A** Solana | Anchor escrow program, `EscrowClient` + mock, phone sign-in/stake helpers | 3.6 |
| **B** Audio | offline prep script, `/api/score`, song assets | 3.1–3.4, 3.7 |
| **C** Frontend | laptop station (state machine, live graph) + phone `/controller` UI | 3.2–3.8 |
| **D** AI/glue | `/api/commentary`, `/api/mc-voice`, Snowflake, `/api/match/finish`, session WS server | 3.4–3.6, 3.8 |

**Day-0 rule:** every stream's first commit is its **mock + contract types**, so nobody
blocks on anybody. Build granular endpoints first; wire `/api/match/finish` **last**.

**Integration order (each is an env-var flip, not a rewrite):**
1. C ⇄ B — real `/api/score` + 3 real prepped songs.
2. C(laptop) ⇄ C(phone) ⇄ D — real session WS, QR join + Solana sign-in + ready.
3. C ⇄ A — `MockEscrowClient` → `DevnetEscrowClient`.
4. D ⇄ A — backend oracle keypair calls `settle`, paying the winner's authenticated pubkey.

## Invariants to uphold in any code change

1. **Octave fold is non-negotiable** — both scoring and the visual fold cents into `[-6,6]`.
2. **Silence ≠ hit** — `voiced=false`/low-confidence frames are not scored.
3. **Don't tighten the ±3-frame (±30 ms) alignment window** — it absorbs human + system latency.
4. **Backend score is authoritative**; the laptop's live estimate never settles money.
5. **Phones never record audio** — no `getUserMedia` in `/controller`.
6. **`settle` / `refund` are oracle-only** (backend keypair) — never called by a client.
7. **Pay the winner's authenticated phone pubkey**, even when pre-funded demo keypairs
   fund the pot (MVP default staking).
8. **Contracts change in `/contracts` first**, then dependents.

## Scoring service (`/api/score`) — the algorithm

1. Decode upload → mono, 16 kHz. 2. `torchcrepe` → `(t, f0_hz, confidence)` at 10 ms hop.
3. f0 → MIDI; `confidence < 0.5` → silence. 4. Align to target by `t` (same grid, anchored
to playback start); per voiced target frame, search singer frames within ±3 frames for the
smallest octave-folded `|cents_error|`. 5. `score = 100 * frames_hit / frames_scored`
(hit = `|cents_error| <= 50`). 6. Return the `Score` shape.
**Dev stub** until torchcrepe lands: `score = clamp(50 + (duration_sec % 50))`.
**Done-when:** a near-perfect reference scores >90, silence ~0, an octave-shifted take still >90.

## Verify external surfaces before coding (they drift)

Internal contracts are stable; confirm current signatures for: Solana mobile-web sign-in /
wallet-connect, Gemini SDK call shape + auth, ElevenLabs streaming TTS endpoint/format,
Anchor + `@solana/web3.js` versions (lamport-transfer-from-PDA), `torchcrepe`/`demucs` install.

## Hour-0 checklist (from the spec)

1. Create `/contracts` (all of Section 3 incl. 3.8) as TS types + JSON schema; everyone agrees.
2. Each stream lands its day-0 mock + a "done-when" test (incl. D's mock session server).
3. Agree `match_id` / `session_id` formats (short uuids) and env vars (`ESCROW_MODE`, API base URL, WS URL).
4. Pick the 3 songs; B starts prepping immediately (longest lead time).
5. Decide where assets live (committed vs. object storage) and the FastAPI base URL.
