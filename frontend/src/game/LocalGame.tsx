import { useState, useCallback } from "react";
import Karaoke, { DEFAULT_SONG, type SongDef, type KaraokeResult } from "./Karaoke";

// ─── Local hot-seat 2-player mode — NO wallet, NO backend, NO socket ──────────
// Two players take turns singing on the same laptop (the karaoke station, per the
// device model). Scoring is the same client-side pitch engine the standalone
// /karaoke route uses; the higher accuracy wins. This is the "just let us play"
// path that sidesteps Solana wallet connection entirely.

type Phase = "setup" | "p1" | "handoff" | "p2" | "results";

// Songs available as local assets (public/songs/<id>/…). Add more here as they're
// prepped — the engine is song-agnostic.
const SONGS: SongDef[] = [DEFAULT_SONG];

// Deterministic, offline "MC" line — no Gemini/backend needed for local play.
function roast(winner: string, loser: string, margin: number): string {
  if (margin === 0)
    return `Dead heat. ${winner} and ${loser} are equally (in)credible. Sing it again.`;
  if (margin <= 5)
    return `${winner} edges it by a hair. ${loser}, that was painfully close — run it back.`;
  if (margin <= 20)
    return `${winner} takes it. Respectable showing from ${loser}, but the crown goes elsewhere.`;
  return `${winner} absolutely bodied that. ${loser}… maybe stick to lip-syncing.`;
}

export default function LocalGame() {
  const [phase, setPhase]   = useState<Phase>("setup");
  const [p1Name, setP1Name] = useState("Player 1");
  const [p2Name, setP2Name] = useState("Player 2");
  const [songIdx, setSongIdx] = useState(0);
  const [p1, setP1] = useState<KaraokeResult | null>(null);
  const [p2, setP2] = useState<KaraokeResult | null>(null);

  const song = SONGS[songIdx];

  const onP1Finish = useCallback((r: KaraokeResult) => { setP1(r); setPhase("handoff"); }, []);
  const onP2Finish = useCallback((r: KaraokeResult) => { setP2(r); setPhase("results"); }, []);

  const reset = (full: boolean) => {
    setP1(null); setP2(null);
    if (full) { setP1Name("Player 1"); setP2Name("Player 2"); }
    setPhase("setup");
  };

  // ── The singing rounds reuse the full Karaoke UI. Unique keys force a fresh
  //    mount per turn so each player gets a clean mic + zeroed score. ──────────
  if (phase === "p1")
    return <Karaoke key="p1" song={song} playerLabel={`${p1Name} — Round 1`} onFinish={onP1Finish} />;
  if (phase === "p2")
    return <Karaoke key="p2" song={song} playerLabel={`${p2Name} — Round 2`} onFinish={onP2Finish} />;

  return (
    <div style={S.root}>
      <div style={S.inner}>
        <div style={S.brand}>
          <div style={S.logo}>🎤</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 20 }}>Pitch Battle</div>
            <div style={{ color: "#6b7280", fontSize: 12, letterSpacing: 1 }}>LOCAL · NO WALLET</div>
          </div>
        </div>

        {/* ── Setup ─────────────────────────────────────────────────────── */}
        {phase === "setup" && (
          <div style={S.card}>
            <div style={S.cardTitle}>Two singers, one laptop</div>
            <div style={{ color: "#9ca3af", fontSize: 13, marginBottom: 20 }}>
              Take turns singing into the mic. Highest pitch accuracy wins — no SOL, no wallet, just bragging rights.
            </div>

            <label style={S.label}>Player 1</label>
            <input style={S.input} value={p1Name} maxLength={20}
              onChange={(e) => setP1Name(e.target.value)} placeholder="Player 1" />

            <label style={S.label}>Player 2</label>
            <input style={S.input} value={p2Name} maxLength={20}
              onChange={(e) => setP2Name(e.target.value)} placeholder="Player 2" />

            <label style={S.label}>Song</label>
            <select style={S.input} value={songIdx} onChange={(e) => setSongIdx(Number(e.target.value))}>
              {SONGS.map((s, i) => (
                <option key={i} value={i}>{s.title} — {s.artist}</option>
              ))}
            </select>

            <button style={S.primary} onClick={() => { setP1(null); setP2(null); setPhase("p1"); }}>
              ▶ Start Battle — {p1Name || "Player 1"} sings first
            </button>
            <div style={{ color: "#374151", fontSize: 11, marginTop: 12, textAlign: "center" }}>
              Your browser will ask for mic access on the first round.
            </div>
          </div>
        )}

        {/* ── Handoff (P1 done) ─────────────────────────────────────────── */}
        {phase === "handoff" && p1 && (
          <div style={S.card}>
            <div style={S.cardTitle}>Round 1 complete</div>
            <div style={{ textAlign: "center", padding: "16px 0" }}>
              <div style={{ color: "#6b7280", fontSize: 13 }}>{p1Name} scored</div>
              <div style={{ fontSize: 72, fontWeight: 900, color: scoreColor(p1.score), lineHeight: 1 }}>{p1.score}</div>
              <div style={{ color: "#374151", fontSize: 12 }}>{p1.hits} / {p1.scored} frames hit</div>
            </div>
            <div style={{ color: "#9ca3af", fontSize: 14, textAlign: "center", margin: "8px 0 20px" }}>
              🎤 Pass the mic to <b style={{ color: "#fff" }}>{p2Name}</b>.
            </div>
            <button style={S.primary} onClick={() => setPhase("p2")}>
              {p2Name}&apos;s turn →
            </button>
          </div>
        )}

        {/* ── Results ───────────────────────────────────────────────────── */}
        {phase === "results" && p1 && p2 && (() => {
          const tie = p1.score === p2.score;
          const p1Wins = p1.score > p2.score;
          const winnerName = tie ? "" : p1Wins ? p1Name : p2Name;
          const loserName  = tie ? "" : p1Wins ? p2Name : p1Name;
          const margin = Math.abs(p1.score - p2.score);
          return (
            <div style={S.card}>
              <div style={{ ...S.cardTitle, textAlign: "center", fontSize: 22 }}>
                {tie ? "🤝 It's a tie!" : `🏆 ${winnerName} wins!`}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, margin: "20px 0" }}>
                {([[p1Name, p1, p1Wins], [p2Name, p2, !p1Wins && !tie]] as const).map(([name, r, won], i) => (
                  <div key={i} style={{
                    background: "#0a0a18",
                    border: `1px solid ${won ? "#4ade8055" : "#0f0f1a"}`,
                    borderRadius: 12, padding: 16, textAlign: "center",
                  }}>
                    <div style={{ color: "#9ca3af", fontSize: 13, fontWeight: 600 }}>
                      {won ? "👑 " : ""}{name}
                    </div>
                    <div style={{ fontSize: 56, fontWeight: 900, color: scoreColor(r.score), lineHeight: 1.1 }}>{r.score}</div>
                    <div style={{ color: "#374151", fontSize: 11 }}>{r.hits}/{r.scored} hit</div>
                  </div>
                ))}
              </div>

              <div style={{ color: "#e5e7eb", fontSize: 14, fontStyle: "italic", textAlign: "center", marginBottom: 20 }}>
                "{tie ? roast(p1Name, p2Name, 0) : roast(winnerName, loserName, margin)}"
              </div>

              <button style={S.primary} onClick={() => reset(false)}>↺ Rematch (same players)</button>
              <button style={S.ghost} onClick={() => reset(true)}>New players</button>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

function scoreColor(s: number) { return s >= 80 ? "#4ade80" : s >= 50 ? "#facc15" : "#f87171"; }

const S: Record<string, React.CSSProperties> = {
  root: { minHeight: "100vh", background: "#07070f", color: "#fff", fontFamily: "'Inter', system-ui, sans-serif", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 },
  inner: { width: "100%", maxWidth: 460 },
  brand: { display: "flex", alignItems: "center", gap: 12, marginBottom: 20, justifyContent: "center" },
  logo: { width: 44, height: 44, borderRadius: 10, background: "linear-gradient(135deg,#7c3aed,#4f46e5)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 },
  card: { background: "#0c0c16", border: "1px solid #15151f", borderRadius: 16, padding: 24 },
  cardTitle: { fontSize: 17, fontWeight: 700, marginBottom: 8, color: "#f3f4f6" },
  label: { display: "block", color: "#6b7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 },
  input: { display: "block", width: "100%", boxSizing: "border-box", background: "#15151f", border: "1px solid #222230", borderRadius: 8, padding: "10px 14px", color: "#fff", fontSize: 15, marginBottom: 16 },
  primary: { width: "100%", background: "linear-gradient(135deg,#7c3aed,#6d28d9)", border: "none", borderRadius: 10, color: "#fff", padding: "13px 20px", cursor: "pointer", fontSize: 15, fontWeight: 700, marginTop: 4 },
  ghost: { width: "100%", background: "transparent", border: "1px solid #222230", borderRadius: 10, color: "#9ca3af", padding: "11px 20px", cursor: "pointer", fontSize: 14, fontWeight: 600, marginTop: 10 },
};
