import type { Keypair, PublicKey } from "@solana/web3.js";

export interface MatchState {
  matchId: string;
  stakeLamports: number;
  p1Staked: boolean;
  p2Staked: boolean;
  state: "Open" | "Staked" | "Settled";
  winner: string | null; // base58 pubkey
}

export interface EscrowClient {
  /** P1 creates the match. oracle is the backend's pubkey that will call settle. */
  createMatch(
    matchId: string,
    stakeLamports: number,
    p2: PublicKey,
    oracle: PublicKey,
    p1Keypair: Keypair
  ): Promise<{ matchId: string }>;

  /** Signer must be p1 or p2 on the match. */
  stake(matchId: string, player: Keypair): Promise<string>;

  /** Oracle only — backend keypair. Pays winner the full vault (2 × stake). */
  settle(matchId: string, winner: PublicKey, oracleKeypair: Keypair): Promise<string>;

  /** Oracle only — tie case. Returns each player's stake. */
  refund(
    matchId: string,
    p1: PublicKey,
    p2: PublicKey,
    oracleKeypair: Keypair
  ): Promise<string>;

  getMatch(matchId: string): Promise<MatchState>;
}

export { MockEscrowClient } from "./mock";
export { DevnetEscrowClient } from "./devnet";

/** Derive the Match PDA for a given matchId and programId. */
export function matchPda(matchId: string, programId: PublicKey): PublicKey {
  const { PublicKey } = require("@solana/web3.js");
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("match"), Buffer.from(matchId)],
    programId
  );
  return pda;
}

/** Derive the Vault PDA for a given matchId and programId. */
export function vaultPda(matchId: string, programId: PublicKey): PublicKey {
  const { PublicKey } = require("@solana/web3.js");
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), Buffer.from(matchId)],
    programId
  );
  return pda;
}
