import type { Transaction, VersionedTransaction, Keypair, PublicKey } from "@solana/web3.js";

// ─── Wallet signer interface ──────────────────────────────────────────────────
// Compatible with both raw Keypairs (backend/tests) and @solana/wallet-adapter (frontend).

export interface WalletSigner {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
}

/** Wrap a Keypair so it satisfies WalletSigner (for backend / test use). */
export function keypairToSigner(kp: Keypair): WalletSigner {
  return {
    publicKey: kp.publicKey,
    signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
      if ("sign" in tx) (tx as Transaction).sign([kp]);
      return tx;
    },
  };
}

// ─── Shared state types ───���───────────────────────────────────────────────────

export interface MatchState {
  matchId: string;
  stakeLamports: number;
  treasury: string;   // base58
  feeBps: number;
  p1Staked: boolean;
  p2Staked: boolean;
  state: "Open" | "Staked" | "Settled";
  winner: string | null;
}

// ─── EscrowClient interface ───────────────────────────────────────────────────

export interface EscrowClient {
  /**
   * P1 creates the match.
   * - oracle: backend keypair that will call settle (never the frontend)
   * - treasury: developer pubkey that receives fee_bps of the pot
   * - feeBps: e.g. 100 = 1%, 1 = 0.01%
   */
  createMatch(
    matchId: string,
    stakeLamports: number,
    p2: PublicKey,
    oracle: PublicKey,
    treasury: PublicKey,
    feeBps: number,
    p1Signer: WalletSigner
  ): Promise<{ matchId: string }>;

  /** P1 or P2 stakes — accepts a wallet adapter or wrapped keypair. */
  stake(matchId: string, playerSigner: WalletSigner): Promise<string>;

  /** Oracle only — backend. Sends (pot - fee) to winner, fee to treasury. */
  settle(matchId: string, winner: PublicKey, oracleKeypair: Keypair): Promise<string>;

  /** Oracle only — tie. Returns full stakes to both players, no fee. */
  refund(
    matchId: string,
    p1: PublicKey,
    p2: PublicKey,
    oracleKeypair: Keypair
  ): Promise<string>;

  getMatch(matchId: string): Promise<MatchState>;
}

// ─── PDA helpers ─────────────────────────────────────────────────────────────

export function matchPda(matchId: string, programId: PublicKey): PublicKey {
  const { PublicKey } = require("@solana/web3.js");
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("match"), Buffer.from(matchId)],
    programId
  );
  return pda;
}

export function vaultPda(matchId: string, programId: PublicKey): PublicKey {
  const { PublicKey } = require("@solana/web3.js");
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), Buffer.from(matchId)],
    programId
  );
  return pda;
}

export { MockEscrowClient } from "./mock";
export { DevnetEscrowClient } from "./devnet";
