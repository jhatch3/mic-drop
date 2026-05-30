import { useState, useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { getSocket } from "./socket";
import type { RoomState } from "./types";

export default function Player() {
  const wallet = useWallet();
  const socket = getSocket();

  // Pre-fill code from URL ?code=PITCH1
  const urlCode = new URLSearchParams(window.location.search).get("code") ?? "";
  const [code, setCode] = useState(urlCode.toUpperCase());
  const [room, setRoom] = useState<RoomState | null>(null);
  const [joined, setJoined] = useState(false);
  const [myTurn, setMyTurn] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState("");

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
      if (wallet.publicKey && t.wallet === wallet.publicKey.toBase58()) {
        setMyTurn(true);
        addLog("It's YOUR turn — sing!");
      } else {
        setMyTurn(false);
        addLog(`${t.player} is singing…`);
      }
    });
    socket.on("game:over", (r: RoomState) => {
      setRoom(r);
      setGameOver(true);
      setMyTurn(false);
      const winner = r.players.find((p) => p.wallet === r.winner);
      addLog(r.winner ? `Game over! ${winner?.name ?? "?"} wins!` : "Tie!");
    });
    socket.on("error", ({ msg }: { msg: string }) => {
      setError(msg);
      addLog("Error: " + msg);
    });

    return () => { socket.removeAllListeners(); };
  }, [socket, wallet.publicKey]);

  const joinRoom = () => {
    if (!wallet.publicKey || !code) return;
    setError("");
    socket.emit("room:join", { code: code.toUpperCase(), wallet: wallet.publicKey.toBase58() });
    setJoined(true);
    addLog(`Joining room ${code}…`);
  };

  const myInfo = room?.players.find((p) => p.wallet === wallet.publicKey?.toBase58());
  const opponentInfo = room?.players.find((p) => p.wallet !== wallet.publicKey?.toBase58());

  return (
    <div style={styles.root}>
      <div style={styles.inner}>
        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <h1 style={styles.title}>🎤 Pitch Battle</h1>
          <WalletMultiButton />
        </div>

        {/* Join form */}
        {!joined && (
          <div style={styles.card}>
            <div style={styles.cardTitle}>Join a Game</div>
            {!wallet.publicKey && (
              <div style={{ color: "#9ca3af", fontSize: 13, marginBottom: 12 }}>
                Connect your wallet first to join.
              </div>
            )}
            <label style={styles.label}>Room Code</label>
            <input
              style={styles.input}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="e.g. PITCH1"
              maxLength={6}
            />
            {error && <div style={{ color: "#f87171", fontSize: 13, marginBottom: 8 }}>{error}</div>}
            <Btn onClick={joinRoom} disabled={!wallet.publicKey || code.length !== 6}>
              Join Game
            </Btn>
          </div>
        )}

        {/* Waiting for game to start */}
        {joined && room && room.state === "waiting" && (
          <div style={styles.card}>
            <div style={styles.cardTitle}>Lobby</div>
            <div style={{ color: "#9ca3af", fontSize: 14, margin: "12px 0" }}>
              Waiting for host to start the game…
            </div>
            <div style={styles.bigCode}>{room.code}</div>
            <div style={{ marginTop: 12 }}>
              <div style={styles.label}>Players</div>
              {room.players.map((p) => (
                <div key={p.wallet} style={styles.playerRow}>
                  <span style={{ color: "#4ade80" }}>✓</span>{" "}
                  {p.name} {p.wallet === wallet.publicKey?.toBase58() ? "(you)" : ""}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Game in progress */}
        {joined && room && (room.state === "p1_singing" || room.state === "p2_singing") && (
          <div style={styles.card}>
            {myTurn ? (
              <>
                <div style={{ ...styles.cardTitle, color: "#4ade80", fontSize: 20 }}>Your Turn! 🎤</div>
                <div style={{ color: "#9ca3af", fontSize: 14, margin: "12px 0" }}>
                  Sing into the laptop mic. The host controls scoring.
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
                  {p.name} {p.wallet === wallet.publicKey?.toBase58() ? "(you)" : ""}:{" "}
                  {p.score !== null ? `${p.score}/100` : "—"}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Game over */}
        {gameOver && room && (
          <div style={styles.card}>
            <div style={styles.cardTitle}>Game Over</div>
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
                {p.wallet === room.winner ? "🏆 " : ""}{p.name}{p.wallet === wallet.publicKey?.toBase58() ? " (you)" : ""}: {p.score}/100
              </div>
            ))}
            {room.winner === wallet.publicKey?.toBase58() && (
              <div style={{ color: "#4ade80", fontWeight: 700, fontSize: 18, marginTop: 12, textAlign: "center" }}>
                🎉 You won! SOL is on its way.
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
