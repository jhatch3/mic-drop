import { useState, useEffect, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import IDL from "./idl/pitch_battle.json";

// ─── Config ──────────────────────────────────────────────────────────────────
const PROGRAM_ID = new PublicKey("2eMwChdNVoxeoWjdaiTuBGasDiHCKN3jbw7dL5eSyuZf");
const TREASURY   = new PublicKey("2KnfMtidoDSVYxJDBNEK1e77rVQijvJ71zkBgz6kwejm");
const FEE_BPS    = 100;                        // 1% to treasury
const STAKE_LAMP = Math.floor(0.01 * LAMPORTS_PER_SOL); // 0.01 SOL each

// Test keypairs — P2 and oracle. Persisted in localStorage so page reloads reuse
// the SAME keys instead of minting fresh zero-balance ones (which would each need
// a new faucet airdrop and quickly exhaust the devnet rate limit). Fund these
// pubkeys ONCE (web faucet at faucet.solana.com or a transfer from P1) and you're set.
function persistedKeypair(storageKey: string): Keypair {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(saved)));
  } catch { /* fall through and regenerate */ }
  const kp = Keypair.generate();
  localStorage.setItem(storageKey, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}
const p2     = persistedKeypair("pb_p2_keypair");
const oracle = persistedKeypair("pb_oracle_keypair");

function matchPda(matchId: string) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("match"), Buffer.from(matchId)], PROGRAM_ID
  )[0];
}
function vaultPda(matchId: string) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), Buffer.from(matchId)], PROGRAM_ID
  )[0];
}

// ─── Types ───────────────────────────────────────────────────────────────────
type Phase = "idle" | "ready" | "created" | "settled";
interface MatchInfo {
  matchId: string;
  p1Staked: boolean;
  p2Staked: boolean;
  state: string;
  winner: string | null;
}

// ─── App ─────────────────────────────────────────────────────────────────────
export default function App() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [phase, setPhase]       = useState<Phase>("idle");
  const [matchId]               = useState(() => "match-" + Date.now().toString(36));
  const [log, setLog]           = useState<string[]>([]);
  const [match, setMatch]       = useState<MatchInfo | null>(null);
  const [p1Bal, setP1Bal]       = useState<number | null>(null);
  const [p2Bal, setP2Bal]       = useState<number | null>(null);
  const [treasuryBal, setTBal]  = useState<number | null>(null);
  const [busy, setBusy]         = useState(false);

  const addLog = (msg: string) => setLog(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev]);

  // Build program from connected wallet
  const getProgram = useCallback(() => {
    if (!wallet.wallet?.adapter || !wallet.publicKey) throw new Error("Wallet not connected");
    const provider = new AnchorProvider(connection, wallet.wallet.adapter as any, { commitment: "confirmed" });
    return new Program(IDL as any, provider);
  }, [wallet, connection]);

  // Refresh balances
  const refreshBalances = useCallback(async () => {
    const [p1, p2b, tb] = await Promise.all([
      wallet.publicKey ? connection.getBalance(wallet.publicKey) : null,
      connection.getBalance(p2.publicKey),
      connection.getBalance(TREASURY),
    ]);
    if (p1 !== null) setP1Bal(p1 / LAMPORTS_PER_SOL);
    setP2Bal(p2b / LAMPORTS_PER_SOL);
    setTBal(tb / LAMPORTS_PER_SOL);
  }, [wallet.publicKey, connection]);

  // Refresh match state
  const refreshMatch = useCallback(async () => {
    try {
      const program = getProgram();
      const mPda = matchPda(matchId);
      const m = await (program.account as any).match.fetch(mPda);
      const stateKey = Object.keys(m.state)[0];
      setMatch({
        matchId,
        p1Staked: m.p1Staked,
        p2Staked: m.p2Staked,
        state: stateKey.charAt(0).toUpperCase() + stateKey.slice(1),
        winner: m.winner ? (m.winner as PublicKey).toBase58() : null,
      });
    } catch { /* not created yet */ }
  }, [matchId, getProgram]);

  // Airdrop P2 and oracle, then mark ready
  const setup = useCallback(async () => {
    setBusy(true);
    addLog(`P2: ${p2.publicKey.toBase58()}`);
    addLog(`Oracle: ${oracle.publicKey.toBase58()}`);
    try {
      const need = 0.02 * LAMPORTS_PER_SOL; // enough to stake (0.01) + fees
      let allFunded = true;
      for (const [label, kp] of [["P2", p2], ["Oracle", oracle]] as const) {
        const bal = await connection.getBalance(kp.publicKey);
        if (bal >= need) { addLog(`${label} already funded (${bal / LAMPORTS_PER_SOL} SOL) ✓`); continue; }
        addLog(`${label} low — requesting airdrop...`);
        try {
          const sig = await connection.requestAirdrop(kp.publicKey, 1 * LAMPORTS_PER_SOL);
          await connection.confirmTransaction(sig, "confirmed");
          addLog(`${label} airdropped ✓`);
        } catch (e: any) {
          allFunded = false;
          addLog(`${label} airdrop failed (${e.message}). Fund it manually at faucet.solana.com using the pubkey above, then click Setup again.`);
        }
      }
      if (allFunded) {
        addLog("Ready! Connect your Phantom wallet as P1 then create a match.");
        setPhase("ready");
      }
      await refreshBalances();
    } catch (e: any) {
      addLog("Setup failed: " + e.message);
    }
    setBusy(false);
  }, [connection, refreshBalances]);

  // Create match
  const createMatch = useCallback(async () => {
    setBusy(true);
    addLog("Creating match on devnet...");
    try {
      const program = getProgram();
      const mPda = matchPda(matchId);
      const vPda = vaultPda(matchId);
      await program.methods
        .createMatch(matchId, new BN(STAKE_LAMP), p2.publicKey, oracle.publicKey, TREASURY, FEE_BPS)
        .accounts({ playerOne: wallet.publicKey!, matchAccount: mPda, vault: vPda, systemProgram: SystemProgram.programId })
        .rpc();
      addLog(`Match created! ID: ${matchId}`);
      setPhase("created");
      await refreshMatch();
    } catch (e: any) {
      addLog("Error: " + e.message);
    }
    setBusy(false);
  }, [matchId, wallet.publicKey, getProgram, refreshMatch]);

  // Stake P1 (Phantom wallet signs)
  const stakeP1 = useCallback(async () => {
    setBusy(true);
    addLog("P1 staking 0.01 SOL...");
    try {
      const program = getProgram();
      const mPda = matchPda(matchId);
      const vPda = vaultPda(matchId);
      await program.methods
        .stake(matchId)
        .accounts({ signer: wallet.publicKey!, matchAccount: mPda, vault: vPda, systemProgram: SystemProgram.programId })
        .rpc();
      addLog("P1 staked ✓");
      await Promise.all([refreshMatch(), refreshBalances()]);
    } catch (e: any) {
      addLog("Error: " + e.message);
    }
    setBusy(false);
  }, [matchId, wallet.publicKey, getProgram, refreshMatch, refreshBalances]);

  // Stake P2 (test keypair signs locally)
  const stakeP2 = useCallback(async () => {
    setBusy(true);
    addLog("P2 staking 0.01 SOL...");
    try {
      const program = getProgram();
      const mPda = matchPda(matchId);
      const vPda = vaultPda(matchId);
      await program.methods
        .stake(matchId)
        .accounts({ signer: p2.publicKey, matchAccount: mPda, vault: vPda, systemProgram: SystemProgram.programId })
        .signers([p2])
        .rpc();
      addLog("P2 staked ✓");
      await Promise.all([refreshMatch(), refreshBalances()]);
    } catch (e: any) {
      addLog("Error: " + e.message);
    }
    setBusy(false);
  }, [matchId, getProgram, refreshMatch, refreshBalances]);

  // Settle (oracle signs locally)
  const settle = useCallback(async (winner: PublicKey) => {
    setBusy(true);
    const label = winner.toBase58() === wallet.publicKey?.toBase58() ? "P1" : "P2";
    addLog(`Settling — ${label} wins...`);
    try {
      const program = getProgram();
      const mPda = matchPda(matchId);
      const vPda = vaultPda(matchId);
      const m = await (program.account as any).match.fetch(mPda);
      await program.methods
        .settle(matchId, winner)
        .accounts({
          oracle: oracle.publicKey,
          matchAccount: mPda,
          vault: vPda,
          winnerAccount: winner,
          treasury: TREASURY,
          systemProgram: SystemProgram.programId,
        })
        .signers([oracle])
        .rpc();
      addLog(`Settled! ${label} wins. Treasury gets 1% fee.`);
      setPhase("settled");
      await Promise.all([refreshMatch(), refreshBalances()]);
    } catch (e: any) {
      addLog("Error: " + e.message);
    }
    setBusy(false);
  }, [matchId, wallet.publicKey, getProgram, refreshMatch, refreshBalances]);

  useEffect(() => { refreshBalances(); }, [refreshBalances]);

  const bothStaked = match?.p1Staked && match?.p2Staked;

  return (
    <div style={{ minHeight: "100vh", background: "#0a0a0a", color: "#fff", fontFamily: "monospace", padding: 24 }}>
      <div style={{ maxWidth: 600, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 32 }}>
          <h1 style={{ margin: 0, fontSize: 20 }}>🎤 Pitch Battle — Solana Test UI</h1>
          <WalletMultiButton />
        </div>

        {/* Config */}
        <div style={card}>
          <div style={label}>Program</div>
          <div style={mono}>{PROGRAM_ID.toBase58()}</div>
          <div style={{ ...label, marginTop: 8 }}>Treasury (dev fee)</div>
          <div style={mono}>{TREASURY.toBase58()}</div>
          <div style={{ display: "flex", gap: 24, marginTop: 8 }}>
            <div><span style={label}>Fee </span><span style={mono}>{FEE_BPS / 100}%</span></div>
            <div><span style={label}>Stake </span><span style={mono}>0.01 SOL each</span></div>
          </div>
        </div>

        {/* Balances */}
        <div style={card}>
          <div style={label}>Balances</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 8 }}>
            {[
              ["P1 (you)", p1Bal],
              ["P2 (test kp)", p2Bal],
              ["Treasury", treasuryBal],
            ].map(([n, v]) => (
              <div key={n as string} style={{ background: "#1a1a1a", padding: "8px 12px", borderRadius: 6 }}>
                <div style={{ ...label, fontSize: 10 }}>{n}</div>
                <div style={{ ...mono, fontSize: 14, color: "#4ade80" }}>
                  {v !== null ? `${(v as number).toFixed(4)} SOL` : "—"}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div style={card}>
          <div style={label}>Actions</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
            {phase === "idle" && (
              <Btn onClick={setup} busy={busy}>1. Setup (airdrop P2 + oracle)</Btn>
            )}
            {phase === "ready" && (
              <Btn onClick={createMatch} busy={busy} disabled={!wallet.publicKey}>
                {wallet.publicKey ? "2. Create Match" : "Connect wallet first"}
              </Btn>
            )}
            {phase === "created" && !match?.p1Staked && (
              <Btn onClick={stakeP1} busy={busy}>Stake P1 (your wallet)</Btn>
            )}
            {phase === "created" && !match?.p2Staked && (
              <Btn onClick={stakeP2} busy={busy}>Stake P2 (test keypair)</Btn>
            )}
            {phase === "created" && bothStaked && (
              <>
                <Btn onClick={() => settle(wallet.publicKey!)} busy={busy} color="#4ade80">
                  P1 Wins
                </Btn>
                <Btn onClick={() => settle(p2.publicKey)} busy={busy} color="#fb923c">
                  P2 Wins
                </Btn>
              </>
            )}
            {phase !== "idle" && (
              <Btn onClick={refreshBalances} busy={false} color="#6b7280">Refresh</Btn>
            )}
          </div>
        </div>

        {/* Match state */}
        {match && (
          <div style={card}>
            <div style={label}>Match State</div>
            <div style={{ marginTop: 8 }}>
              <Row label="Match ID" value={match.matchId} />
              <Row label="State" value={match.state} color={match.state === "Settled" ? "#4ade80" : "#facc15"} />
              <Row label="P1 Staked" value={match.p1Staked ? "✓" : "✗"} />
              <Row label="P2 Staked" value={match.p2Staked ? "✓" : "✗"} />
              {match.winner && <Row label="Winner" value={match.winner.slice(0, 16) + "..."} color="#4ade80" />}
            </div>
          </div>
        )}

        {/* Log */}
        <div style={{ ...card, background: "#0f0f0f" }}>
          <div style={label}>Log</div>
          <div style={{ marginTop: 8, maxHeight: 200, overflowY: "auto" }}>
            {log.length === 0 && <div style={{ color: "#555", fontSize: 12 }}>Click "Setup" to begin</div>}
            {log.map((l, i) => (
              <div key={i} style={{ fontSize: 12, color: "#9ca3af", marginBottom: 2 }}>{l}</div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const card: React.CSSProperties = { background: "#111", border: "1px solid #222", borderRadius: 8, padding: 16, marginBottom: 12 };
const label: React.CSSProperties = { color: "#6b7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1 };
const mono: React.CSSProperties = { fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" };

function Row({ label: l, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid #1a1a1a", fontSize: 13 }}>
      <span style={{ color: "#9ca3af" }}>{l}</span>
      <span style={{ color: color ?? "#fff", fontFamily: "monospace" }}>{value}</span>
    </div>
  );
}

function Btn({ onClick, busy, disabled, children, color }: {
  onClick: () => void; busy: boolean; disabled?: boolean;
  children: React.ReactNode; color?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy || disabled}
      style={{
        background: busy || disabled ? "#222" : (color ?? "#3b82f6"),
        color: busy || disabled ? "#555" : "#fff",
        border: "none", borderRadius: 6, padding: "8px 16px",
        cursor: busy || disabled ? "not-allowed" : "pointer",
        fontSize: 13, fontFamily: "monospace",
      }}
    >
      {busy ? "..." : children}
    </button>
  );
}
