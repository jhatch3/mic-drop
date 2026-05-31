import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

type Gamemode = "karaoke" | "dance";

export default function CreateLobby() {
  const { publicKey } = useWallet();
  const [mode, setMode] = useState<Gamemode | null>(null);
  const [stake, setStake] = useState("0.001");

  const canCreate = !!publicKey && mode !== null && parseFloat(stake) > 0;

  function createRoom() {
    if (!canCreate) return;
    const path = mode === "dance" ? "/dance-host" : "/host";
    window.location.href = `${path}?stake=${encodeURIComponent(stake)}`;
  }

  return (
    <div style={s.root}>
      <div style={s.inner}>
        {/* Header */}
        <div style={s.header}>
          <button style={s.back} onClick={() => { window.location.href = "/"; }}>
            ← Back
          </button>
          <h2 style={s.heading}>Create a Lobby</h2>
          <WalletMultiButton />
        </div>

        {/* Mode selection */}
        <div style={s.sectionLabel}>Choose your gamemode</div>
        <div style={s.modeRow}>
          <ModeCard
            emoji="🎤"
            title="Karaoke"
            sub="Match pitch, beat your opponent"
            selected={mode === "karaoke"}
            onClick={() => setMode("karaoke")}
            accent="#8b5cf6"
          />
          <ModeCard
            emoji="💃"
            title="Dance"
            sub="Follow the moves, crush the beat"
            selected={mode === "dance"}
            onClick={() => setMode("dance")}
            accent="#4ade80"
          />
        </div>

        {/* Stake input */}
        <div style={s.sectionLabel}>Wager (SOL)</div>
        <input
          style={s.input}
          type="number"
          step="0.001"
          min="0.001"
          value={stake}
          onChange={(e) => setStake(e.target.value)}
        />
        <div style={s.stakeHint}>Each player stakes this amount. Winner takes ~99% of the pot.</div>

        {/* Create button */}
        {!publicKey && (
          <div style={s.walletPrompt}>Connect your wallet to create a room</div>
        )}
        <button
          style={{ ...s.createBtn, ...(canCreate ? {} : s.createBtnDisabled) }}
          onClick={createRoom}
          disabled={!canCreate}
        >
          {publicKey ? (mode ? "Create Room →" : "Select a mode first") : "Connect Wallet First"}
        </button>
      </div>
    </div>
  );
}

function ModeCard({
  emoji, title, sub, selected, onClick, accent,
}: {
  emoji: string; title: string; sub: string;
  selected: boolean; onClick: () => void; accent: string;
}) {
  return (
    <button
      style={{
        ...s.modeCard,
        border: selected ? `2px solid ${accent}` : "2px solid #1f1f1f",
        background: selected ? `${accent}18` : "#111",
        boxShadow: selected ? `0 0 24px ${accent}40` : "none",
      }}
      onClick={onClick}
    >
      <div style={s.modeEmoji}>{emoji}</div>
      <div style={s.modeTitle}>{title}</div>
      <div style={s.modeSub}>{sub}</div>
      {selected && <div style={{ ...s.selectedDot, background: accent }} />}
    </button>
  );
}

const s: Record<string, React.CSSProperties> = {
  root: {
    minHeight: "100vh",
    background: "#0a0a0a",
    color: "#fff",
    fontFamily: "system-ui, sans-serif",
    padding: 24,
  },
  inner: { maxWidth: 600, margin: "0 auto" },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    marginBottom: 40,
    flexWrap: "wrap",
  },
  back: {
    background: "none",
    border: "none",
    color: "#6b7280",
    cursor: "pointer",
    fontSize: 14,
    padding: 0,
  },
  heading: { margin: 0, fontSize: 22, fontWeight: 700, flex: 1 },
  sectionLabel: {
    color: "#6b7280",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 1.5,
    marginBottom: 12,
    marginTop: 8,
  },
  modeRow: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 12,
    marginBottom: 28,
  },
  modeCard: {
    borderRadius: 16,
    padding: "28px 20px",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 8,
    position: "relative",
    transition: "border-color 0.15s, background 0.15s",
    textAlign: "center",
  },
  modeEmoji: { fontSize: 40, lineHeight: 1 },
  modeTitle: { fontSize: 20, fontWeight: 700, color: "#fff" },
  modeSub: { fontSize: 13, color: "#9ca3af", fontWeight: 400 },
  selectedDot: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    position: "absolute",
    top: 12,
    right: 12,
  },
  input: {
    display: "block",
    width: "100%",
    background: "#1a1a1a",
    border: "1px solid #333",
    borderRadius: 10,
    padding: "12px 16px",
    color: "#fff",
    fontSize: 20,
    fontWeight: 700,
    marginBottom: 8,
    boxSizing: "border-box",
  },
  stakeHint: {
    color: "#4b5563",
    fontSize: 12,
    marginBottom: 28,
  },
  walletPrompt: {
    color: "#f59e0b",
    fontSize: 13,
    marginBottom: 10,
    textAlign: "center",
  },
  createBtn: {
    width: "100%",
    background: "linear-gradient(135deg, #8b5cf6, #4ade80)",
    border: "none",
    borderRadius: 12,
    padding: "16px 0",
    color: "#fff",
    fontSize: 17,
    fontWeight: 700,
    cursor: "pointer",
    letterSpacing: 0.5,
  },
  createBtnDisabled: {
    background: "#1f1f1f",
    color: "#4b5563",
    cursor: "not-allowed",
  },
};
