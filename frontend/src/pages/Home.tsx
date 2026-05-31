import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

export default function Home() {
  return (
    <div style={s.root}>
      <div style={s.inner}>
        {/* Header */}
        <div style={s.header}>
          <div style={s.logo}>🎤</div>
          <WalletMultiButton />
        </div>

        {/* Hero */}
        <div style={s.hero}>
          <h1 style={s.title}>Pitch Battle</h1>
          <p style={s.tagline}>Stake SOL. Sing or dance. Winner takes all.</p>
          <button style={s.cta} onClick={() => { window.location.href = "/host"; }}>
            🎤 Host a Game →
          </button>
        </div>

        {/* Action cards */}
        <div style={s.cards}>
          <button style={{ ...s.card, ...s.cardCreate }} onClick={() => { window.location.href = "/create"; }}>
            <div style={s.cardEmoji}>🎮</div>
            <div style={s.cardLabel}>Create Lobby</div>
            <div style={s.cardSub}>Pick a mode, set your wager</div>
          </button>

          <button style={{ ...s.card, ...s.cardJoin }} onClick={() => { window.location.href = "/play"; }}>
            <div style={s.cardEmoji}>🔑</div>
            <div style={s.cardLabel}>Join Lobby</div>
            <div style={s.cardSub}>Enter a room code</div>
          </button>
        </div>

        {/* Footer badge */}
        <div style={s.badge}>Powered by Solana devnet</div>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  root: {
    minHeight: "100vh",
    background: "#0a0a0a",
    color: "#fff",
    fontFamily: "system-ui, sans-serif",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  inner: { maxWidth: 680, width: "100%", margin: "0 auto" },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 56,
  },
  logo: { fontSize: 32 },
  hero: { textAlign: "center", marginBottom: 48 },
  title: {
    margin: "0 0 12px",
    fontSize: 72,
    fontWeight: 900,
    letterSpacing: -2,
    background: "linear-gradient(135deg, #8b5cf6 0%, #4ade80 100%)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
    backgroundClip: "text",
  },
  tagline: {
    margin: 0,
    fontSize: 18,
    color: "#6b7280",
    fontWeight: 400,
  },
  cta: {
    marginTop: 28,
    padding: "16px 40px",
    fontSize: 18,
    fontWeight: 800,
    color: "#fff",
    border: "none",
    borderRadius: 14,
    cursor: "pointer",
    background: "linear-gradient(100deg, #ff2e97, #b537f2)",
    boxShadow: "0 0 32px #ff2e9766",
  },
  cards: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 16,
    marginBottom: 40,
  },
  card: {
    border: "none",
    borderRadius: 20,
    padding: "40px 24px",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 10,
    transition: "transform 0.1s, box-shadow 0.1s",
    textAlign: "center",
  },
  cardCreate: {
    background: "linear-gradient(145deg, #3b1f6e 0%, #5b21b6 100%)",
    boxShadow: "0 0 40px #8b5cf640",
  },
  cardJoin: {
    background: "linear-gradient(145deg, #052e16 0%, #14532d 100%)",
    boxShadow: "0 0 40px #4ade8040",
  },
  cardEmoji: { fontSize: 48 },
  cardLabel: { fontSize: 24, fontWeight: 800, color: "#fff" },
  cardSub: { fontSize: 14, color: "#94a3b8", fontWeight: 400 },
  badge: {
    textAlign: "center",
    color: "#374151",
    fontSize: 12,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
};
