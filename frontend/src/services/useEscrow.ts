import { useState, useCallback, useRef } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { getSocket } from "../game/socket";
import IDL from "../idl/pitch_battle.json";

const PROGRAM_ID = new PublicKey("2eMwChdNVoxeoWjdaiTuBGasDiHCKN3jbw7dL5eSyuZf");
const TREASURY   = new PublicKey("2KnfMtidoDSVYxJDBNEK1e77rVQijvJ71zkBgz6kwejm");
const FEE_BPS    = 100;
const API_BASE   = import.meta.env.VITE_API_BASE ?? "";
// Fallback oracle pubkey — derived from oracle-keypair.json on the backend.
// The real value is served at /api/oracle/pubkey; this is only used if the
// backend is unreachable at match-creation time.
const DEFAULT_ORACLE = "J2V5eo21gxcuP8Nw1v5LcGcqXj9eZMQoLz73Q63HXJa";

function matchPda(id: string) {
  return PublicKey.findProgramAddressSync([Buffer.from("match"), Buffer.from(id)], PROGRAM_ID)[0];
}
function vaultPda(id: string) {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), Buffer.from(id)], PROGRAM_ID)[0];
}

export function useEscrow(onLog: (msg: string) => void) {
  const wallet = useWallet();
  const { connection } = useConnection();
  const [busy, setBusy] = useState(false);
  const logRef = useRef(onLog);
  logRef.current = onLog;
  const socket = getSocket();

  // Create the on-chain match and stake P1.  P2 stakes separately from their
  // phone via Player.tsx (stakeOnChain) after seeing room.matchId appear.
  // If p2Wallet is a guest ID (not a valid pubkey) we skip chain silently —
  // that means P2 joined without a wallet and wagers aren't locked on-chain.
  const createAndStake = useCallback(async (
    matchId: string,
    p2Wallet: string,
    stakeLamports: number,
  ) => {
    if (!wallet.publicKey || !wallet.wallet?.adapter) {
      throw new Error("Wallet not connected");
    }

    // Guest wallets ("guest-xxxx") are not valid Solana pubkeys — skip chain.
    let p2Pk: PublicKey;
    try {
      p2Pk = new PublicKey(p2Wallet);
    } catch {
      logRef.current("P2 is a guest (no wallet) — skipping on-chain escrow.");
      return;
    }

    setBusy(true);
    try {
      // 1) Resolve oracle pubkey — backend is authoritative, hardcoded is fallback.
      let oraclePubkeyStr = DEFAULT_ORACLE;
      try {
        const r = await fetch(`${API_BASE}/api/oracle/pubkey`);
        if (r.ok) {
          const data = await r.json();
          oraclePubkeyStr = data.oracle_pubkey ?? DEFAULT_ORACLE;
        }
      } catch { /* backend unreachable — use fallback */ }
      const oraclePk = new PublicKey(oraclePubkeyStr);

      const provider = new AnchorProvider(
        connection,
        wallet.wallet.adapter as any,
        { commitment: "confirmed" },
      );
      const program = new Program(IDL as any, provider);
      const mPda = matchPda(matchId);
      const vPda = vaultPda(matchId);

      // 2) Create the escrow match — idempotent so a page-reload retry is safe.
      let matchExists = false;
      try {
        await (program.account as any).match.fetch(mPda);
        matchExists = true;
        logRef.current("Match PDA already on-chain — skipping createMatch.");
      } catch { /* not found, will create */ }

      if (!matchExists) {
        logRef.current("Creating match on-chain… (approve in Phantom)");
        const sig = await program.methods
          .createMatch(matchId, new BN(stakeLamports), p2Pk, oraclePk, TREASURY, FEE_BPS)
          .accounts({
            playerOne: wallet.publicKey,
            matchAccount: mPda,
            vault: vPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        logRef.current(`Match created ✓ (${sig.slice(0, 12)}…)`);
      }

      // 3) Stake P1 (Phantom wallet signs).
      logRef.current("Staking P1… (approve in Phantom)");
      const stakeSig = await program.methods
        .stake(matchId)
        .accounts({
          signer: wallet.publicKey,
          matchAccount: mPda,
          vault: vPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      logRef.current(`P1 staked ✓ (${stakeSig.slice(0, 12)}…)`);

      // 4) Notify server so P2's phone sees the stake button appear.
      socket.emit("player:staked", {
        code: matchId,
        wallet: wallet.publicKey.toBase58(),
      });
    } finally {
      setBusy(false);
    }
  }, [wallet, connection, socket]);

  // Settlement is done by the backend oracle signing settle() after scoring.
  // The frontend never calls settle() — it just receives the payout_tx in
  // the /api/match/finish response.
  const settle = useCallback(async (_matchId: string, _winner: string) => {
    logRef.current("Settlement handled by backend oracle — no frontend action needed.");
  }, []);

  return { busy, createAndStake, settle };
}
