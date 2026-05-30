# Stream C — Frontend (Laptop Station)

**You own:** `frontend/`

---

## Your files
```
frontend/src/
  App.tsx
  state/machine.ts          ← game state machine (useReducer)
  hooks/useAudio.ts         ← getUserMedia + pitchy + MediaRecorder
  hooks/useSongAssets.ts    ← load manifest + contour.json + instrumental.mp3
  api/index.ts              ← fetch wrappers for /api/*
  escrow/client.ts          ← wraps MockEscrowClient (or Devnet)
  components/
    SongSelect.tsx
    StakingScreen.tsx
    CountdownScreen.tsx
    SingingScreen.tsx        ← contains PitchGraph
    PitchGraph.tsx           ← canvas, requestAnimationFrame, 30fps
    ResultScreen.tsx
```

---

## Step 1 — Ship first (unblocks yourself)
Wire the full game loop against mocks before any real service exists.

**Game states (in order):**
```
SONG_SELECT → STAKING → COUNTDOWN(p1) → SINGING(p1)
           → COUNTDOWN(p2) → SINGING(p2) → SCORING → RESULT
```

Use `useReducer` with a `GameState` type in `state/machine.ts`.
Mock the API calls in `api/index.ts` — return hardcoded Score objects.
Use `MockEscrowClient` from `client-solana/src/mock.ts`.

Goal: full clickable loop end-to-end before touching audio.

## Step 2 — The pitch graph (the wow moment — get this right)

**Audio setup (one AudioContext, one clock):**
```
getUserMedia
    ↓
AudioContext ──→ AnalyserNode (FFT 2048) ──→ pitchy ──→ canvas (30fps rAF)
            └──→ MediaRecorder (WebM/Opus) ──→ Blob (uploaded at turn end)
```

Key rules:
- One `AudioContext` per singing session. Close it after recording stops.
- Record `t0 = audioCtx.currentTime` when instrumental starts.
  Song position at any moment = `audioCtx.currentTime - t0`.
  The captured audio is anchored to `t0` — this is what makes server-side scoring align.
- Play `instrumental.mp3` via `AudioContext` (not `<audio>` tag) so it shares the clock.

**The graph canvas:**
- X axis = time, scrolling window (~3s lookahead)
- Y axis = MIDI note number (range ~45–84)
- Draw target contour from `contour.json` in white/gray
- Plot live pitch trail: **green** when within 50 cents of nearest target, **red** otherwise
- Octave-fold the visual comparison (same formula as scoring):
  `diff = singerMidi - targetMidi; folded = diff - 12*round(diff/12); cents = folded*100`
- 3-frame rolling average on pitchy output to kill jitter

**Validate on Day 0:** confirm pitchy runs at ≥30fps on the actual demo laptop before building the full graph.

**Result screen:** overlay both players' pitch trails (P1 blue, P2 orange, target white). Store P1's trail in state while P2 sings.

## Step 3 — Wire real services (env-var flips, no rewrites)

```
VITE_API_BASE=http://localhost:8000
VITE_ESCROW_MODE=mock   # → swap to devnet when A deploys
```

Integration order:
1. **C ⇄ B**: swap fake `/api/score` response → real. Swap fake contour → real prepped song.
2. **C ⇄ A**: swap `MockEscrowClient` → `DevnetEscrowClient` via `VITE_ESCROW_MODE=devnet`.

## Staking (pre-funded keypairs — no wallet adapter needed)
The app holds two hardcoded devnet keypairs (funded before demo day via `solana airdrop`).
Call `createMatch(stakeLamports, p2.publicKey)` then `stake()` for each player.
Pass `p1_pubkey` and `p2_pubkey` in the `/api/match/finish` form so the backend can settle the right wallets.

## Posting the finish request
At the end of SINGING(p2), POST to `/api/match/finish`:
```
multipart/form-data:
  match_id      string
  song_id       string
  p1_pubkey     string
  p2_pubkey     string
  take_p1       Blob (WebM/Opus)
  take_p2       Blob (WebM/Opus)
```

## Result screen
Show:
- Both scores (0–100)
- Winner banner
- Play `mc_audio_url` (the ElevenLabs roast)
- Show `payout_tx` (even if it's `mock-settle-xxx`)
- Overlay pitch trails for both players

## Done-when
```
✓ Full loop clickable end-to-end against mocks (no network needed)
✓ Graph renders against a real contour at ≥30fps, no visible jank
✓ Audio captured and POSTed to /api/match/finish
✓ Result screen plays MC audio and shows winner
```

## Integration points
- **← A**: `client-solana/src/mock.ts` and `devnet.ts` — import via `@client-solana`
- **← B**: `GET /assets/songs/manifest.json`, `GET /assets/songs/<id>/contour.json`, `GET /assets/songs/<id>/instrumental.mp3`
- **← D**: `POST /api/match/finish` → `FinishResponse`
