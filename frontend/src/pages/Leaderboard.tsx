// MIC DROP Hall of Fame (highest take scores, filter/sort by song). One component serves
// both the karaoke and the dance boards via the `mode` prop (theme + gamemode filter).
import { useEffect, useMemo, useState } from "react";
import { PAL, FONT } from "../ui/theme";
import { BevelBtn, Panel } from "../ui/Kit";
import { OnAirBar, StageBG, LowerThird } from "../ui/Broadcast";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const go = (p: string) => { window.location.href = p; };

interface Song { song_id: string; title?: string; artist?: string }
interface ScoreRow { pubkey: string; player: string; song_id: string; score: number; settled_at?: string }

export default function Leaderboard({ mode = "karaoke" }: { mode?: "karaoke" | "dance" }) {
  const dance = mode === "dance";
  const accent = dance ? PAL.magenta : PAL.slime;
  const accentDk = dance ? PAL.magenta : PAL.slimeDk;
  const word = dance ? "ROUTINE" : "SONG";

  const [songs, setSongs] = useState<Song[]>([]);
  const [rows, setRows] = useState<ScoreRow[]>([]);
  const [song, setSong] = useState<string>("all");   // song_id filter or "all"
  const [sortBy, setSortBy] = useState<"score" | "song">("score");
  const [loading, setLoading] = useState(true);

  const titleOf = useMemo(() => {
    const m = new Map<string, string>();
    songs.forEach((s) => m.set(s.song_id, s.title || s.song_id));
    return (id: string) => m.get(id) || id;
  }, [songs]);

  useEffect(() => {
    fetch(`${API_BASE}/api/songs`).then((r) => r.json()).then((d) => Array.isArray(d) && setSongs(d)).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ gamemode: mode });
    if (song !== "all") params.set("song_id", song);
    fetch(`${API_BASE}/api/leaderboard/scores?${params.toString()}`)
      .then((r) => r.json())
      .then((d) => setRows(Array.isArray(d) ? d : []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [song, mode]);

  const sorted = useMemo(() => {
    const r = [...rows];
    if (sortBy === "song") r.sort((a, b) => titleOf(a.song_id).localeCompare(titleOf(b.song_id)) || b.score - a.score);
    else r.sort((a, b) => b.score - a.score);
    return r;
  }, [rows, sortBy, titleOf]);

  const selStyle = { background: PAL.cream, border: `3px solid ${PAL.ink}`, borderRadius: 0, fontFamily: FONT.mono, fontSize: 16, padding: "8px 10px", color: PAL.ink, cursor: "pointer" } as const;

  return (
    <div style={{ position: "relative", zIndex: 10, minHeight: "100vh", display: "flex", flexDirection: "column", background: PAL.purpleDp, fontFamily: FONT.body }}>
      <OnAirBar home={dance ? "/dance" : "/"} tag="RANKS" tagColor={dance ? PAL.magenta : PAL.cyan} blink={false}
        right={dance ? "MIC DROP DANCE · HALL OF FAME" : "MIC DROP TV · HALL OF FAME"} />
      <StageBG>
        <div style={{ flex: 1, width: "100%", maxWidth: 760, margin: "0 auto", padding: "28px 16px", display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ fontFamily: FONT.display, fontSize: "clamp(28px,7vw,52px)", color: PAL.white, WebkitTextStroke: `2px ${PAL.ink}`, textShadow: `4px 4px 0 ${PAL.ink}`, textAlign: "center", lineHeight: 0.95 }}>
            {dance ? "DANCE HALL OF FAME" : "HALL OF FAME"}
          </div>

          {/* controls */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontFamily: FONT.display, fontSize: 14, color: PAL.yellow, letterSpacing: 1 }}>{word}</span>
            <select value={song} onChange={(e) => setSong(e.target.value)} style={selStyle}>
              <option value="all">{dance ? "ALL ROUTINES" : "ALL SONGS"}</option>
              {songs.map((s) => <option key={s.song_id} value={s.song_id}>{s.title || s.song_id}</option>)}
            </select>
            <span style={{ fontFamily: FONT.display, fontSize: 14, color: PAL.yellow, letterSpacing: 1, marginLeft: 8 }}>SORT</span>
            <BevelBtn color={sortBy === "score" ? accent : PAL.white} fg={PAL.ink} onClick={() => setSortBy("score")} style={{ fontSize: 14, padding: "6px 14px" }}>BY SCORE</BevelBtn>
            <BevelBtn color={sortBy === "song" ? accent : PAL.white} fg={PAL.ink} onClick={() => setSortBy("song")} style={{ fontSize: 14, padding: "6px 14px" }}>BY {word}</BevelBtn>
          </div>

          <Panel color={PAL.white} title="HIGH SCORES" titleBg={PAL.ink} titleFg={accent} style={{ width: "100%" }} bodyStyle={{ padding: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: `3px solid ${PAL.ink}`, background: PAL.cream, fontFamily: FONT.display, fontSize: 13, letterSpacing: 1, color: PAL.ink }}>
              <span style={{ width: 36 }}>#</span>
              <span style={{ flex: 1 }}>PLAYER</span>
              <span style={{ flex: 1.4 }}>{word}</span>
              <span style={{ width: 64, textAlign: "right" }}>SCORE</span>
            </div>
            {loading ? (
              <div style={{ fontFamily: FONT.mono, fontSize: 16, color: PAL.purpleDp, padding: 16, textAlign: "center" }}>loading the boards…</div>
            ) : sorted.length === 0 ? (
              <div style={{ fontFamily: FONT.mono, fontSize: 16, color: PAL.purpleDp, padding: 16, textAlign: "center" }}>empty board. go set one!</div>
            ) : sorted.map((r, i) => (
              <div key={`${r.pubkey}-${i}`} style={{
                display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
                borderBottom: `1px solid ${PAL.ink}22`, background: i === 0 && sortBy === "score" ? `${accent}44` : "transparent",
              }}>
                <span style={{ width: 36, fontFamily: FONT.display, fontSize: 18, color: i === 0 && sortBy === "score" ? accentDk : PAL.ink }}>{i + 1}</span>
                <span style={{ flex: 1, fontFamily: FONT.mono, fontSize: 16, color: PAL.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.player}…</span>
                <span style={{ flex: 1.4, fontFamily: FONT.body, fontWeight: 700, fontSize: 14, color: PAL.purpleDp, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{titleOf(r.song_id)}</span>
                <span style={{ width: 64, textAlign: "right", fontFamily: FONT.display, fontSize: 22, color: r.score >= 80 ? accentDk : PAL.ink }}>{r.score}</span>
              </div>
            ))}
          </Panel>
        </div>
      </StageBG>
      <LowerThird kicker="BACK" kickerColor={PAL.yellow} kickerFg={PAL.ink}
        headline={dance ? "Think you can top the board? Get on the floor." : "Think you can top the board? Get on the mic."}
        bodyColor={PAL.white}
        action={<BevelBtn color={accent} fg={PAL.ink} onClick={() => go(dance ? "/dance-host" : "/host")}>{dance ? "HOST A DANCE BATTLE »" : "HOST A BATTLE »"}</BevelBtn>} />
    </div>
  );
}
