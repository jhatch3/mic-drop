import { useState, useEffect, useCallback, useMemo } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { getSocket } from "./socket";
import type { RoomState } from "./types";
import Karaoke, { DEFAULT_SONG, type KaraokeResult } from "./Karaoke";
import IDL from "../idl/pitch_battle.json";

const PROGRAM_ID = new PublicKey("2eMwChdNVoxeoWjdaiTuBGasDiHCKN3jbw7dL5eSyuZf");

function matchPda(id: string) {
  return PublicKey.findProgramAddressSync([Buffer.from("match"), Buffer.from(id)], PROGRAM_ID)[0];
}
function vaultPda(id: string) {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), Buffer.from(id)], PROGRAM_ID)[0];
}

interface FinishPayload {
  room: RoomState;
  winner: "p1" | "p2" | "tie";
  payout_tx: string;
  mc_audio_url: string;
  commentary: string;
}

export default function Player() {
  const wallet = useWallet();
  const { connection } = useConnection();
  const socket = getSocket();

  // Generate a stable guest ID for this session (no wallet needed)
  const guestId = useMemo(() => "guest-" + Math.random().toString(36).slice(2, 10), []);

  // Pre-fill code from URL ?code=PITCH1
  const urlCode = new URLSearchParams(window.location.search).get("code") ?? "";
  const [code, setCode] = useState(urlCode.toUpperCase());
  const [room, setRoom] = useState<RoomState | null>(null);
  const [joined, setJoined] = useState(false);
  const [myTurn, setMyTurn] = useState(false);
  const [turnDone, setTurnDone] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [finish, setFinish] = useState<FinishPayload | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [staking, setStaking] = useState(false);
  const [staked, setStaked] = useState(false);

  const addLog = (msg: string) => setLog((p) => [`${new Date().toLocaleTimeString()} — ${msg}`, ...p]);

  useEffect(() => {
    socket.on("room:updated", (r: RoomState) => {
      setRoom(r);
    });
    socket.on("game:started", (r: RoomState) => {
      setRoom(r);
      addLog("Game started! Get ready.");
    });
    socket.on("turn:start", (t: { player: string; wallet: string }) => {
      if (t.wallet === guestId) {
        setMyTurn(true);
        addLog("It's YOUR turn!");
        setTurnDone(false);
        addLog("It's YOUR turn — sing!");
      } else {
        setMyTurn(false);
        addLog(`${t.player} is up…`);
      }
    });
    socket.on("game:over", (r: RoomState) => {
      // Authoritative result still incoming via match:finished — show scoring banner.
      setRoom(r);
      setGameOver(true);
      setMyTurn(false);
      addLog("Both takes recorded. Scoring on backend…");
    });
    socket.on("match:finished", (p: FinishPayload) => {
      setFinish(p);
      setRoom(p.room);
      setGameOver(true);
      setMyTurn(false);
      const youWon = p.room.winner && p.room.winner === wallet.publicKey?.toBase58();
      addLog(p.winner === "tie" ? "Tie! Stakes refunded." : youWon ? "You won!" : "You lost.");
    });
    socket.on("error", ({ msg }: { msg: string }) => {
      setError(msg);
      addLog("Error: " + msg);
    });

    return () => { socket.removeAllListeners(); };
  }, [socket, guestId]);

  const stakeOnChain = useCallback(async () => {
    if (!wallet.publicKey || !wallet.wallet?.adapter || !room?.matchId) return;
    setStaking(true);
    addLog("Staking on-chain — approve in Phantom…");
    try {
      const provider = new AnchorProvider(connection, wallet.wallet.adapter as any, { commitment: "confirmed" });
      const program = new Program(IDL as any, provider);
      const mPda = matchPda(room.matchId);
      const vPda = vaultPda(room.matchId);
      const sig = await program.methods
        .stake(room.matchId)
        .accounts({ signer: wallet.publicKey, matchAccount: mPda, vault: vPda, systemProgram: SystemProgram.programId })
        .rpc();
      addLog(`Staked ✓ (${sig.slice(0, 12)}…)`);
      setStaked(true);
      socket.emit("player:staked", { code: room.code, wallet: wallet.publicKey.toBase58() });
    } catch (e: any) {
      addLog("Stake failed: " + e.message);
      setError(e.message);
    }
    setStaking(false);
  }, [wallet, connection, room, socket]);

  const joinRoom = () => {
    if (!code) return;
    setError("");
    socket.emit("room:join", { code: code.toUpperCase(), wallet: guestId });
    setJoined(true);
    addLog(`Joining room ${code}…`);
  };

  const myInfo = room?.players.find((p) => p.wallet === guestId);
  const opponentInfo = room?.players.find((p) => p.wallet !== guestId);
  // This device owns the mic for ITS player's turn (per the device model, the
  // singer's own screen runs the karaoke + client-side pitch graph). When done we
  // send only the final score over the socket — no audio ever leaves this device.
  const finishTurn = useCallback((result: KaraokeResult) => {
    if (!room || !wallet.publicKey) return;
    socket.emit("score:submit", { code: room.code, wallet: wallet.publicKey.toBase58(), score: result.score });
    setMyTurn(false);
    setTurnDone(true);
    addLog(`You scored ${result.score}/100 — waiting for the result…`);
  }, [room, wallet.publicKey, socket]);

  // It's this player's turn to sing → take over the whole screen with the karaoke
  // station. Highest pitch accuracy wins; the laptop settles the wager on-chain.
  if (
    joined && room && !gameOver && myTurn && !turnDone &&
    (room.state === "p1_singing" || room.state === "p2_singing")
  ) {
    return <Karaoke song={DEFAULT_SONG} playerLabel="Your turn" onFinish={finishTurn} />;
  }

  return (
    <div style={styles.root}>
      <div style={styles.inner}>
        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <h1 style={styles.title}>🎤 Pitch Battle</h1>
        </div>

        {/* Join form */}
        {!joined && (
          <div style={styles.card}>
            <div style={styles.cardTitle}>Join a Game</div>
            <label style={styles.label}>Room Code</label>
            <input
              style={styles.input}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="e.g. PITCH1"
              maxLength={6}
            />
            {error && <div style={{ color: "#f87171", fontSize: 13, marginBottom: 8 }}>{error}</div>}
            <Btn onClick={joinRoom} disabled={code.length !== 6}>
              Join Game
            </Btn>
          </div>
        )}

        {/* Waiting for game to start */}
        {joined && room && room.state === "waiting" && (
          <div style={styles.card}>
            <div style={styles.cardTitle}>Lobby</div>
            <div style={styles.bigCode}>{room.code}</div>
            <div style={{ marginTop: 12, marginBottom: 16 }}>
              <div style={styles.label}>Players</div>
              {room.players.map((p) => (
                <div key={p.wallet} style={styles.playerRow}>
                  <span style={{ color: p.staked ? "#4ade80" : "#facc15" }}>
                    {p.staked ? "✓ Staked" : "○ Not staked"}
                  </span>{" "}
                  {p.name} {p.wallet === wallet.publicKey?.toBase58() ? "(you)" : ""}
                </div>
              ))}
            </div>

            {/* Stake button — appears once host creates the on-chain match */}
            {room.matchId && !staked && (
              <div>
                <div style={{ color: "#facc15", fontSize: 13, marginBottom: 10 }}>
                  Host locked the wager. Stake your SOL to join!
                </div>
                <Btn onClick={stakeOnChain} disabled={staking || !wallet.publicKey}>
                  {staking ? "Staking…" : `Stake ${(room.stake / 1e9).toFixed(3)} SOL`}
                </Btn>
              </div>
            )}
            {staked && (
              <div style={{ color: "#4ade80", fontSize: 14, textAlign: "center", marginTop: 8 }}>
                ✓ Staked! Waiting for game to start…
              </div>
            )}
            {!room.matchId && (
              <div style={{ color: "#6b7280", fontSize: 13, textAlign: "center" }}>
                Waiting for host to start…
              </div>
            )}
          </div>
        )}

        {/* Game in progress */}
        {joined && room && (room.state === "p1_singing" || room.state === "p2_singing") && (
          <div style={styles.card}>
            {myTurn ? (
              <>
                <div style={{ ...styles.cardTitle, color: "#4ade80", fontSize: 20 }}>Your Turn! 🎤</div>
                <div style={{ color: "#9ca3af", fontSize: 14, margin: "12px 0" }}>
                  Loading the karaoke screen on this device…
                </div>
                <div style={styles.pulse} />
              </>
            ) : (
              <>
                <div style={styles.cardTitle}>Opponent's Turn</div>
                <div style={{ color: "#9ca3af", fontSize: 14, margin: "12px 0" }}>
                  {opponentInfo?.name ?? "Opponent"} is singing…
                </div>
              </>
            )}
            <div style={{ marginTop: 20 }}>
              {room.players.map((p) => (
                <div key={p.wallet} style={styles.playerRow}>
                  {p.name} {p.wallet === guestId ? "(you)" : ""}:{" "}
                  {p.score !== null ? `${p.score}/100` : "—"}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Game over */}
        {gameOver && room && (
          <div style={styles.card}>
            <div style={styles.cardTitle}>{finish ? "Game Over" : "Scoring…"}</div>
            {room.players.map((p) => (
              <div
                key={p.wallet}
                style={{
                  ...styles.playerRow,
                  color: p.wallet === room.winner ? "#4ade80" : "#fff",
                  fontWeight: p.wallet === room.winner ? 700 : 400,
                  fontSize: 18,
                  padding: "10px 0",
                }}
              >
                {p.wallet === room.winner ? "🏆 " : ""}{p.name}{p.wallet === wallet.publicKey?.toBase58() ? " (you)" : ""}: {finish ? `${p.score}/100` : "—"}
              </div>
            ))}
            {finish && finish.winner === "tie" && (
              <div style={{ color: "#facc15", fontWeight: 700, fontSize: 16, marginTop: 12, textAlign: "center" }}>
                Tie — stakes refunded.
              </div>
            )}
            {finish && room.winner === wallet.publicKey?.toBase58() && (
              <div style={{ color: "#4ade80", fontWeight: 700, fontSize: 18, marginTop: 12, textAlign: "center" }}>
                🎉 You won!
              </div>
            )}
            {finish?.commentary && (
              <div style={{ color: "#9ca3af", fontSize: 13, marginTop: 12, fontStyle: "italic" }}>
                "{finish.commentary}"
              </div>
            )}
            {finish?.payout_tx && (
              <div style={{ color: "#6b7280", fontSize: 11, marginTop: 8, wordBreak: "break-all" }}>
                tx: {finish.payout_tx}
              </div>
            )}
          </div>
        )}

        {/* Log */}
        <div style={{ ...styles.card, background: "#0f0f0f", marginTop: 8 }}>
          <div style={styles.label}>Events</div>
          <div style={{ marginTop: 6, maxHeight: 150, overflowY: "auto" }}>
            {log.map((l, i) => <div key={i} style={{ fontSize: 12, color: "#9ca3af", marginBottom: 2 }}>{l}</div>)}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles: Record<string, React.CSSProperties> = {
  root: { minHeight: "100vh", background: "#0a0a0a", color: "#fff", fontFamily: "system-ui, sans-serif", padding: 20 },
  inner: { maxWidth: 400, margin: "0 auto" },
  title: { margin: "0 0 12px", fontSize: 20, fontWeight: 700 },
  card: { background: "#111", border: "1px solid #222", borderRadius: 12, padding: 20, marginBottom: 12 },
  cardTitle: { fontSize: 16, fontWeight: 600, marginBottom: 4, color: "#e5e7eb" },
  label: { color: "#6b7280", fontSize: 11, textTransform: "uppercase" as const, letterSpacing: 1 },
  bigCode: { fontSize: 48, fontWeight: 900, letterSpacing: 8, textAlign: "center" as const, color: "#facc15", padding: "12px 0" },
  input: { display: "block", width: "100%", background: "#1a1a1a", border: "1px solid #333", borderRadius: 6, padding: "10px 14px", color: "#fff", fontSize: 22, fontWeight: 700, letterSpacing: 4, textTransform: "uppercase" as const, marginTop: 4, marginBottom: 12, textAlign: "center" as const },
  playerRow: { padding: "6px 0", borderBottom: "1px solid #1a1a1a", fontSize: 14, fontFamily: "monospace" },
  pulse: { width: 80, height: 80, borderRadius: "50%", background: "#4ade8033", border: "3px solid #4ade80", margin: "20px auto", animation: "pulse 1s infinite" },
};

function Btn({ onClick, disabled, children }: {
  onClick: () => void; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: disabled ? "#222" : "#8b5cf6",
        color: disabled ? "#555" : "#fff",
        border: "none", borderRadius: 8, padding: "12px 20px",
        cursor: disabled ? "not-allowed" : "pointer",
        fontSize: 15, fontWeight: 600, width: "100%",
      }}
    >
      {children}
    </button>
  );
}
