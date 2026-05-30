# Integration — How the 4 streams connect

## Day 0: everyone's first commit

Before writing any app code — commit `/contracts/index.ts` with the shared types.
All four streams import from there. If a shape changes, it changes there first.

| Stream | First commit |
|--------|-------------|
| A | `MockEscrowClient` in `client-solana/src/mock.ts` |
| B | Fake `contour.json` + dev stub `scorer.py` |
| C | Full game loop against mocks (no network) |
| D | `POST /api/match/finish` returning hardcoded response + server starts |

After Day 0, no one is blocked on anyone else.

---

## The 4 integration points (each is one env-var flip)

### 1. C ⇄ B — Real scoring + real songs
**When:** B has real `librosa.pyin` scoring working + at least 1 real prepped song  
**How:** C changes `VITE_API_BASE` to point at the real server; B confirms `/api/score` is live  
**Test:** C uploads a real take and gets a real score back

### 2. C ⇄ A — Real Solana escrow
**When:** A has deployed to devnet + `DevnetEscrowClient` is implemented  
**How:** `VITE_ESCROW_MODE=devnet` + `ESCROW_MODE=devnet`  
**Hard gate:** if A not deployed by Hour 8, lock to mock for the demo — don't block C

### 3. D ⇄ B — Real scoring in finish endpoint
**When:** B's `scorer.py` is tested and passing  
**How:** D imports `score_take` from `scoring/scorer.py` — it's already wired, just remove the stub

### 4. D ⇄ A — Oracle settle on devnet
**When:** A has deployed + oracle keypair is available  
**How:** D loads `oracle-keypair.json` and calls `DevnetEscrowClient.settle()`  
**Env:** `ORACLE_KEYPAIR_PATH=./oracle-keypair.json`, `ESCROW_MODE=devnet`

---

## Integration order

```
1 first (core loop, no chain dependency)
2 next (Solana)
3 + 4 together (both need devnet live)
```

---

## Shared env vars (.env — never commit)

```
# Backend (D)
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=pNInz6obpgDQGcFmaJgB
ESCROW_MODE=mock

# Solana (A → D)
ORACLE_KEYPAIR_PATH=./oracle-keypair.json
PROGRAM_ID=
SOLANA_RPC_URL=https://api.devnet.solana.com

# Frontend (C)
VITE_API_BASE=http://localhost:8000
VITE_ESCROW_MODE=mock
VITE_STAKE_LAMPORTS=10000000
```

---

## To start locally

```bash
# terminal 1 — backend
cd backend && pip install -r requirements.txt
uvicorn main:app --reload --port 8000

# terminal 2 — frontend
cd frontend && npm install
npm run dev
```

Or just: `bash start.sh`

---

## Demo safety net

- `ESCROW_MODE=mock` by default — flip to devnet only if venue WiFi is solid
- Pre-generate ElevenLabs roast for the showcase song and commit it as `backend/assets/mc_fallback.mp3`
- Have pre-recorded WAV fallback takes in case the mic misbehaves
- Test the full loop on the actual demo laptop (not just dev machines)
