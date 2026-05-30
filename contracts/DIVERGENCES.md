# Contract divergences from the MVP spec

Things the team decided to do differently from `docs /pitch-battle-mvp-spec (1).md`.
Source of truth for anyone integrating against these surfaces.

## 1. Session server — Socket.io rooms instead of FastAPI WS (spec 3.8)

**Spec 3.8 said:** Python FastAPI under `backend/session/` exposing
`POST /api/session/{create,join}` + WS `/ws/session/<id>` broadcasting
`SessionState`, with phones doing sign-in-with-Solana on a server nonce.

**What we shipped:** Node.js + Express + Socket.io under `server/`, with
6-character room codes (Kahoot-style). Already deployed on Render/Railway.

**Why kept:** it works, it's deployed, and replacing it for spec parity is pure
churn this close to demo.

**What this means for integrators:**
- The laptop (Host) and phones (Player) talk to `server/` over Socket.io, not
  to FastAPI WS.
- Events: `room:create`, `room:join`, `match:set_id`, `game:start`,
  `score:submit`, `turn:start`, `room:updated`, `game:over`.
  See `server/src/index.js` and `server/src/rooms.js` for the exact shapes.
- **No SIWS nonce auth.** Phones submit a wallet pubkey but do not sign a
  challenge. The pubkey is trusted for identity + payout destination, not for
  authorization. Acceptable for MVP/demo; not acceptable beyond that.
- The `SessionState`/`PhoneMsg`/`LaptopMsg` types in spec 3.8 are **not used**.
  Frontend uses the types in `frontend/src/game/types.ts` instead.

## 2. Scoring — pitch + lyrics, not pitch only

**Spec said:** authoritative score is pitch accuracy (`librosa.pyin` + octave-folded
cents error, hit ≤ 50 cents). See `backend/scoring/scorer.py`.

**What we shipped:** the pitch score is still authoritative for settlement,
but we also surface a **lyrics score** as a bonus second metric on the result
screen, computed from STT transcript + reference lyrics with `rapidfuzz`.
See `backend/transcription/` and `backend/reference/`.

**What this means for integrators:**
- `Score` (spec 3.4) is unchanged — that is the pitch score and the only
  number the escrow settles on. **Never trust lyrics for money.**
- `FinishResponse` may grow an optional `lyrics_scores: LyricsScore[]` field
  later; until then, `/api/transcribe` is a standalone endpoint the frontend
  can call separately if it wants the bonus metric.
- STT on singing is unreliable (sustained vowels, melisma, backing bleed).
  Treat the lyrics score as flavor, not truth — see `docs /speech-agent.md`.

## 3. Escrow — extra `treasury` + `feeBps` fields

**Spec said:** `EscrowClient.createMatch(stakeLamports, p2)` and `settle()`
pays the full `2 * stake_lamports` to the winner.

**What we shipped:** the Anchor program takes `treasury: Pubkey` and
`fee_bps: u16` on `create_match`, and `settle` splits the pot — fee to
treasury, remainder to winner. `refund` is unchanged (no fee on tie).

**What this means for integrators:**
- The `EscrowClient` interface in `client-solana/src/index.ts` has extra
  required params: `treasury`, `feeBps`. Backend D must pass these when
  composing matches.
- Frontend currently hardcodes `TREASURY` + `FEE_BPS = 100` (1%) in
  `frontend/src/App.tsx`. Move to env var if/when this needs to be configurable.
