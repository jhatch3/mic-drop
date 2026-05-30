# Stream A — Solana Escrow

**You own:** `program/`, `client-solana/`

---

## Your files
```
program/
  Anchor.toml
  Cargo.toml
  programs/pitch-battle/src/lib.rs
  tests/pitch-battle.ts
client-solana/src/
  index.ts    ← EscrowClient interface
  mock.ts     ← MockEscrowClient
  devnet.ts   ← DevnetEscrowClient
```

---

## Step 1 — Ship first (unblocks everyone)
Fill out `client-solana/src/mock.ts` — `MockEscrowClient` that tracks balances in memory.
`createMatch / stake / settle / refund` all resolve instantly, no network.

This is what C and D will use on day 0.

## Step 2 — Anchor program (`lib.rs`)
Four instructions:

| Instruction | Signer | What it does |
|---|---|---|
| `create_match(match_id, stake_lamports, player_two, oracle)` | player_one | Init Match + Vault PDAs |
| `stake()` | player_one or player_two | Transfer stake_lamports → Vault; both staked → state Staked |
| `settle(winner)` | oracle only | Transfer 2×stake from Vault → winner; state Settled |
| `refund()` | oracle only | Return each stake to each player; state Settled |

**PDAs:**
- Match: seeds `[b"match", match_id]`
- Vault: seeds `[b"vault", match_id]` — holds the lamports

## Step 3 — Deploy to devnet
```bash
anchor build && anchor deploy --provider.cluster devnet
```
Hard gate: **if not deployed by Hour 8, lock ESCROW_MODE=mock and don't block the team.**

## Step 4 — Wire `devnet.ts`
Fill in `DevnetEscrowClient` using `@coral-xyz/anchor` + the deployed program IDL.
Settle/refund are oracle-only — the backend calls these, never the frontend.

## Done-when
```
anchor test passes:
  ✓ create → both stake → vault holds 2×stake
  ✓ oracle settle → winner balance += 2×stake
  ✓ non-oracle settle → rejected
```

## Env vars you provide to the team
```
ORACLE_KEYPAIR_PATH=./oracle-keypair.json   # backend uses this to call settle
PROGRAM_ID=<your deployed program ID>
SOLANA_RPC_URL=https://api.devnet.solana.com
```

## Integration points
- **→ C**: they import `MockEscrowClient` from `client-solana/src/mock.ts`
- **→ D (backend)**: they import `DevnetEscrowClient` and hold the oracle keypair to call `settle()`
- Flip happens via `ESCROW_MODE=mock|devnet` env var — no code changes needed
