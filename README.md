# 🎤 Pitch Battle

> **PvP karaoke on Solana.** Two players stake SOL, sing against each other, and the better pitch wins the pot — settled on-chain by a smart contract, roasted by an AI host.

Built for **Quack Hacks 3** · Tracks: Solana · Snowflake · Google Gemini · ElevenLabs

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Solana Devnet](https://img.shields.io/badge/Solana-Devnet-9945FF?logo=solana)](https://explorer.solana.com/address/2eMwChdNVoxeoWjdaiTuBGasDiHCKN3jbw7dL5eSyuZf?cluster=devnet)
[![Live Demo](https://img.shields.io/badge/Demo-micdrop--five.vercel.app-black?logo=vercel)](https://micdrop-five.vercel.app/host)

---

## How It Works

1. **Host** opens the game on a laptop, connects a Phantom wallet, and sets a SOL wager
2. A **6-character room code** and QR code appear on screen
3. **Two players** scan the QR on their phones, connect their wallets, and join
4. Both players stake SOL into an on-chain escrow — no trust required
5. Players take turns singing into the laptop mic; pitch accuracy is scored in real time
6. The **smart contract** pays the winner automatically. The loser gets roasted by an AI MC powered by Gemini + ElevenLabs

---

## Tech Stack

| Layer | Tech |
|---|---|
| Blockchain | Solana devnet · Anchor (Rust) escrow program |
| Frontend | React + Vite (TypeScript) · Web Audio API |
| Wallet | `@solana/wallet-adapter` · Phantom |
| Session | Node.js · Express · Socket.io |
| AI Host | Google Gemini (roast commentary) · ElevenLabs (TTS) |
| Data | Snowflake (match history · leaderboard) |
| Deploy | Vercel (frontend) · Render (session server) |

---

## Smart Contract

Program deployed on **Solana Devnet**:
```
2eMwChdNVoxeoWjdaiTuBGasDiHCKN3jbw7dL5eSyuZf
```
[View on Solana Explorer →](https://explorer.solana.com/address/2eMwChdNVoxeoWjdaiTuBGasDiHCKN3jbw7dL5eSyuZf?cluster=devnet)

The escrow program handles:
- `create_match` — P1 initialises the match with stake amount, P2 pubkey, and oracle
- `stake` — both players deposit SOL into a PDA vault
- `settle` — oracle-only; pays winner `pot - fee`, sends 1% to the developer treasury
- `refund` — oracle-only; returns full stakes on a tie

Scoring is computed server-side from the recorded audio and submitted by a trusted oracle keypair — the laptop never settles money directly.

---

## Repo Structure

```
/contracts          # Shared TypeScript types + JSON Schema (source of truth)
/program            # Anchor escrow program (Rust)
/client-solana      # EscrowClient — mock + devnet implementations
/server             # Session server — Express + Socket.io room management
/frontend           # React app — /host (laptop) · /play (phone controller)
/backend            # FastAPI — pitch scoring · Gemini commentary · ElevenLabs · Snowflake
/assets/songs       # Prepped song assets (instrumental · pitch contour · metadata)
/tasks              # Per-stream task files for parallel development
```

---

## Running Locally

### Prerequisites
- Node.js 18+
- Python 3.11+ (backend)
- [Anchor CLI 0.31](https://www.anchor-lang.com/) (smart contract)
- [Phantom wallet](https://phantom.app/) browser extension (set to devnet)

### Session Server
```bash
cd server
npm install
npm run dev        # starts on :3001
```

### Frontend
```bash
cd frontend
npm install
cp .env.example .env.local   # set VITE_SERVER_URL=http://localhost:3001
npm run dev        # starts on :5173
```

Then open:
- `http://localhost:5173/host` — laptop host view
- `http://localhost:5173/play` — phone player view

### Smart Contract (optional — already deployed)
```bash
cd program
anchor build
anchor test        # requires Solana CLI + local validator
anchor deploy --provider.cluster devnet
```

---

## Live Demo

| URL | Purpose |
|---|---|
| [micdrop-five.vercel.app/host](https://micdrop-five.vercel.app/host) | Host a game (laptop) |
| [micdrop-five.vercel.app/play](https://micdrop-five.vercel.app/play) | Join a game (phone) |

---

## Team

Built in 24 hours at **Quack Hacks 3**.

---

## License

MIT — see [LICENSE](LICENSE)
