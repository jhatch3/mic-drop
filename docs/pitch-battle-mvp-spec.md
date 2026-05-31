# PITCH BATTLE — MVP Design Spec

PvP karaoke, hot-seat, with a devnet SOL wager and an AI MC. This doc is the build contract for a 4-person team. It is written so each stream can build against a **mock** on day 0 and swap in the real thing later.

**Read first:** Section 3 (Shared Contracts) is the source of truth. If you only read one section, read that. Everything else explains how to fulfill those contracts.

---

## 1. MVP scope

**In:**
- Hot-seat, one machine, two players take turns on one mic.
- **Cache-only**: 3 songs pre-processed offline. No runtime audio pipeline, no GPU at runtime.
- Live pitch graph (client-side) while each player sings.
- Authoritative score recomputed server-side from captured audio.
- Devnet escrow: both stake equal SOL, winner takes the pot.
- AI MC: Gemini writes a roast, ElevenLabs voices it.
- Snowflake: log each match + a leaderboard read.

**Explicitly out (do not build for MVP):**
- Live/custom song processing (Demucs/CREPE at runtime). The pipeline is a **build-time script only**.
- Cheating detection, NFTs, Cortex, ELO, remote play, multiple MC voices.

The offline prep script (Demucs + CREPE) still exists, but its **only** job is to generate the 3 song assets ahead of demo day. Nothing at runtime depends on it.

---

## 2. Architecture at a glance

```
                         ┌────────────────────────────────────────┐
                         │  FRONTEND (React) — Stream C             │
   mic ──getUserMedia──▶ │  • game state machine                   │
                         │  • live pitch graph (client pitch)       │
   speakers ◀──play───── │  • plays instrumental.mp3                │
                         │  • wallet UI / two keypairs              │
                         └───────┬───────────────┬──────────────────┘
                                 │               │
              POST audio blobs   │               │  TS client calls
              /api/match/finish  │               │  (create/stake)
                                 ▼               ▼
        ┌────────────────────────────────┐   ┌──────────────────────────┐
        │  BACKEND (FastAPI) — B + D      │   │  SOLANA — Stream A        │
        │  /api/score      (B, scoring)   │   │  Anchor escrow program    │
        │  /api/commentary (D, Gemini)    │   │  + TS client wrapper      │
        │  /api/mc-voice   (D, 11Labs)    │   │  (devnet)                 │
        │  /api/match*     (D, Snowflake) │◀──┤  settle() called by       │
        │  oracle keypair signs settle ───┼──▶│  backend oracle           │
        └────────────────────────────────┘   └──────────────────────────┘
                                 │
                                 ▼
                         ┌───────────────┐      ┌──────────────────────┐
                         │  Snowflake    │      │  /assets/songs/<id>/  │
                         │  matches +    │      │  instrumental.mp3     │
                         │  leaderboard  │      │  contour.json         │
                         └───────────────┘      │  meta.json   (B,offline)│
                                                └──────────────────────┘
```

**Two scores, two places** (unchanged from the parent spec): the client computes a fast pitch estimate purely to *draw* the live graph; it is never trusted for money. The backend recomputes the authoritative score from the uploaded audio. Only the backend score settles the wager.

---

## 3. Shared contracts (SOURCE OF TRUTH)

Commit these to `/contracts` as TypeScript types **and** JSON Schema on hour 0. Every stream imports from here. If a shape changes, it changes here first, with a heads-up to the affected streams.

### 3.1 Pitch representation (used everywhere)

Pitch is always **MIDI note number as a float**, never Hz, in stored/transmitted data.

```
midi = 69 + 12 * log2(f0_hz / 440)
cents_between(a, b) = 100 * (a - b)
```

Octave-folded cents difference (this is the scoring primitive):

```
diff = singer_midi - target_midi                 // semitones, float
folded = diff - 12 * round(diff / 12)             // folds into [-6, 6]
cents_error = folded * 100                         // a hit is |cents_error| <= 50
```

### 3.2 Target contour (`contour.json`, produced offline by B)

Frame grid is **10 ms hop (100 fps)**, timestamps are **segment-relative** (t=0 is the first audio sample of the segment).

```jsonc
{
  "song_id": "blinding-lights",
  "title": "Blinding Lights",
  "artist": "...",
  "segment": { "start_sec": 41.0, "end_sec": 122.0 },  // bounds within original
  "hop_ms": 10,
  "frames": [
    { "t": 0.00, "midi": 60.5, "voiced": true  },
    { "t": 0.01, "midi": null, "voiced": false },
    // ... ~8100 frames for an 81s segment
  ]
}
```

`voiced=false` frames are not scored (instrumental gaps, breaths). `midi` is `null` exactly when `voiced=false`.

### 3.3 Live pitch frame (client computes, for the graph only)

```ts
type LiveFrame = { t: number; midi: number | null; confidence: number };
```

### 3.4 Score object (backend → frontend)

```ts
type Score = {
  song_id: string;
  player_id: string;          // "p1" | "p2"
  score: number;              // 0–100, = 100 * frames_hit / frames_scored
  frames_scored: number;
  frames_hit: number;
};
```

### 3.5 Match-finish orchestration (the one call the frontend makes at the end)

```ts
// POST /api/match/finish   (multipart: json part + two audio blobs)
type FinishRequest = {
  match_id: string;
  song_id: string;
  players: [{ id: "p1"; pubkey: string }, { id: "p2"; pubkey: string }];
  // audio uploaded as files: take_p1, take_p2  (webm/opus or wav)
};

type FinishResponse = {
  scores: Score[];                  // both players
  winner: "p1" | "p2" | "tie";
  commentary: string;               // Gemini roast text
  mc_audio_url: string;             // ElevenLabs clip (or data URL)
  payout_tx: string | null;         // Solana settle signature ("mock-..." in dev)
  leaderboard: LeaderboardRow[];
};

type LeaderboardRow = { player: string; wins: number; losses: number };
```

This single endpoint composes the granular services internally (score → settle → commentary → tts → log). Build the granular endpoints first, wire `finish` last.

### 3.6 Solana client wrapper (TS, owned by A; consumed by C + D)

```ts
interface EscrowClient {
  createMatch(stakeLamports: number, p2: PublicKey): Promise<{ matchId: string }>;
  stake(matchId: string, player: Keypair): Promise<string>;        // tx sig
  settle(matchId: string, winner: PublicKey): Promise<string>;     // ORACLE only
  getMatch(matchId: string): Promise<MatchState>;
}
type MatchState = {
  matchId: string;
  stakeLamports: number;
  p1Staked: boolean; p2Staked: boolean;
  state: "Open" | "Staked" | "Settled";
  winner: PublicKey | null;
};
```

A ships **two** implementations behind the same interface: `MockEscrowClient` (in-memory, resolves instantly) and `DevnetEscrowClient`. Frontend and backend code against the interface and flip via env var `ESCROW_MODE=mock|devnet`.

### 3.7 Song manifest (B → C)

```jsonc
// /assets/songs/manifest.json
[
  { "song_id": "blinding-lights", "title": "...", "artist": "...", "difficulty": 3 },
  { "song_id": "...", ... },
  { "song_id": "...", ... }
]
```

---

## 4. Parallelization plan

### 4.1 Four streams, clean boundaries

| Stream | Owner | Builds | Depends on (contract only) |
|---|---|---|---|
| **A** Solana | dev 1 | Anchor program, `EscrowClient` + mock | 3.6 |
| **B** Audio | dev 2 | offline prep script, `/api/score`, song assets | 3.1–3.4, 3.7 |
| **C** Frontend | dev 3 | game state machine, live graph, wallet UI | 3.2–3.6, 3.7 |
| **D** AI/glue | dev 4 | `/api/commentary`, `/api/mc-voice`, Snowflake, `/api/match/finish` | 3.4–3.6 |

If only 3 devs: A is the most isolated and specialized — keep one person solely on it. Split D's glue between B (backend wiring) and C (frontend integration); D's Gemini/ElevenLabs work folds into whoever has spare cycles after their core.

### 4.2 Day-0 mock deliverables (this is what unblocks everyone)

Each stream's **first commit** is its mock + its contract types. Nobody waits on anybody after hour 0.

- **A** → `MockEscrowClient` that tracks balances in memory; `createMatch/stake/settle` resolve instantly. Publishes 3.6 types.
- **B** → `contour.json` schema + **one** hand-faked asset (a synthetic contour is fine — even a sine sweep) so C can render immediately. `/api/score` returns a deterministic fake (e.g. score derived from audio duration) until the real scorer lands.
- **C** → builds the full state machine against all mocks; goal is a clickable end-to-end skeleton.
- **D** → `/api/commentary` returns a canned roast; `/api/mc-voice` returns a pre-recorded clip; `/api/leaderboard` returns static JSON; `/api/match/finish` stitches the mocks.

### 4.3 What can run fully in parallel vs. what must integrate

**Fully parallel, zero cross-dependency (build hours 0–16):**
- A: the Anchor program + tests (validator is local; no frontend needed).
- B: the offline prep script and the scoring function (test with fixture WAVs; no frontend needed).
- C: the entire UI loop against mocks.
- D: each AI service tested in isolation with a curl/script harness.

**Integration points (the only places streams touch — schedule these deliberately):**
1. C ⇄ A: swap `MockEscrowClient` → `DevnetEscrowClient`. (needs A's program deployed to devnet)
2. C ⇄ B: swap fake `/api/score` → real; swap faked asset → real prepped songs.
3. C ⇄ D: real `/api/match/finish` returns real commentary + MC audio + payout.
4. D ⇄ A: backend holds the oracle keypair and calls `settle`. (needs A's deployed program + the oracle pubkey baked into the program at create-time)

**Integration order:** do (2) first (it's the core loop and has no chain dependency), then (1), then (4), then (3) last. Each is an env-var flip, not a rewrite.

### 4.4 Repo layout

```
/contracts          # 3.x types + JSON schema — SOURCE OF TRUTH
/program            # Anchor (Rust) — A
/client-solana      # EscrowClient + mock + devnet — A
/backend            # FastAPI — B + D
  /scoring          #   B: /api/score + scorer
  /ai               #   D: /api/commentary, /api/mc-voice
  /data             #   D: Snowflake client + /api/match*, leaderboard
  /orchestration    #   D: /api/match/finish
/frontend           # React (Vite) — C
/assets/songs       # prepped assets (committed or in object storage) — B
/tools/prep         # offline Demucs/CREPE script — B (build-time only)
```

---

## 5. Stream A — Solana escrow (deep dive)

### Program accounts
- `Match` PDA, seeds `[b"match", match_id]`:
  `player_one: Pubkey, player_two: Pubkey, oracle: Pubkey, stake_lamports: u64, p1_staked: bool, p2_staked: bool, state: u8 {Open=0,Staked=1,Settled=2}, winner: Option<Pubkey>, vault_bump: u8`
- `Vault` PDA, seeds `[b"vault", match_id]`: a program-owned system account that holds the staked lamports.

### Instructions
- `create_match(match_id, stake_lamports, player_two, oracle)` — `player_one` (signer) inits `Match`, sets `oracle` to the backend's pubkey (passed in, baked at creation). State `Open`.
- `stake()` — signer must be `player_one` or `player_two`; CPI `system_program::transfer` `stake_lamports` from signer → `Vault`; set the matching `*_staked` bool; when both true → state `Staked`.
- `settle(winner)` — signer **must equal `oracle`**; require state `Staked`; transfer the full pot (`2 * stake_lamports`) from `Vault` → `winner` (PDA-signed CPI with `[b"vault", match_id, &[vault_bump]]`); set `winner`, state `Settled`.
- `refund()` (tie) — oracle-only; return each stake to each player; state `Settled`.

### Client wrapper
Implements 3.6. `settle`/`refund` are only ever called by the backend with the oracle keypair — never the frontend.

### Hot-seat staking (demo recommendation)
Juggling a browser wallet extension between two players mid-demo is painful. **Recommended:** the app holds **two pre-funded devnet keypairs** (faucet'd before the demo) and signs each player's `stake` in turn. Keep `@solana/wallet-adapter` as the "real" path but don't put it on the demo critical path.

### Done-when
Local `anchor test` proves: create → both stake → vault holds `2*stake` → oracle settle → winner balance += `2*stake`, non-oracle settle rejected.

---

## 6. Stream B — Song prep + scoring (deep dive)

### 6.1 Offline prep (`/tools/prep`, build-time only)
Per song, run once, commit the output:
```
audio.(mp3|wav) → demucs (htdemucs) ──▶ vocals.wav ──▶ CREPE/torchcrepe ──▶ contour.json
                                     └▶ no_vocals.wav (instrumental) ──▶ instrumental.mp3
```
- Trim everything to the chosen `segment` first so contour `t` is segment-relative.
- CREPE at 10 ms hop; map confidence < ~0.5 to `voiced=false, midi=null`.
- Hand-pick a clean 60–90 s segment (verse + chorus) per song.
- Output exactly the 3.2 schema. Validate against the JSON schema in `/contracts`.

### 6.2 Scoring service (`/api/score`, runtime)
Pure function over uploaded audio + the target contour:
1. Decode upload → mono, resample 16 kHz.
2. Run pitch detection (torchcrepe) → per-frame `(t, f0_hz, confidence)` at 10 ms hop, `t` relative to recording start.
3. Convert f0 → MIDI (3.1). Frames with `confidence < 0.5` → treated as silence.
4. **Align** to target by `t` (same 10 ms grid; both anchored to playback start — see 7). For each `voiced` target frame, search singer frames within **±3 frames (±30 ms)** for the smallest `|cents_error|` (octave-folded, 3.1).
5. `frames_scored` = count of voiced target frames. `frames_hit` = those with a matched singer frame where `|cents_error| ≤ 50`. `score = 100 * frames_hit / frames_scored`.
6. Return the 3.4 `Score`.

**Dev stub:** until torchcrepe is wired, return `score = clamp(50 + (duration_sec % 50))`. Deterministic, lets C/D integrate.

### 6.3 Pitfalls to handle
- Octave fold (3.1) — non-negotiable, or low/high singers score 0.
- Silence ≠ hit — unvoiced singer frames over voiced target frames are misses.
- The ±3-frame window absorbs human + system latency; don't tighten it.

### Done-when
Feeding a near-perfect reference vocal scores >90; feeding silence scores ~0; feeding the same vocal shifted an octave still scores >90.

---

## 7. Stream C — Frontend + live graph (deep dive)

### 7.1 Game state machine
`LOBBY → SONG_SELECT → STAKING → COUNTDOWN(p1) → SINGING(p1) → COUNTDOWN(p2) → SINGING(p2) → SCORING → RESULT`
- LOBBY: load both keypairs/balances.
- SONG_SELECT: render `manifest.json`; (MVP can be a tap list; voice select is post-MVP).
- STAKING: call `client.createMatch` then `client.stake` for each player.
- SINGING(pX): play `instrumental.mp3`, run the graph, capture audio; on end, hold the blob.
- SCORING: after p2, POST both blobs to `/api/match/finish`.
- RESULT: show scores, play `mc_audio_url`, show `payout_tx` + updated balances + leaderboard.

### 7.2 Audio + the master clock (critical)
Use `AudioContext.currentTime` as the single clock so the graph, the backing track, and the captured audio all share one timeline:
- `getUserMedia` → `AudioContext`. One branch → `AnalyserNode` for **live** pitch (`pitchy`/YIN) to draw the graph. Another branch → `MediaRecorder` to capture the take for upload.
- Start `instrumental.mp3` playback; record `t0 = audioCtx.currentTime`. Song position at any moment = `audioCtx.currentTime - t0`. The captured audio is anchored to the same `t0`, which is what makes server-side alignment (6.2 step 4) trivial.

### 7.3 The graph
- `requestAnimationFrame` loop on a canvas. X = time (scrolling window, ~3 s lookahead), Y = pitch (MIDI).
- Draw the target contour line from `contour.json`; plot the live pitch point/trail; color green when within ~50 cents of the nearest target, red otherwise. Octave-fold the *visual* comparison too so the trail sits on the line for in-range singers.

### 7.4 Mocks consumed
`MockEscrowClient`, faked `/api/score`/`/api/match/finish`, the one faked asset from B. Build the whole loop before any real service exists.

### Done-when
Full loop is clickable end-to-end against mocks, graph renders against the faked contour, a take is captured and POSTed.

---

## 8. Stream D — AI services + glue + Snowflake (deep dive)

### 8.1 `/api/commentary` (Gemini)
Input `{ song, p1_score, p2_score, winner }` → a short, punchy roast (2–3 sentences) naming the winner and gently torching the loser. Keep a temperature high enough to be funny, low enough to stay coherent. **Dev stub:** canned string.

### 8.2 `/api/mc-voice` (ElevenLabs)
Input `{ text }` → streaming TTS → return an audio URL (or data URL) the frontend can play. **Dev stub:** one pre-recorded clip.

### 8.3 Snowflake (`/api/match`, `/api/leaderboard`)
Tables:
```sql
matches(match_id, song_id, p1, p2, p1_score, p2_score, winner, stake, payout_tx, ts)
players(player, wins, losses)   -- or derive leaderboard via aggregation
```
Write a row per finished match; leaderboard = `SELECT player, wins, losses ...`. **Dev stub:** in-memory dict / local SQLite, swap to `snowflake-connector-python` at integration.

### 8.4 `/api/match/finish` (orchestration — wire last)
Compose: `score(take_p1)` + `score(take_p2)` → pick winner → `EscrowClient.settle(winner)` with the **oracle keypair** → `commentary` → `mc-voice` → write Snowflake row → return 3.5 `FinishResponse`. Tie → `refund()`.

### Done-when
A scripted call with two fixture takes returns real scores, a real settle tx on devnet, real roast text, a playable clip, and a new leaderboard row.

---

## 9. End-to-end finish sequence

```
C: play instrumental, capture p1 take
C: play instrumental, capture p2 take
C → POST /api/match/finish {match_id, song_id, players, take_p1, take_p2}
   D → B.score(take_p1, contour) → Score(p1)
   D → B.score(take_p2, contour) → Score(p2)
   D: winner = higher score (or "tie")
   D → A.settle(match_id, winner_pubkey)  [oracle key]  → payout_tx
   D → Gemini.commentary(...) → roast
   D → ElevenLabs.mc_voice(roast) → mc_audio_url
   D → Snowflake.insert(match row) ; read leaderboard
   D → FinishResponse
C: render scores, play mc_audio_url, show payout_tx + balances + leaderboard
```

---

## 10. Demo fixtures
- 3 prepped songs in `/assets/songs/`.
- 2 pre-funded devnet keypairs loaded in-app.
- Pre-recorded fallback takes (WAV) so the demo can run even if a mic misbehaves.
- Pre-generated commentary + MC clips for the showcase song, used if the live APIs lag.

## 11. Verify against current docs before coding
The internal contracts above are stable; these external surfaces change, so the implementing dev/agent should confirm current signatures rather than trust memory:
- Gemini SDK: text-generation call shape + auth.
- ElevenLabs: streaming TTS endpoint + auth + audio format.
- Anchor + `@solana/web3.js` + wallet-adapter versions and the lamport-transfer-from-PDA pattern.
- `torchcrepe`/`demucs` install + GPU flags for the prep box.

## 12. Hour-0 checklist
1. Create `/contracts` with all of Section 3 as TS types + JSON schema. **Everyone reviews and agrees.**
2. Each stream lands its day-0 mock (4.2) and a "done-when" test.
3. Agree the `match_id` format (suggest a short uuid) and `ESCROW_MODE` / API base-url env vars.
4. Pick the 3 songs; B starts prepping immediately (longest lead time).
5. Decide where assets live (committed vs. object storage) and the FastAPI base URL.
```
