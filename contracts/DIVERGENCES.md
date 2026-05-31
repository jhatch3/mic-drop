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

## 3a. Settle is signed by the backend oracle, not the laptop

**Spec said:** `settle` / `refund` are oracle-only; the oracle is the backend.

**What changed (May 2026 integration pass):** the laptop no longer holds the
oracle keypair. The backend loads it from `ORACLE_KEYPAIR_PATH`, exposes the
pubkey at `GET /api/oracle/pubkey`, and signs `settle`/`refund` from Python
(`backend/chain/escrow.py` — manual Anchor discriminator + Borsh, via
`solders` + `solana-py`). Laptop fetches the pubkey on mount and passes it
into `create_match(..., oracle, ...)` so `has_one = oracle` lines up.

The previous Host.tsx generated a fresh oracle in the browser on every page
load and signed settle from there — that violated CLAUDE.md invariant #6 and
broke on page reloads.

## 3b. Match history — Snowflake `matches` + `leaderboard` view

`POST /api/match/finish` now writes a row to `MICDROP.PUBLIC.matches` per
finished game (best-effort — Snowflake failure does not block the result
screen). A `leaderboard` view aggregates wins/losses/avg_score by pubkey;
`GET /api/leaderboard` returns the top N. Schema in
`backend/data/schema/matches.sql`.

## 3c. P2 staking — laptop holds a pre-funded demo keypair (MVP)

**Spec / invariant #7 said:** pay the winner's authenticated phone pubkey; both
players stake their own SOL.

**What we shipped (integration loop):** the program's `stake` only accepts a
signer equal to the on-chain `player_one`/`player_two` (`lib.rs:42-47`), so a
random laptop key cannot stake "for" the phone. To keep phones audio-free and
sign-free for the demo, the laptop holds a **pre-funded demo P2 keypair**
(`frontend/src/game/Host.tsx`, localStorage key `pb_p2_keypair` — the same key
the `/` test UI funds) and:
- records it as the on-chain `player_two` in `create_match`,
- signs P2's `stake` from the laptop after P1 stakes (so the match reaches
  `Staked` and the backend oracle's `settle`/`refund` actually fire),
- sends it as `p2_pubkey` to `POST /api/match/finish`, so the on-chain payout
  destination, the `settle` winner, and the Snowflake `matches.p2_pubkey` all
  agree.

**Consequence:** a P2 win pays the **demo keypair**, not the phone's wallet, and
the leaderboard credits the demo pubkey for P2 results. This relaxes invariant
#7 for the demo. The phone wallet remains identity/display only (room join,
"you won/lost"). To restore true PvP later, have `Player.tsx` sign its own
`stake` with the phone wallet and drop the demo key.

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
