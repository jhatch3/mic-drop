import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { AnchorProvider, Program, Wallet, BN } from "@coral-xyz/anchor";
import type { EscrowClient, MatchState, WalletSigner } from "./index";
import { matchPda, vaultPda, keypairToSigner } from "./index";

// Set after `anchor build && anchor deploy --provider.cluster devnet`
const PROGRAM_ID_STR =
  process.env.PROGRAM_ID ?? "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS";
const RPC_URL =
  process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

export class DevnetEscrowClient implements EscrowClient {
  private program: any;
  private programId: PublicKey;
  private connection: Connection;

  /**
   * Pass an AnchorProvider built with the current user's wallet adapter.
   *
   * Frontend (wallet adapter):
   *   const provider = new AnchorProvider(connection, wallet, {});
   *   const client = new DevnetEscrowClient(provider);
   *
   * Backend / tests (keypair):
   *   const provider = new AnchorProvider(connection, new Wallet(oracleKp), {});
   *   const client = new DevnetEscrowClient(provider);
   */
  constructor(provider: AnchorProvider) {
    this.connection = provider.connection;
    this.programId = new PublicKey(PROGRAM_ID_STR);

    let IDL: any;
    try {
      IDL = require("../../program/target/idl/pitch_battle.json");
    } catch {
      throw new Error("IDL not found — run `anchor build` inside /program first.");
    }
    this.program = new Program(IDL, this.programId, provider);
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
    const mPda = matchPda(matchId, this.programId);
    const vPda = vaultPda(matchId, this.programId);

    const tx: Transaction = await this.program.methods
      .createMatch(matchId, new BN(stakeLamports), p2, oracle, treasury, feeBps)
      .accounts({
        playerOne: p1Signer.publicKey,
        matchAccount: mPda,
        vault: vPda,
        systemProgram: SystemProgram.programId,
      })
      .transaction();

    await this._signAndSend(tx, p1Signer);
    return { matchId };
  }

  async stake(matchId: string, playerSigner: WalletSigner): Promise<string> {
    const mPda = matchPda(matchId, this.programId);
    const vPda = vaultPda(matchId, this.programId);

    const tx: Transaction = await this.program.methods
      .stake(matchId)
      .accounts({
        signer: playerSigner.publicKey,
        matchAccount: mPda,
        vault: vPda,
        systemProgram: SystemProgram.programId,
      })
      .transaction();

    return this._signAndSend(tx, playerSigner);
  }

  async settle(matchId: string, winner: PublicKey, oracleKeypair: Keypair): Promise<string> {
    const mPda = matchPda(matchId, this.programId);
    const vPda = vaultPda(matchId, this.programId);

    // Read the treasury pubkey from on-chain state
    const matchAccount = await this.program.account.match.fetch(mPda);
    const treasury: PublicKey = matchAccount.treasury;

    const tx: Transaction = await this.program.methods
      .settle(matchId, winner)
      .accounts({
        oracle: oracleKeypair.publicKey,
        matchAccount: mPda,
        vault: vPda,
        winnerAccount: winner,
        treasury,
        systemProgram: SystemProgram.programId,
      })
      .transaction();

    return this._signAndSend(tx, keypairToSigner(oracleKeypair));
  }

  async refund(
    matchId: string,
    p1: PublicKey,
    p2: PublicKey,
    oracleKeypair: Keypair
  ): Promise<string> {
    const mPda = matchPda(matchId, this.programId);
    const vPda = vaultPda(matchId, this.programId);

    const tx: Transaction = await this.program.methods
      .refund(matchId)
      .accounts({
        oracle: oracleKeypair.publicKey,
        matchAccount: mPda,
        vault: vPda,
        playerOneAccount: p1,
        playerTwoAccount: p2,
        systemProgram: SystemProgram.programId,
      })
      .transaction();

    return this._signAndSend(tx, keypairToSigner(oracleKeypair));
  }

  async getMatch(matchId: string): Promise<MatchState> {
    const mPda = matchPda(matchId, this.programId);
    const m = await this.program.account.match.fetch(mPda);

    const stateKey = Object.keys(m.state)[0] as "open" | "staked" | "settled";
    const stateMap = { open: "Open", staked: "Staked", settled: "Settled" } as const;

    return {
      matchId: m.matchId,
      stakeLamports: m.stakeLamports.toNumber(),
      treasury: (m.treasury as PublicKey).toBase58(),
      feeBps: m.feeBps,
      p1Staked: m.p1Staked,
      p2Staked: m.p2Staked,
      state: stateMap[stateKey],
      winner: m.winner ? (m.winner as PublicKey).toBase58() : null,
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async _signAndSend(tx: Transaction, signer: WalletSigner): Promise<string> {
    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = signer.publicKey;

    const signed = await signer.signTransaction(tx);
    const sig = await this.connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
    });
    await this.connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed"
    );
    return sig;
  }

  async airdrop(pubkey: PublicKey, sol = 1): Promise<void> {
    const sig = await this.connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
    await this.connection.confirmTransaction(sig, "confirmed");
  }

  async getBalance(pubkey: PublicKey): Promise<number> {
    return this.connection.getBalance(pubkey);
  }
}
