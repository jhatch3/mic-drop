import { useState, useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import QRCode from "react-qr-code";
import { useGameRoom } from "../services/useGameRoom";
import { useEscrow } from "../services/useEscrow";
import Karaoke, { type KaraokeResult } from "./Karaoke";

export default function KaraokeHost() {
  const wallet = useWallet();
  const [stakeSOL, setStakeSOL] = useState(
    () => new URLSearchParams(window.location.search).get("stake") ?? "0.001"
  );
  const { room, phase, currentTurn, log, addLog, createRoom, beginGame, submitScore } = useGameRoom();
  const { busy, createAndStake, settle } = useEscrow(addLog);

  // The laptop is the karaoke station: it runs the real pitch+lyrics for whoever's
  // turn it is and submits the real score. (Phones never sing.)
  const handleTurnFinish = useCallback((result: KaraokeResult) => {
    if (!currentTurn) return;
    addLog(`${currentTurn.player}: ${result.score}/100`);
    submitScore(currentTurn.wallet, result.score);
  }, [currentTurn, addLog, submitScore]);

  const handleCreateRoom = useCallback(() => {
    if (!wallet.publicKey) return;
    createRoom(wallet.publicKey.toBase58(), Math.floor(parseFloat(stakeSOL) * LAMPORTS_PER_SOL), "karaoke");
  }, [wallet.publicKey, stakeSOL, createRoom]);

  const handleStartGame = useCallback(async () => {
    if (!room || room.players.length < 2) return;
    try {
      await createAndStake(room.code, room.players[1].wallet, room.stake);
      beginGame(room.code);
    } catch (e: any) {
      addLog("Error: " + e.message);
    }
  }, [room, createAndStake, beginGame, addLog]);


  const joinUrl = room ? `${window.location.origin}/play?code=${room.code}` : null;

  return (
    <div style={S.root}>
      <div style={S.inner}>
        <div style={S.header}>
          <h1 style={S.title}>🎤 Karaoke Battle</h1>
          <WalletMultiButton />
        </div>

        {phase === "lobby" && (
          <div style={S.card}>
            <div style={S.cardTitle}>Create a Game</div>
            <label style={S.label}>Wager (SOL)</label>
            <input
              style={S.input} type="number" step="0.001" min="0.001"
              value={stakeSOL} onChange={(e) => setStakeSOL(e.target.value)}
            />
            <Btn onClick={handleCreateRoom} busy={busy} disabled={!wallet.publicKey}>
              {wallet.publicKey ? "Create Room" : "Connect Wallet First"}
            </Btn>
          </div>
        )}

        {phase === "waiting" && room && (
          <div style={S.card}>
            <div style={S.cardTitle}>Share the Code</div>
            <div style={S.bigCode}>{room.code}</div>
            {joinUrl && (
              <div style={{ display: "flex", justifyContent: "center", margin: "16px 0", background: "#fff", padding: 16, borderRadius: 12 }}>
                <QRCode value={joinUrl} size={180} />
              </div>
            )}
            <div style={{ color: "#9ca3af", fontSize: 12, textAlign: "center", marginBottom: 16, wordBreak: "break-all" }}>
              {joinUrl}
            </div>
            <div style={S.label}>Players joined: {room.players.length} / 2</div>
            {room.players.map((p) => (
              <div key={p.wallet} style={S.playerRow}>
                <span style={{ color: "#4ade80" }}>✓</span> {p.name} — {p.wallet.slice(0, 10)}…
              </div>
            ))}
            {room.players.length === 2 && (
              <Btn onClick={handleStartGame} busy={busy} color="#8b5cf6" style={{ marginTop: 16 }}>
                Start Game & Lock Wagers
              </Btn>
            )}
          </div>
        )}

        {phase === "gaming" && room && (
          currentTurn ? (
            // Laptop sings this turn for real (pitch + lyrics); score auto-submits on finish.
            <Karaoke
              key={currentTurn.wallet}
              playerLabel={`${currentTurn.player} — sing into this laptop!`}
              onFinish={handleTurnFinish}
            />
          ) : (
            <div style={S.card}>
              <div style={S.cardTitle}>Get Ready…</div>
              <div style={{ marginTop: 12 }}>
                {room.players.map((p) => (
                  <div key={p.wallet} style={S.playerRow}>
                    {p.name}: {p.score !== null ? `${p.score}/100` : "—"}
                  </div>
                ))}
              </div>
            </div>
          )
        )}

        {phase === "finished" && room && (
          <div style={S.card}>
            <div style={S.cardTitle}>Game Over</div>
            {room.players.map((p) => (
              <div key={p.wallet} style={{
                ...S.playerRow,
                color: p.wallet === room.winner ? "#4ade80" : "#fff",
                fontWeight: p.wallet === room.winner ? 700 : 400,
              }}>
                {p.wallet === room.winner ? "🏆 " : ""}{p.name}: {p.score}/100
              </div>
            ))}
            {room.winner && room.matchId && (
              <Btn onClick={() => settle(room.matchId!, room.winner!)} busy={busy} color="#8b5cf6" style={{ marginTop: 16 }}>
                Pay Winner on Solana
              </Btn>
            )}
          </div>
        )}

        <div style={{ ...S.card, background: "#0f0f0f", marginTop: 8 }}>
          <div style={S.label}>Log</div>
          <div style={{ marginTop: 6, maxHeight: 150, overflowY: "auto" }}>
            {log.length === 0 && <div style={{ color: "#555", fontSize: 12 }}>Events will appear here</div>}
            {log.map((l, i) => <div key={i} style={{ fontSize: 12, color: "#9ca3af", marginBottom: 2 }}>{l}</div>)}
          </div>
        </div>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
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
      onClick={onClick} disabled={busy || disabled}
      style={{
        background: busy || disabled ? "#222" : (color ?? "#3b82f6"),
        color: busy || disabled ? "#555" : "#fff",
        border: "none", borderRadius: 8, padding: "10px 20px",
        cursor: busy || disabled ? "not-allowed" : "pointer",
        fontSize: 14, fontWeight: 600, width: "100%", ...style,
      }}
    >
      {busy ? "…" : children}
    </button>
  );
}
