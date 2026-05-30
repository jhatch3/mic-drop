import type { Keypair, PublicKey } from "@solana/web3.js";
import type { EscrowClient, MatchState, WalletSigner } from "./index";

interface InternalMatch {
  matchId: string;
  stakeLamports: number;
  p1: string;
  p2: string;
  oracle: string;
  treasury: string;
  feeBps: number;
  p1Staked: boolean;
  p2Staked: boolean;
  vaultBalance: number;
  state: "Open" | "Staked" | "Settled";
  winner: string | null;
}

const DEFAULT_BALANCE = 10 * 1_000_000_000; // 10 SOL in lamports

export class MockEscrowClient implements EscrowClient {
  private matches = new Map<string, InternalMatch>();
  private balances = new Map<string, number>();

  getBalance(pubkey: string): number {
    return this.balances.get(pubkey) ?? DEFAULT_BALANCE;
  }

  private uid(): string {
    return Math.random().toString(36).slice(2, 10);
  }

  async createMatch(
    matchId: string,
    stakeLamports: number,
    p2: PublicKey,
    oracle: PublicKey,
    treasury: PublicKey,
    feeBps: number,
    p1Signer: WalletSigner
  ): Promise<{ matchId: string }> {
    if (this.matches.has(matchId)) throw new Error(`Match ${matchId} already exists`);
    if (feeBps > 1000) throw new Error("feeBps cannot exceed 1000 (10%)");
    this.matches.set(matchId, {
      matchId, stakeLamports,
      p1: p1Signer.publicKey.toBase58(),
      p2: p2.toBase58(),
      oracle: oracle.toBase58(),
      treasury: treasury.toBase58(),
      feeBps,
      p1Staked: false, p2Staked: false,
      vaultBalance: 0,
      state: "Open",
      winner: null,
    });
    return { matchId };
  }

  async stake(matchId: string, playerSigner: WalletSigner): Promise<string> {
    const m = this.matches.get(matchId);
    if (!m) throw new Error(`Match ${matchId} not found`);
    if (m.state === "Settled") throw new Error("Match already settled");

    const pub = playerSigner.publicKey.toBase58();
    const isP1 = pub === m.p1;
    const isP2 = pub === m.p2;
    if (!isP1 && !isP2) throw new Error("Signer is not a player in this match");
    if (isP1 && m.p1Staked) throw new Error("P1 has already staked");
    if (isP2 && m.p2Staked) throw new Error("P2 has already staked");

    const balance = this.getBalance(pub);
    if (balance < m.stakeLamports) throw new Error("Insufficient balance");
    this.balances.set(pub, balance - m.stakeLamports);
    m.vaultBalance += m.stakeLamports;

    if (isP1) m.p1Staked = true;
    if (isP2) m.p2Staked = true;
    if (m.p1Staked && m.p2Staked) m.state = "Staked";

    return `mock-stake-${this.uid()}`;
  }

  async settle(matchId: string, winner: PublicKey, oracleKeypair: Keypair): Promise<string> {
    const m = this.matches.get(matchId);
    if (!m) throw new Error(`Match ${matchId} not found`);
    if (oracleKeypair.publicKey.toBase58() !== m.oracle) throw new Error("Not the oracle");
    if (m.state !== "Staked") throw new Error("Match is not in Staked state");

    const winnerKey = winner.toBase58();
    if (winnerKey !== m.p1 && winnerKey !== m.p2) throw new Error("Invalid winner");

    const fee = Math.floor((m.vaultBalance * m.feeBps) / 10_000);
    const winnerAmount = m.vaultBalance - fee;

    this.balances.set(winnerKey, this.getBalance(winnerKey) + winnerAmount);
    this.balances.set(m.treasury, this.getBalance(m.treasury) + fee);

    m.vaultBalance = 0;
    m.winner = winnerKey;
    m.state = "Settled";

    return `mock-settle-${this.uid()}`;
  }

  async refund(matchId: string, p1: PublicKey, p2: PublicKey, oracleKeypair: Keypair): Promise<string> {
    const m = this.matches.get(matchId);
    if (!m) throw new Error(`Match ${matchId} not found`);
    if (oracleKeypair.publicKey.toBase58() !== m.oracle) throw new Error("Not the oracle");
    if (m.state !== "Staked") throw new Error("Match is not in Staked state");

    // No fee on ties — full stakes returned
    this.balances.set(p1.toBase58(), this.getBalance(p1.toBase58()) + m.stakeLamports);
    this.balances.set(p2.toBase58(), this.getBalance(p2.toBase58()) + m.stakeLamports);
    m.vaultBalance = 0;
    m.state = "Settled";

    return `mock-refund-${this.uid()}`;
  }

  async getMatch(matchId: string): Promise<MatchState> {
    const m = this.matches.get(matchId);
    if (!m) throw new Error(`Match ${matchId} not found`);
    return {
      matchId: m.matchId,
      stakeLamports: m.stakeLamports,
      treasury: m.treasury,
      feeBps: m.feeBps,
      p1Staked: m.p1Staked,
      p2Staked: m.p2Staked,
      state: m.state,
      winner: m.winner,
    };
  }
}
