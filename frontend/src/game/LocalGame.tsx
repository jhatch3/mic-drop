import { useState, useCallback } from "react";
import Karaoke, { DEFAULT_SONG, type SongDef, type KaraokeResult } from "./Karaoke";
import {
  PAL, FONT, bevelPanel,
  OnAirBar, StageBG, LowerThird, ScoreBug, Nameplate,
  BevelBtn, Panel, Splat,
} from "@/ui";

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

  // ── Setup ──────────────────────────────────────────────────────────────────
  if (phase === "setup")
    return (
      <Broadcast
        tag="STANDBY" tagColor={PAL.cyan} blink={false}
        right="MIC DROP TV · GREEN ROOM"
        lower={
          <LowerThird
            kicker="UP NEXT" kickerColor={PAL.yellow} kickerFg={PAL.ink}
            headline="Two singers, one laptop — lock the bill and put it on air."
            action={
              <BevelBtn color={PAL.slime} big blink
                onClick={() => { setP1(null); setP2(null); setPhase("p1"); }}>
                GO LIVE »
              </BevelBtn>
            }
          />
        }
      >
        <Stage>
          <div style={S.kickerHead}>TONIGHT'S MATCHUP</div>

          <div style={S.vsRow}>
            <Nameplate kicker="CHAMPION" name={p1Name || "Player 1"} color={PAL.slime} sub="HOME MIC" />
            <span style={S.vsTxt}>VS</span>
            <Nameplate kicker="CHALLENGER" name={p2Name || "Player 2"} color={PAL.magenta} sub="THE SEAT" />
          </div>

          <Panel color={PAL.white} title="SET THE BILL" titleFg={PAL.slime}
            shadow={7} style={{ width: "min(620px, 92%)", marginTop: 28 }}>
            <label style={S.label}>Player 1</label>
            <input style={S.input} value={p1Name} maxLength={20}
              onChange={(e) => setP1Name(e.target.value)} placeholder="Player 1" />

            <label style={S.label}>Player 2</label>
            <input style={S.input} value={p2Name} maxLength={20}
              onChange={(e) => setP2Name(e.target.value)} placeholder="Player 2" />

            <label style={S.label}>Track</label>
            <select style={S.input} value={songIdx} onChange={(e) => setSongIdx(Number(e.target.value))}>
              {SONGS.map((s, i) => (
                <option key={i} value={i}>{s.title} — {s.artist}</option>
              ))}
            </select>

            <div style={S.note}>♪ Your browser will ask for mic access on the first round.</div>
          </Panel>
        </Stage>
      </Broadcast>
    );

  // ── Handoff (P1 done) ────────────────────────────────────────────────────────
  if (phase === "handoff" && p1)
    return (
      <Broadcast
        tag="GREEN ROOM" tagColor={PAL.orange} blink={false}
        right="MIC DROP TV · PASS THE MIC"
        lower={
          <LowerThird
            kicker="UP NEXT" kickerColor={PAL.yellow} kickerFg={PAL.ink}
            headline={<>Pass the laptop to <b>{p2Name}</b> — same track, fresh mic.</>}
            action={
              <BevelBtn color={PAL.orange} big blink onClick={() => setPhase("p2")}>
                {p2Name}'S TURN »
              </BevelBtn>
            }
          />
        }
      >
        <Stage>
          <div style={S.kickerHead}>ROUND 1 — IN THE BOOKS</div>
          <div style={S.handoffHead}>PLAYER 2 — YOU'RE UP</div>

          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 18, marginTop: 22 }}>
            <div style={{ ...bevelPanel(PAL.white, { shadow: 6 }), padding: "16px 30px", textAlign: "center" }}>
              <div style={S.scoreCap}>{p1Name} SCORED</div>
              <div style={{ ...S.bigScore, color: scoreColor(p1.score) }}>{p1.score}</div>
              <div style={S.frames}>{p1.hits} / {p1.scored} FRAMES HIT</div>
            </div>
            <Nameplate kicker="NOW ON DECK" name={p2Name} color={PAL.magenta} sub="ROUND 2" />
          </div>
        </Stage>
      </Broadcast>
    );

  // ── Results ──────────────────────────────────────────────────────────────────
  if (phase === "results" && p1 && p2) {
    const tie = p1.score === p2.score;
    const p1Wins = p1.score > p2.score;
    const winnerName = tie ? "" : p1Wins ? p1Name : p2Name;
    const loserName  = tie ? "" : p1Wins ? p2Name : p1Name;
    const margin = Math.abs(p1.score - p2.score);
    const quote = tie ? roast(p1Name, p2Name, 0) : roast(winnerName, loserName, margin);
    return (
      <Broadcast
        tag="FINAL" tagColor={PAL.slime} blink={false}
        right="MIC DROP TV · THE VERDICT"
        lower={
          <LowerThird
            kicker="THE MC 🔊" kickerColor={PAL.magenta}
            headline={<>&ldquo;{quote}&rdquo;</>}
            action={
              <div style={{ display: "flex", gap: 10 }}>
                <BevelBtn color={PAL.slime} big blink onClick={() => reset(false)}>REMATCH »</BevelBtn>
                <BevelBtn color={PAL.cyan} onClick={() => reset(true)}>NEW PLAYERS</BevelBtn>
              </div>
            }
          />
        }
      >
        <Stage>
          <div style={S.kickerHead}>{tie ? "IT'S A DEAD HEAT" : "YOUR WINNER"}</div>
          <div style={S.winnerHead}>{tie ? "TIE GAME" : winnerName}</div>

          <div style={{ marginTop: 26 }}>
            <ScoreBug big
              a={{ name: p1Name, score: p1.score, color: PAL.slime, fg: PAL.ink }}
              b={{ name: p2Name, score: p2.score, color: PAL.magenta, fg: PAL.white }} />
          </div>

          {!tie && (
            <Splat color={PAL.yellow} size={108} spin style={{ marginTop: 30 }}>
              <div style={{ fontFamily: FONT.display, fontSize: 18, color: PAL.ink, lineHeight: 1 }}>
                {winnerName}<br />WINS
              </div>
            </Splat>
          )}
        </Stage>
      </Broadcast>
    );
  }

  // ── Defensive fallback (preserves render contract) ──────────────────────────
  return (
    <Broadcast tag="STANDBY" tagColor={PAL.cyan} blink={false} right="MIC DROP TV"
      lower={<LowerThird headline="Resetting the board…" />}>
      <Stage>
        <div style={S.kickerHead}>STAND BY</div>
      </Stage>
    </Broadcast>
  );
}

// ── Shell: ON-AIR bar → purple stage → lower-third ──────────────────────────
function Broadcast({ tag, tagColor, blink, right, lower, children }: {
  tag: string; tagColor: string; blink: boolean; right: string;
  lower: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: PAL.ink }}>
      <OnAirBar tag={tag} tagColor={tagColor} blink={blink} right={right} />
      {children}
      {lower}
    </div>
  );
}

function Stage({ children }: { children: React.ReactNode }) {
  return (
    <StageBG>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", padding: "36px 24px", textAlign: "center" }}>
        {children}
      </div>
    </StageBG>
  );
}

function scoreColor(s: number) { return s >= 80 ? PAL.slimeDk : s >= 50 ? PAL.orangeDk : PAL.red; }

const S: Record<string, React.CSSProperties> = {
  kickerHead: { fontFamily: FONT.display, fontSize: 26, color: PAL.yellow, letterSpacing: 4,
    textShadow: `3px 3px 0 ${PAL.ink}`, marginBottom: 12 },
  handoffHead: { fontFamily: FONT.display, fontSize: "clamp(48px, 9vw, 96px)", color: PAL.white,
    letterSpacing: 1, lineHeight: 0.95, textShadow: `5px 5px 0 ${PAL.ink}`, transform: "rotate(-1deg)" },
  winnerHead: { fontFamily: FONT.display, fontSize: "clamp(56px, 11vw, 110px)", color: PAL.white,
    letterSpacing: 1, lineHeight: 0.95, textShadow: `5px 5px 0 ${PAL.ink}`, transform: "rotate(-1deg)",
    textTransform: "uppercase" },
  vsRow: { display: "flex", alignItems: "center", gap: 22, flexWrap: "wrap", justifyContent: "center" },
  vsTxt: { fontFamily: FONT.display, fontSize: 40, color: PAL.white, textShadow: `4px 4px 0 ${PAL.ink}` },
  label: { display: "block", color: PAL.ink, fontFamily: FONT.display, fontSize: 15, letterSpacing: 1,
    textTransform: "uppercase", marginBottom: 6 },
  input: { display: "block", width: "100%", boxSizing: "border-box", background: PAL.cream,
    border: `3px solid ${PAL.ink}`, borderRadius: 0, padding: "10px 14px", color: PAL.ink,
    fontFamily: FONT.body, fontWeight: 700, fontSize: 16, marginBottom: 16 },
  note: { fontFamily: FONT.mono, fontSize: 16, color: PAL.purpleDp, marginTop: 4 },
  scoreCap: { fontFamily: FONT.display, fontSize: 15, color: PAL.ink, letterSpacing: 1 },
  bigScore: { fontFamily: FONT.display, fontSize: 84, lineHeight: 1 },
  frames: { fontFamily: FONT.mono, fontSize: 16, color: PAL.ink },
};
