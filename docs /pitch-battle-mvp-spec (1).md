# PITCH BATTLE — MVP Design Spec

PvP karaoke, hot-seat, with a devnet SOL wager and an AI MC. This doc is the build contract for a 4-person team. It is written so each stream can build against a **mock** on day 0 and swap in the real thing later.

**Read first:** Section 3 (Shared Contracts) is the source of truth. If you only read one section, read that. Everything else explains how to fulfill those contracts.

**Audio/device model (decided):** the **laptop is the karaoke station** — it owns the mic, plays the backing track, draws the graph, and captures audio. **Phones are controllers only** — they join by QR, authenticate with a Solana wallet, and gate the round (ready-up). No audio ever leaves a phone; nothing audio-related crosses the network.

---

## 1. MVP scope

**In:**
- Hot-seat: two players take turns singing into the **laptop's mic** (USB mic + headphones).
- Phones join via **QR → Solana wallet sign-in → ready/control**. Identity + control only, never a microphone.
- **Cache-only**: 3 songs pre-processed offline. No runtime audio pipeline, no GPU at runtime.
- Live pitch graph (client-side) on the laptop while each player sings.
- Authoritative score recomputed server-side from captured audio.
- Devnet escrow: both stake equal SOL, winner takes the pot — **paid to the winner's authenticated phone wallet**.
- AI MC: Gemini writes a roast, ElevenLabs voices it.
- Snowflake: log each match + a leaderboard read.

**Explicitly out (do not build for MVP):**
- **Phone-as-microphone / live audio streaming between devices.** (This is the trap we chose B to avoid.)
- Live/custom song processing (Demucs/CREPE at runtime). The pipeline is a **build-time script only**.
- Cheating detection, NFTs, Cortex, ELO, remote play, multiple MC voices.

The offline prep script (Demucs + CREPE) exists only to generate the 3 song assets ahead of demo day. Nothing at runtime depends on it.

---

## 2. Architecture at a glance

```
   ┌──────────────────────────────────────────────────────────────┐
   │  LAPTOP = karaoke station (React) — Stream C                   │
   │  USB mic ─getUserMedia─▶ live graph + capture (one AudioCtx)    │
   │  headphones ◀── instrumental.mp3                                │
   │  shows QR · match screen · live graph · result/MC               │
   └─────┬──────────────────┬───────────────────────┬───────────────┘
         │ POST audio blobs  │ WS: session state      │ EscrowClient
         │ /api/match/finish │ (joined, ready, up)    │ (create / stake / settle)
         ▼                   ▼                        ▼
 ┌──────────────────┐  ┌───────────────────┐   ┌─────────────────────┐
 │ BACKEND (FastAPI)│  │ SESSION WS SERVER  │   │ SOLANA (devnet) — A │
 │ /api/score   (B) │  │ (D)                │   │ Anchor escrow       │
 │ /api/commentary  │  │ create/join/ready/ │   │ program + TS client │
 │ /api/mc-voice (D)│  │ broadcast state    │   │ settle() ← oracle   │
 │ /api/match*  (D) │  └─────────▲──────────┘   └─────────────────────┘
 │ oracle key→settle│            │ WS: join + sign-in + ready
 └──────────────────┘            │
        │                ┌───────┴────────────┐
        ▼                │ PHONES = controllers│ (React /controller route) — C
 ┌───────────────┐       │ • scan QR → open    │
 │ Snowflake     │       │ • Solana sign-in    │
 │ matches +     │       │ • "you're up/ready" │
 │ leaderboard   │       │ • NO audio          │
 └───────────────┘       └─────────────────────┘
       ▲
       │   ┌──────────────────────┐
       └── │ /assets/songs/<id>/  │  instrumental.mp3 · contour.json · meta.json
           └──────────────────────┘  (B, offline)
```

**Why this topology is safe:** play + capture both happen on the laptop, so the captured audio shares one clock with the backing track (scoring alignment stays trivial — see 7.2). The only cross-device traffic is small JSON session state over WebSocket (joined/ready/who's-up), which survives hostile WiFi in a way live audio never would.

**Two scores, two places:** the laptop computes a fast pitch estimate purely to *draw* the live graph; it is never trusted for money. The backend recomputes the authoritative score from the uploaded audio. Only the backend score settles the wager.

---

## 3. Shared contracts (SOURCE OF TRUTH)

Commit these to `/contracts` as TypeScript types **and** JSON Schema on hour 0. Every stream imports from here. If a shape changes, it changes here first, with a heads-up to the affected streams.

### 3.1 Pitch representation (used everywhere)

Pitch is always **MIDI note number as a float**, never Hz, in stored/transmitted data.

```
midi = 69 + 12 * log2(f0_hz / 440)
cents_between(a, b) = 100 * (a - b)
```

Octave-folded cents difference (the scoring primitive):

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

### 3.3 Live pitch frame (laptop computes, for the graph only)

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

### 3.5 Match-finish orchestration (the one call the laptop makes at the end)

```ts
// POST /api/match/finish   (multipart: json part + two audio blobs)
type FinishRequest = {
  match_id: string;
  song_id: string;
  players: [{ id: "p1"; pubkey: string }, { id: "p2"; pubkey: string }]; // authenticated phone pubkeys
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

This single endpoint composes the granular services internally (score → settle → commentary → tts → log). Build the granular endpoints first, wire `finish` last. `winner` pubkey passed to settle is the player's **authenticated phone pubkey**, so winnings land in their real wallet.

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

### 3.8 Session & phone-control protocol (NEW — owned by D; consumed by C laptop + C phone)

The laptop opens a session and renders a QR; phones join it, authenticate, and ready up. All of this is small JSON — no audio.

**REST:**
```ts
// Laptop creates a session
// POST /api/session/create  →
type CreateSessionResponse = { session_id: string; join_url: string };  // laptop renders join_url as QR

// Phone joins after scanning (opens /controller?session=<id>)
// POST /api/session/join
type JoinRequest = {
  session_id: string;
  pubkey: string;          // wallet public key
  signature: string;       // signed nonce (sign-in-with-Solana)
  nonce: string;
};
type JoinResponse = { player_slot: "p1" | "p2"; ok: boolean };  // slot by join order
```

**WebSocket** `/ws/session/<session_id>` (both laptop and phones subscribe):
```ts
// server → everyone: the full session state on every change
type SessionState = {
  session_id: string;
  phase: "lobby" | "ready" | "in_match" | "result";
  players: { slot: "p1" | "p2"; pubkey: string | null; connected: boolean; ready: boolean }[];
  current_turn: "p1" | "p2" | null;   // who is singing now
};

// phone → server
type PhoneMsg =
  | { type: "ready"; slot: "p1" | "p2" }
  | { type: "unready"; slot: "p1" | "p2" }
  | { type: "done_singing"; slot: "p1" | "p2" };   // phone advances the turn

// laptop → server
type LaptopMsg =
  | { type: "set_turn"; slot: "p1" | "p2" }
  | { type: "set_phase"; phase: SessionState["phase"] };
```

The laptop's game state machine is driven by `SessionState`; the phone UI renders from it and emits `PhoneMsg`.

---

## 4. Parallelization plan

### 4.1 Four streams, clean boundaries

| Stream | Owner | Builds | Depends on (contract only) |
|---|---|---|---|
| **A** Solana | dev 1 | Anchor program, `EscrowClient` + mock, phone sign-in/stake helpers | 3.6 |
| **B** Audio | dev 2 | offline prep script, `/api/score`, song assets | 3.1–3.4, 3.7 |
| **C** Frontend | dev 3 | laptop station (state machine, live graph) **+ phone `/controller` UI** | 3.2–3.8 |
| **D** AI/glue | dev 4 | `/api/commentary`, `/api/mc-voice`, Snowflake, `/api/match/finish`, **session WS server** | 3.4–3.6, 3.8 |

If only 3 devs: A is the most isolated and specialized — keep one person solely on it. Split D's session server to whoever owns the backend, and fold the phone `/controller` UI into C (it's a thin React route).

### 4.2 Day-0 mock deliverables (this is what unblocks everyone)

Each stream's **first commit** is its mock + its contract types. Nobody waits on anybody after hour 0.

- **A** → `MockEscrowClient` (in-memory balances; create/stake/settle resolve instantly). Publishes 3.6 types.
- **B** → `contour.json` schema + **one** hand-faked asset (a synthetic contour is fine). `/api/score` returns a deterministic fake until the real scorer lands.
- **C** → builds the laptop loop **and** the phone controller against all mocks; goal is a clickable end-to-end skeleton across both screens.
- **D** → mock session server that auto-assigns `p1`/`p2` and broadcasts `SessionState`; `/api/commentary` canned roast; `/api/mc-voice` pre-recorded clip; `/api/leaderboard` static JSON; `/api/match/finish` stitches the mocks.

### 4.3 What can run fully in parallel vs. what must integrate

**Fully parallel, zero cross-dependency (build hours 0–16):**
- A: Anchor program + tests on a local validator.
- B: offline prep script + scoring function (test with fixture WAVs).
- C: laptop UI loop + phone controller, both against mocks.
- D: session WS server + each AI service, tested in isolation.

**Integration points (the only places streams touch — schedule deliberately):**
1. C ⇄ B: swap fake `/api/score` → real; swap faked asset → 3 real prepped songs.
2. C(laptop) ⇄ C(phone) ⇄ D: swap mock session server → real WS; QR join + Solana sign-in + ready flow end-to-end.
3. C ⇄ A: swap `MockEscrowClient` → `DevnetEscrowClient` (needs A deployed to devnet).
4. D ⇄ A: backend holds the oracle keypair and calls `settle`, paying the winner's authenticated pubkey.

**Integration order:** (1) first — the core karaoke loop has no chain or phone dependency. Then (2) the session/phone layer. Then (3) and (4) the chain. Each is an env-var flip, not a rewrite.

### 4.4 Repo layout

```
/contracts          # 3.x types + JSON schema — SOURCE OF TRUTH
/program            # Anchor (Rust) — A
/client-solana      # EscrowClient + mock + devnet + sign-in helpers — A
/backend            # FastAPI — B + D
  /scoring          #   B: /api/score + scorer
  /ai               #   D: /api/commentary, /api/mc-voice
  /data             #   D: Snowflake client + /api/match*, leaderboard
  /session          #   D: session REST + WS server (3.8)
  /orchestration    #   D: /api/match/finish
/frontend           # React (Vite) — C
  /station          #   laptop karaoke station
  /controller       #   phone controller route (/controller?session=...)
/assets/songs       # prepped assets — B
/tools/prep         # offline Demucs/CREPE script — B (build-time only)
```

---

## 5. Stream A — Solana escrow (deep dive)

### Program accounts
- `Match` PDA, seeds `[b"match", match_id]`:
  `player_one: Pubkey, player_two: Pubkey, oracle: Pubkey, stake_lamports: u64, p1_staked: bool, p2_staked: bool, state: u8 {Open=0,Staked=1,Settled=2}, winner: Option<Pubkey>, vault_bump: u8`
- `Vault` PDA, seeds `[b"vault", match_id]`: a program-owned system account holding staked lamports.

### Instructions
- `create_match(match_id, stake_lamports, player_two, oracle)` — `player_one` (signer) inits `Match`, sets `oracle` to the backend's pubkey. State `Open`.
- `stake()` — signer is `player_one` or `player_two`; CPI `system_program::transfer` `stake_lamports` signer → `Vault`; set the matching `*_staked`; both true → `Staked`.
- `settle(winner)` — signer **must equal `oracle`**; require `Staked`; transfer `2 * stake_lamports` from `Vault` → `winner` (PDA-signed CPI with `[b"vault", match_id, &[vault_bump]]`); set `winner`, state `Settled`.
- `refund()` (tie) — oracle-only; return each stake; state `Settled`.

### Phone wallet auth + staking (Option B)
- **Sign-in:** the phone signs a server nonce; the backend verifies it (3.8 `JoinRequest`). The authenticated pubkey is the player's identity and the **payout destination**.
- **Staking (MVP default — low risk):** stakes are funded by **two pre-funded devnet keypairs** held by the laptop/backend, mapped to the two authenticated identities. `settle(winner)` pays the **authenticated phone pubkey**, so real SOL lands in the player's real wallet — the demo beat — even though the demo keypairs funded the pot.
- **Staking (stretch):** the phone signs its own `stake` tx from its real wallet. Honors the full "bet from your wallet" story; only attempt once the default works.
- `settle`/`refund` are only ever called by the backend oracle — never a client.

### Done-when
Local `anchor test`: create → both stake → vault holds `2*stake` → oracle settle pays winner → non-oracle settle rejected.

---

## 6. Stream B — Song prep + scoring (deep dive)

### 6.1 Offline prep (`/tools/prep`, build-time only)
```
audio → demucs (htdemucs) ──▶ vocals.wav ──▶ CREPE/torchcrepe ──▶ contour.json
                           └▶ no_vocals.wav (instrumental) ──▶ instrumental.mp3
```
- Trim to the chosen `segment` first so contour `t` is segment-relative.
- CREPE at 10 ms hop; confidence < ~0.5 → `voiced=false, midi=null`.
- Hand-pick a clean 60–90 s segment (verse + chorus) per song.
- Output exactly the 3.2 schema; validate against the JSON schema in `/contracts`.

### 6.2 Scoring service (`/api/score`, runtime)
1. Decode upload → mono, resample 16 kHz.
2. torchcrepe → per-frame `(t, f0_hz, confidence)` at 10 ms hop, `t` relative to recording start.
3. f0 → MIDI (3.1). `confidence < 0.5` → silence.
4. **Align** to target by `t` (same 10 ms grid, both anchored to playback start — see 7.2). For each `voiced` target frame, search singer frames within **±3 frames (±30 ms)** for the smallest `|cents_error|` (octave-folded, 3.1).
5. `frames_scored` = voiced target frames; `frames_hit` = those matched with `|cents_error| ≤ 50`. `score = 100 * frames_hit / frames_scored`.
6. Return the 3.4 `Score`.

**Dev stub:** until torchcrepe is wired, `score = clamp(50 + (duration_sec % 50))`.

### 6.3 Pitfalls
- Octave fold (3.1) — non-negotiable.
- Silence ≠ hit.
- The ±3-frame window absorbs human + system latency; don't tighten it.

### Done-when
A near-perfect reference vocal scores >90; silence ~0; the same vocal shifted an octave still scores >90.

---

## 7. Stream C — Laptop station + phone controller (deep dive)

### 7.1 Laptop game state machine
Driven by `SessionState` (3.8):
`LOBBY(show QR, wait for joins) → READY(both phones ready) → SONG_SELECT → STAKING → COUNTDOWN(p1) → SINGING(p1) → COUNTDOWN(p2) → SINGING(p2) → SCORING → RESULT`
- LOBBY: `POST /api/session/create`, render `join_url` as a QR; subscribe to the WS; show players as they join + ready.
- SONG_SELECT: render `manifest.json` (MVP = tap list).
- STAKING: `createMatch` + fund both stakes (pre-funded keypairs mapped to authenticated identities).
- SINGING(pX): play `instrumental.mp3`, run the graph, capture audio; the phone's `done_singing` (or end-of-track) advances the turn.
- SCORING: after p2, POST both blobs to `/api/match/finish`.
- RESULT: show scores, play `mc_audio_url`, show `payout_tx` + balances + leaderboard.

### 7.2 Audio + the master clock (unchanged by Option B — still all on the laptop)
Use `AudioContext.currentTime` as the single clock so the graph, the backing track, and the captured audio share one timeline:
- **Hardware:** a USB mic (or headset mic) + **headphones** for the singer, so the backing track does not bleed into the mic.
- `getUserMedia` → `AudioContext`. One branch → `AnalyserNode` for **live** pitch (`pitchy`/YIN) to draw the graph; another → `MediaRecorder` to capture the take.
- Start `instrumental.mp3`; record `t0 = audioCtx.currentTime`. Song position = `audioCtx.currentTime - t0`; the captured audio is anchored to the same `t0`, which makes server alignment (6.2 step 4) trivial.

### 7.3 The graph
- `requestAnimationFrame` canvas. X = time (scrolling ~3 s lookahead), Y = pitch (MIDI).
- Draw the target contour; plot the live pitch trail; green within ~50 cents of the nearest target (octave-folded for the visual too), red otherwise.

### 7.4 Phone controller (`/controller?session=<id>`)
Thin React route, renders from `SessionState`:
- On load: read `session` from the URL, run Solana sign-in (sign nonce), `POST /api/session/join` → get slot, open the WS.
- UI states: "Waiting for the other player" → **READY** button (emits `ready`) → "You're up — sing into the laptop!" with a **Done** button (emits `done_singing`) → "Your score: NN".
- **No** `getUserMedia` here. The phone never records.

### 7.5 Mocks consumed
`MockEscrowClient`, faked `/api/score`/`/api/match/finish`, B's faked asset, D's mock session server. Build both screens before any real service exists.

### Done-when
QR → phone joins → both ready → laptop runs the full loop, graph renders, takes captured + POSTed, phones reflect turn/score — all against mocks.

---

## 8. Stream D — AI services + session + glue + Snowflake (deep dive)

### 8.1 Session server (`/api/session/*`, `/ws/session/<id>`) — 3.8
- `create` → mint `session_id` + `join_url`.
- `join` → verify the signed nonce, assign `p1`/`p2` by order, store the authenticated pubkey.
- WS → hold `SessionState`, apply `PhoneMsg`/`LaptopMsg`, broadcast on every change.
- **Dev stub:** auto-assign two fake players and broadcast a canned `SessionState` so C can build without real auth.

### 8.2 `/api/commentary` (Gemini)
`{ song, p1_score, p2_score, winner }` → a short punchy roast (2–3 sentences) naming the winner and gently torching the loser. **Dev stub:** canned string.

### 8.3 `/api/mc-voice` (ElevenLabs)
`{ text }` → streaming TTS → audio URL (or data URL). **Dev stub:** one pre-recorded clip.

### 8.4 Snowflake (`/api/match`, `/api/leaderboard`)
```sql
matches(match_id, song_id, p1, p2, p1_score, p2_score, winner, stake, payout_tx, ts)
players(player, wins, losses)
```
Write a row per finished match; leaderboard = aggregation. **Dev stub:** in-memory dict / local SQLite, swap to `snowflake-connector-python` at integration.

### 8.5 `/api/match/finish` (orchestration — wire last)
`score(take_p1)` + `score(take_p2)` → pick winner → `EscrowClient.settle(winner_pubkey)` with the **oracle keypair** → `commentary` → `mc-voice` → write Snowflake row → return 3.5 `FinishResponse`. Tie → `refund()`.

### Done-when
A scripted call with two fixture takes returns real scores, a real settle tx on devnet paying the authenticated winner, real roast text, a playable clip, and a new leaderboard row.

---

## 9. End-to-end finish sequence

```
LOBBY: laptop POST /session/create → QR; phones scan → sign-in → join (slots p1,p2)
READY: both phones emit "ready" → laptop advances
STAKING: createMatch + fund both stakes (pre-funded keypairs ↔ authenticated identities)
SING p1: laptop plays instrumental, captures p1 take; phone p1 emits done_singing
SING p2: same for p2
C → POST /api/match/finish {match_id, song_id, players(pubkeys), take_p1, take_p2}
   D → B.score(take_p1) , B.score(take_p2) → Score(p1), Score(p2)
   D: winner = higher score (or "tie")
   D → A.settle(match_id, winner_pubkey)  [oracle key] → payout_tx   (pays real phone wallet)
   D → Gemini.commentary(...) → roast ; ElevenLabs.mc_voice(roast) → mc_audio_url
   D → Snowflake.insert(match row) ; read leaderboard
   D → FinishResponse
C: render scores, play mc_audio_url, show payout_tx + balances + leaderboard ; phones show score
```

---

## 10. Demo fixtures
- 3 prepped songs in `/assets/songs/`.
- 2 pre-funded devnet keypairs mapped to the two authenticated phone identities.
- **Phone-join fallback:** if a phone won't connect on demo WiFi, the laptop can self-assign both slots and ready them locally (a hidden "manual mode" toggle) so the show goes on.
- Pre-recorded fallback takes (WAV) in case a mic misbehaves.
- Pre-generated commentary + MC clips for the showcase song, used if the live APIs lag.

## 11. Verify against current docs before coding
Internal contracts above are stable; these external surfaces shift — confirm current signatures rather than trust memory:
- **Solana mobile-web sign-in / wallet-connect** (the phone auth + the stretch phone-signed stake).
- Gemini SDK: text-generation call shape + auth.
- ElevenLabs: streaming TTS endpoint + auth + audio format.
- Anchor + `@solana/web3.js` versions and the lamport-transfer-from-PDA pattern.
- `torchcrepe`/`demucs` install + GPU flags for the prep box.

## 12. Hour-0 checklist
1. Create `/contracts` with all of Section 3 (including 3.8) as TS types + JSON schema. **Everyone reviews and agrees.**
2. Each stream lands its day-0 mock (4.2) and a "done-when" test — including D's mock session server.
3. Agree `match_id` / `session_id` formats (short uuids) and env vars (`ESCROW_MODE`, API base URL, WS URL).
4. Pick the 3 songs; B starts prepping immediately (longest lead time).
5. Decide where assets live (committed vs. object storage) and the FastAPI base URL.
