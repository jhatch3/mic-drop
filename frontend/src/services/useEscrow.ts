import { useRef } from "react";

export function useEscrow(onLog: (msg: string) => void) {
  const logRef = useRef(onLog);
  logRef.current = onLog;

  const createAndStake = async (_matchId: string, _p2Wallet: string, _stakeLamports: number) => {
    logRef.current("Escrow skipped (mock mode) — wagers not locked on-chain.");
  };

  const settle = async (_matchId: string, _winner: string) => {
    logRef.current("Payout skipped (mock mode) — re-enable chain in useEscrow.ts.");
  };

  return { busy: false, createAndStake, settle };
}
