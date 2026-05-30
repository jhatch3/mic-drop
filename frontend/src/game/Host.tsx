import { useState, useEffect, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import QRCode from "react-qr-code";
import { getSocket } from "./socket";
import type { RoomState } from "./types";
import IDL from "../idl/pitch_battle.json";

const PROGRAM_ID = new PublicKey("2eMwChdNVoxeoWjdaiTuBGasDiHCKN3jbw7dL5eSyuZf");
const TREASURY   = new PublicKey("2KnfMtidoDSVYxJDBNEK1e77rVQijvJ71zkBgz6kwejm");
const FEE_BPS    = 100;

// Oracle keypair held in-memory (backed by backend in production)
const oracleKp = Keypair.generate();

function matchPda(matchId: string) {
  return PublicKey.findProgramAddressSync([Buffer.from("match"), Buffer.from(matchId)], PROGRAM_ID)[0];
}
function vaultPda(matchId: string) {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), Buffer.from(matchId)], PROGRAM_ID)[0];
}

type HostPhase = "lobby" | "waiting" | "gaming" | "finished";

export default function Host() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const socket = getSocket();

  const [stakeSOL, setStakeSOL] = useState("0.01");
  const [room, setRoom] = useState<RoomState | null>(null);
  const [phase, setPhase] = useState<HostPhase>("lobby");
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [currentTurn, setCurrentTurn] = useState<{ player: string; wallet: string } | null>(null);

  const addLog = (msg: string) => setLog((p) => [`${new Date().toLocaleTimeString()} — ${msg}`, ...p]);

  useEffect(() => {
    socket.on("room:created", (r: RoomState) => {
      setRoom(r);
      setPhase("waiting");
      addLog(`Room ${r.code} created. Waiting for P2…`);
    });
    socket.on("room:updated", (r: RoomState) => {
      setRoom(r);
      if (r.players.length === 2 && phase === "waiting") {
        addLog(`${r.players[1].wallet.slice(0, 6)}… joined as P2`);
      }
    });
    socket.on("game:started", (r: RoomState) => {
      setRoom(r);
      setPhase("gaming");
      addLog("Game started!");
    });
    socket.on("turn:start", (t: { player: string; wallet: string }) => {
      setCurrentTurn(t);
      addLog(`${t.player}'s turn to sing`);
    });
    socket.on("room:updated", (r: RoomState) => setRoom(r));
    socket.on("game:over", (r: RoomState) => {
      setRoom(r);
      setPhase("finished");
      const winner = r.players.find((p) => p.wallet === r.winner);
      addLog(r.winner ? `${winner?.name ?? "?"} wins!` : "Tie!");
    });
    socket.on("error", ({ msg }: { msg: string }) => addLog(`Error: ${msg}`));

    return () => { socket.removeAllListeners(); };
  }, [socket, phase]);

  const getProgram = useCallback(() => {
    if (!wallet.wallet?.adapter || !wallet.publicKey) throw new Error("Wallet not connected");
    const provider = new AnchorProvider(connection, wallet.wallet.adapter as any, { commitment: "confirmed" });
    return new Program(IDL as any, provider);
  }, [wallet, connection]);

  const createRoom = useCallback(async () => {
    if (!wallet.publicKey) return;
    setBusy(true);
    const stake = Math.floor(parseFloat(stakeSOL) * LAMPORTS_PER_SOL);
    addLog("Creating room…");
    try {
      // Create Solana escrow match (P2 wallet unknown yet — use placeholder, updated on join)
      // For MVP: create the room on the server first, then we'll create the on-chain match
      // when P2 joins so we know their pubkey. For now emit to server.
      socket.emit("room:create", { wallet: wallet.publicKey.toBase58(), stake });
    } catch (e: any) {
      addLog("Error: " + e.message);
    }
    setBusy(false);
  }, [wallet.publicKey, stakeSOL, socket]);

  const startGame = useCallback(async () => {
    if (!room) return;
    setBusy(true);
    addLog("Creating escrow on-chain…");
    try {
      const program = getProgram();
      const matchId = room.code;
      const p2Wallet = new PublicKey(room.players[1].wallet);
      const mPda = matchPda(matchId);
      const vPda = vaultPda(matchId);
      const stake = room.stake;

      // Airdrop oracle for signing
      const sig = await connection.requestAirdrop(oracleKp.publicKey, 0.1 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig);

      await program.methods
        .createMatch(matchId, new BN(stake), p2Wallet, oracleKp.publicKey, TREASURY, FEE_BPS)
        .accounts({ playerOne: wallet.publicKey!, matchAccount: mPda, vault: vPda, systemProgram: SystemProgram.programId })
        .rpc();
      addLog("Escrow created. Staking P1…");

      await program.methods
        .stake(matchId)
        .accounts({ signer: wallet.publicKey!, matchAccount: mPda, vault: vPda, systemProgram: SystemProgram.programId })
        .rpc();
      addLog("P1 staked. Waiting for P2 to stake…");

      socket.emit("match:set_id", { code: room.code, matchId });
      socket.emit("game:start", { code: room.code });
    } catch (e: any) {
      addLog("Error: " + e.message);
    }
    setBusy(false);
  }, [room, getProgram, wallet.publicKey, connection, socket]);

  // Simulate scoring for demo (real: mic recording + /api/score)
  const submitMockScore = useCallback(() => {
    if (!room || !currentTurn || !wallet.publicKey) return;
    const score = Math.floor(60 + Math.random() * 40); // 60-100
    addLog(`${currentTurn.player} score: ${score}/100`);
    socket.emit("score:submit", { code: room.code, wallet: currentTurn.wallet, score });
    setCurrentTurn(null);
  }, [room, currentTurn, wallet.publicKey, socket]);

  // Settle on-chain after game over
  const settle = useCallback(async () => {
    if (!room?.winner || !room.matchId) return;
    setBusy(true);
    addLog("Settling on-chain…");
    try {
      const program = getProgram();
      const mPda = matchPda(room.matchId);
      const vPda = vaultPda(room.matchId);
      await program.methods
        .settle(room.matchId, new PublicKey(room.winner))
        .accounts({
          oracle: oracleKp.publicKey,
          matchAccount: mPda,
          vault: vPda,
          winnerAccount: new PublicKey(room.winner),
          treasury: TREASURY,
          systemProgram: SystemProgram.programId,
        })
        .signers([oracleKp])
        .rpc();
      addLog("Settled! Winner paid.");
    } catch (e: any) {
      addLog("Error: " + e.message);
    }
    setBusy(false);
  }, [room, getProgram]);

  const joinUrl = room
    ? `${window.location.origin}/play?code=${room.code}`
    : null;

  return (
    <div style={styles.root}>
      <div style={styles.inner}>
        {/* Header */}
        <div style={styles.header}>
          <h1 style={styles.title}>🎤 Pitch Battle</h1>
          <WalletMultiButton />
        </div>

        {/* Lobby — create room */}
        {phase === "lobby" && (
          <div style={styles.card}>
            <div style={styles.cardTitle}>Create a Game</div>
            <div style={{ marginTop: 12 }}>
              <label style={styles.label}>Wager (SOL)</label>
              <input
                style={styles.input}
                type="number"
                step="0.01"
                min="0.001"
                value={stakeSOL}
                onChange={(e) => setStakeSOL(e.target.value)}
              />
            </div>
            <Btn onClick={createRoom} busy={busy} disabled={!wallet.publicKey}>
              {wallet.publicKey ? "Create Room" : "Connect Wallet First"}
            </Btn>
          </div>
        )}

        {/* Waiting — show code, wait for P2 */}
        {phase === "waiting" && room && (
          <div style={styles.card}>
            <div style={styles.cardTitle}>Share the Code</div>
            <div style={styles.bigCode}>{room.code}</div>
            {joinUrl && (
              <div style={{ display: "flex", justifyContent: "center", margin: "16px 0", background: "#fff", padding: 16, borderRadius: 12 }}>
                <QRCode value={joinUrl} size={180} />
              </div>
            )}
            <div style={{ color: "#9ca3af", fontSize: 12, textAlign: "center", marginBottom: 16, wordBreak: "break-all" }}>
              {joinUrl}
            </div>
            <div style={styles.label}>Players joined: {room.players.length} / 2</div>
            {room.players.map((p) => (
              <div key={p.wallet} style={styles.playerRow}>
                <span style={{ color: "#4ade80" }}>✓</span> {p.name} — {p.wallet.slice(0, 10)}…
              </div>
            ))}
            {room.players.length === 2 && (
              <Btn onClick={startGame} busy={busy} color="#8b5cf6" style={{ marginTop: 16 }}>
                Start Game & Lock Wagers
              </Btn>
            )}
          </div>
        )}

        {/* Gaming */}
        {phase === "gaming" && room && (
          <div style={styles.card}>
            <div style={styles.cardTitle}>
              {currentTurn ? `${currentTurn.player} is Singing…` : "Get Ready"}
            </div>
            {currentTurn && (
              <>
                <div style={{ color: "#9ca3af", fontSize: 13, margin: "12px 0" }}>
                  {currentTurn.wallet.slice(0, 10)}… — sing your heart out!
                </div>
                <Btn onClick={submitMockScore} busy={false} color="#4ade80">
                  Submit Score (mock)
                </Btn>
              </>
            )}
            <div style={{ marginTop: 20 }}>
              {room.players.map((p) => (
                <div key={p.wallet} style={styles.playerRow}>
                  {p.name}: {p.score !== null ? `${p.score}/100` : "—"}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Finished */}
        {phase === "finished" && room && (
          <div style={styles.card}>
            <div style={styles.cardTitle}>Game Over</div>
            {room.players.map((p) => (
              <div
                key={p.wallet}
                style={{
                  ...styles.playerRow,
                  color: p.wallet === room.winner ? "#4ade80" : "#fff",
                  fontWeight: p.wallet === room.winner ? 700 : 400,
                }}
              >
                {p.wallet === room.winner ? "🏆 " : ""}{p.name}: {p.score}/100
              </div>
            ))}
            {room.winner && (
              <Btn onClick={settle} busy={busy} color="#8b5cf6" style={{ marginTop: 16 }}>
                Pay Winner on Solana
              </Btn>
            )}
          </div>
        )}

        {/* Log */}
        <div style={{ ...styles.card, background: "#0f0f0f", marginTop: 8 }}>
          <div style={styles.label}>Log</div>
          <div style={{ marginTop: 6, maxHeight: 150, overflowY: "auto" }}>
            {log.length === 0 && <div style={{ color: "#555", fontSize: 12 }}>Events will appear here</div>}
            {log.map((l, i) => <div key={i} style={{ fontSize: 12, color: "#9ca3af", marginBottom: 2 }}>{l}</div>)}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles: Record<string, React.CSSProperties> = {
  root: { minHeight: "100vh", background: "#0a0a0a", color: "#fff", fontFamily: "system-ui, sans-serif", padding: 24 },
  inner: { maxWidth: 560, margin: "0 auto" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 32 },
  title: { margin: 0, fontSize: 22, fontWeight: 700 },
  card: { background: "#111", border: "1px solid #222", borderRadius: 12, padding: 20, marginBottom: 12 },
  cardTitle: { fontSize: 16, fontWeight: 600, marginBottom: 8, color: "#e5e7eb" },
  label: { color: "#6b7280", fontSize: 11, textTransform: "uppercase" as const, letterSpacing: 1 },
  bigCode: { fontSize: 64, fontWeight: 900, letterSpacing: 12, textAlign: "center" as const, color: "#facc15", padding: "20px 0" },
  input: { display: "block", width: "100%", background: "#1a1a1a", border: "1px solid #333", borderRadius: 6, padding: "8px 12px", color: "#fff", fontSize: 16, marginTop: 4, marginBottom: 16 },
  playerRow: { padding: "6px 0", borderBottom: "1px solid #1a1a1a", fontSize: 14, fontFamily: "monospace" },
};

function Btn({ onClick, busy, disabled, children, color, style }: {
  onClick: () => void; busy: boolean; disabled?: boolean;
  children: React.ReactNode; color?: string; style?: React.CSSProperties;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy || disabled}
      style={{
        background: busy || disabled ? "#222" : (color ?? "#3b82f6"),
        color: busy || disabled ? "#555" : "#fff",
        border: "none", borderRadius: 8, padding: "10px 20px",
        cursor: busy || disabled ? "not-allowed" : "pointer",
        fontSize: 14, fontWeight: 600, width: "100%",
        ...style,
      }}
    >
      {busy ? "…" : children}
    </button>
  );
}
