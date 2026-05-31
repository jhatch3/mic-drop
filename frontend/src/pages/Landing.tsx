// MIC DROP scrollable landing: hero (player-facing "cash"), how it works, the tech ("SOL").
import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import { PAL, FONT } from "../ui/theme";
import { Logo, BevelBtn, Panel, Ticker } from "../ui/Kit";
import { OnAirBar, StageBG, LowerThird } from "../ui/Broadcast";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const go = (path: string) => { window.location.href = path; };
const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });

// Sample lines the host speaks when you audition a voice persona.
const SAMPLE_LINES: Record<string, string> = {
  mc: "Welcome to MIC DROP! Two singers, one mic, winner takes the whole pot!",
  hype: "Let's GOOO! Make some noise for the next challenger!",
  villain: "You really think you can beat that score? Adorable.",
};
const prettify = (s: string) => s.replace(/_/g, " ").toUpperCase();

// Playable demo of the custom ElevenLabs voices + sound effects we built.
function AudioBoard() {
  const [sfx, setSfx] = useState<string[]>([]);
  const [personas, setPersonas] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/sfx`).then((r) => r.json()).then((d) => setSfx(Object.keys(d?.catalog || {}))).catch(() => {});
    fetch(`${API_BASE}/api/voices`).then((r) => r.json()).then((d) => setPersonas(Object.keys(d?.personas || {}))).catch(() => {});
  }, []);

  const stop = () => { try { audioRef.current?.pause(); } catch { /* */ } };
  const playSfx = (name: string) => {
    stop(); setBusy(`sfx:${name}`);
    const a = new Audio(`${API_BASE}/api/sfx/${name}`); audioRef.current = a;
    a.onended = () => setBusy(null); a.onerror = () => setBusy(null);
    a.play().catch(() => setBusy(null));
  };
  const playVoice = async (role: string) => {
    const key = `voice:${role}`; stop(); setBusy(key);
    try {
      const r = await fetch(`${API_BASE}/api/mc-voice`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: SAMPLE_LINES[role] ?? "Welcome to MIC DROP, let's get loud!", voice: role }),
      });
      const url = URL.createObjectURL(await r.blob());
      const a = new Audio(url); audioRef.current = a;
      a.onended = () => { setBusy(null); URL.revokeObjectURL(url); };
      a.onerror = () => setBusy(null);
      await a.play();
    } catch { setBusy(null); }
  };

  if (!sfx.length && !personas.length) return null;
  const chip = (label: string, key: string, color: string, onClick: () => void) => (
    <BevelBtn key={key} color={busy === key ? PAL.yellow : color} onClick={onClick} style={{ fontSize: 14, padding: "8px 14px" }}>
      {busy === key ? "♪ …" : "▶"} {label}
    </BevelBtn>
  );

  return (
    <Panel color={PAL.white} shadow={7} title="🔊 HEAR THE SHOW · TAP TO PLAY" titleBg={PAL.magenta} titleFg={PAL.white} style={{ width: "100%" }}>
      {personas.length > 0 && (
        <>
          <div style={{ fontFamily: FONT.display, fontSize: 16, letterSpacing: 1, color: PAL.purpleDp }}>CUSTOM VOICES</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "8px 0 16px" }}>
            {personas.map((p) => chip(p, `voice:${p}`, PAL.magenta, () => playVoice(p)))}
          </div>
        </>
      )}
      <div style={{ fontFamily: FONT.display, fontSize: 16, letterSpacing: 1, color: PAL.purpleDp }}>CUSTOM SOUND EFFECTS</div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
        {sfx.map((s) => chip(prettify(s), `sfx:${s}`, PAL.cyan, () => playSfx(s)))}
      </div>
      <div style={{ fontFamily: FONT.mono, fontSize: 13, color: PAL.purpleDp, marginTop: 12 }}>
        first tap cooks the clip on ElevenLabs, then it plays instantly.
      </div>
    </Panel>
  );
}

function Step({ n, color, title, body }: { n: string; color: string; title: string; body: string }) {
  return (
    <Panel color={PAL.white} shadow={7} title={<><span style={{ color }}>{n}</span>&nbsp;{title}</>} titleFg={PAL.white} style={{ flex: "1 1 240px", minWidth: 220 }}>
      <div style={{ fontFamily: FONT.body, fontWeight: 700, fontSize: 16, color: PAL.ink, lineHeight: 1.35 }}>{body}</div>
    </Panel>
  );
}

function TechCard({ tag, tagColor, title, body }: { tag: string; tagColor: string; title: string; body: string }) {
  return (
    <Panel color={PAL.white} shadow={6} style={{ flex: "1 1 260px", minWidth: 230 }}>
      <span style={{ background: tagColor, color: PAL.ink, fontFamily: FONT.display, fontSize: 13, letterSpacing: 1, padding: "3px 10px", border: `2px solid ${PAL.ink}` }}>{tag}</span>
      <div style={{ fontFamily: FONT.display, fontSize: 22, color: PAL.ink, marginTop: 8, letterSpacing: 0.5 }}>{title}</div>
      <div style={{ fontFamily: FONT.body, fontWeight: 600, fontSize: 15, color: PAL.purpleDp, lineHeight: 1.35, marginTop: 4 }}>{body}</div>
    </Panel>
  );
}

interface TopRow { player: string; song_id: string; score: number }

// Top-scores teaser for the landing; links into the full Hall of Fame.
function HallOfFameTeaser() {
  const [rows, setRows] = useState<TopRow[]>([]);
  useEffect(() => {
    fetch(`${API_BASE}/api/leaderboard/scores?limit=5`).then((r) => r.json()).then((d) => Array.isArray(d) && setRows(d)).catch(() => {});
  }, []);
  return (
    <section style={{ background: PAL.ink, borderTop: `4px solid ${PAL.ink}`, padding: "56px 20px" }}>
      <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: 22, alignItems: "center" }}>
        <h2 style={{ ...sectionHead(PAL.yellow), display: "flex", gap: 12, alignItems: "center" }}>🏆 HALL OF FAME</h2>
        <Panel color={PAL.white} shadow={8} title="TOP SCORES" titleBg={PAL.purple} titleFg={PAL.white} style={{ width: "100%" }} bodyStyle={{ padding: 0 }}>
          {rows.length === 0 ? (
            <div style={{ fontFamily: FONT.mono, fontSize: 16, color: PAL.purpleDp, padding: 18, textAlign: "center" }}>Empty board. Be the first name on it.</div>
          ) : rows.map((r, i) => (
            <div key={`${r.player}-${i}`} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: `1px solid ${PAL.ink}22`, background: i === 0 ? `${PAL.slime}44` : "transparent" }}>
              <span style={{ width: 32, fontFamily: FONT.display, fontSize: 22, color: i === 0 ? PAL.slimeDk : PAL.ink }}>{i + 1}</span>
              <span style={{ flex: 1, fontFamily: FONT.mono, fontSize: 16, color: PAL.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.player}…</span>
              <span style={{ flex: 1, fontFamily: FONT.body, fontWeight: 700, fontSize: 14, color: PAL.purpleDp, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{prettify(r.song_id)}</span>
              <span style={{ width: 56, textAlign: "right", fontFamily: FONT.display, fontSize: 24, color: r.score >= 80 ? PAL.slimeDk : PAL.ink }}>{r.score}</span>
            </div>
          ))}
        </Panel>
        <BevelBtn color={PAL.yellow} big onClick={() => go("/leaderboard")}>FULL LEADERBOARD »</BevelBtn>
      </div>
    </section>
  );
}

const sectionHead = (color: string): CSSProperties => ({
  fontFamily: FONT.display, fontSize: "clamp(30px,6vw,60px)", color,
  WebkitTextStroke: `2px ${PAL.ink}`, textShadow: `4px 4px 0 ${PAL.ink}`, letterSpacing: 0.5, textAlign: "center", margin: 0,
});

export default function Landing() {
  return (
    <div style={{ position: "relative", zIndex: 10, background: PAL.purpleDp, fontFamily: FONT.body }}>
      <OnAirBar tag="LIVE" tagColor={PAL.red} blink={false} right="MIC DROP TV · LIVE FROM DEVNET" />

      {/* ─────────── HERO (player-facing: CASH) ─────────── */}
      <StageBG style={{ minHeight: "calc(100vh - 58px)" }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 22, padding: "48px 20px", textAlign: "center" }}>
          <div style={{ fontFamily: FONT.display, fontSize: "clamp(16px,2.6vw,26px)", letterSpacing: 4, color: PAL.yellow, textShadow: `2px 2px 0 ${PAL.ink}` }}>
            THE WORLD'S LOUDEST GAME SHOW
          </div>

          <Logo scale={2.3} />

          <h1 style={{ margin: 0, fontFamily: FONT.display, fontSize: "clamp(34px,7.5vw,84px)", lineHeight: 0.95, color: PAL.white, WebkitTextStroke: `2px ${PAL.ink}`, textShadow: `4px 4px 0 ${PAL.ink}`, letterSpacing: 0.5, maxWidth: 900 }}>
            OUT-SING. <span style={{ color: PAL.slime }}>CASH OUT.</span><br />TALK SMACK.
          </h1>

          <p style={{ margin: 0, maxWidth: 640, fontFamily: FONT.body, fontWeight: 700, fontSize: "clamp(15px,2.2vw,20px)", color: PAL.white, lineHeight: 1.35 }}>
            Head-to-head karaoke for <span style={{ color: PAL.yellow }}>real cash</span>. Beat your rival's score,
            grab the whole pot, and let the <span style={{ color: PAL.magenta, background: PAL.ink, padding: "0 6px" }}>AI host</span> roast the loser on live TV.
          </p>

          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "center", marginTop: 4 }}>
            <BevelBtn color={PAL.slime} big onClick={() => go("/host")}>🎤 HOST A BATTLE »</BevelBtn>
            <BevelBtn color={PAL.cyan} big onClick={() => go("/play")}>📱 JOIN ON PHONE »</BevelBtn>
            <BevelBtn color={PAL.yellow} big onClick={() => go("/leaderboard")}>🏆 HALL OF FAME »</BevelBtn>
          </div>
          <button onClick={() => go("/local")} style={{ background: "none", border: "none", cursor: "pointer", fontFamily: FONT.mono, fontSize: 18, color: PAL.slime, textDecoration: "underline", letterSpacing: 1 }}>just here to play? run a local game »</button>

          <div style={{ marginTop: 6 }}>
            <BevelBtn color={PAL.purple} fg={PAL.white} big onClick={() => go("/dance")}>💃 WANNA DANCE? »</BevelBtn>
          </div>

          <button onClick={() => scrollTo("how")} style={{ marginTop: 16, background: PAL.ink, color: PAL.slime, border: `3px solid ${PAL.slime}`, cursor: "pointer", fontFamily: FONT.display, fontSize: 16, letterSpacing: 2, padding: "8px 20px" }}>
            ▼ HOW IT WORKS
          </button>
        </div>
      </StageBG>

      {/* ─────────── HOW IT WORKS (player-facing: CASH) ─────────── */}
      <section id="how" style={{ background: PAL.paper, borderTop: `4px solid ${PAL.ink}`, padding: "56px 20px" }}>
        <div style={{ maxWidth: 980, margin: "0 auto", display: "flex", flexDirection: "column", gap: 26 }}>
          <h2 style={sectionHead(PAL.purple)}>HOW IT WORKS</h2>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <Step n="01" color={PAL.orange} title="ANTE UP" body="Both players ante up the same cash. Win and you scoop the whole pot. Lose and you eat the burns." />
            <Step n="02" color={PAL.cyan} title="TAKE THE MIC" body="Grab the laptop and let it rip. We grade the lyrics you nail in time (80%) and the notes you hit (20%)." />
            <Step n="03" color={PAL.magenta} title="GET ROASTED" body="The AI host tallies live, counts you down, crowns the champ, pays out the cash, and roasts the loser on the mic." />
          </div>
          <div style={{ display: "flex", justifyContent: "center" }}>
            <BevelBtn color={PAL.slime} big onClick={() => go("/host")}>START A BATTLE »</BevelBtn>
          </div>
        </div>
      </section>

      {/* ─────────── HALL OF FAME (prominent) ─────────── */}
      <HallOfFameTeaser />

      {/* ─────────── THE TECH (dev-facing: SOL) ─────────── */}
      <section style={{ background: `radial-gradient(circle at 50% 0%, ${PAL.purple} 0%, ${PAL.purpleDp} 70%)`, borderTop: `4px solid ${PAL.ink}`, padding: "56px 20px" }}>
        <div style={{ maxWidth: 980, margin: "0 auto", display: "flex", flexDirection: "column", gap: 12 }}>
          <h2 style={sectionHead(PAL.white)}>UNDER THE HOOD</h2>
          <p style={{ textAlign: "center", fontFamily: FONT.mono, fontSize: "clamp(15px,2.2vw,19px)", color: PAL.cyan, margin: "0 0 14px" }}>
            under the hood, the "cash" is <b style={{ color: PAL.slime }}>devnet SOL</b>, staked on-chain and paid straight to the winner.
          </p>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <TechCard tag="SOLANA" tagColor={PAL.slime} title="On-chain escrow" body="An Anchor program on Solana devnet locks both players' SOL into a PDA and pays the pot to the winner's wallet. Only the backend oracle can settle, so nobody can rig the result." />
            <TechCard tag="AUDIO" tagColor={PAL.cyan} title="Real scoring" body="Pitch is scored frame-by-frame (octave-folded cents) and lyrics by timing-aware speech-to-text. The backend recomputes the real score, so the live graph never touches the cash." />
            <TechCard tag="GEMINI" tagColor={PAL.orange} title="The host IS the game" body="Gemini runs the whole show. It greets the room, hears you over the mic, asks if you're ready, and drives every move by CALLING TOOLS like start_p1_turn, start_p2_turn, reveal_scores, play_sound_effect and get_standings. The game state literally IS the host's tool calls." />
            <TechCard tag="ELEVENLABS" tagColor={PAL.magenta} title="The voice & the FX" body="Every line is spoken in a custom game-show host voice cloned on ElevenLabs. Every sound effect (the showtime sting, airhorn, drumroll, applause, sad trombone) is custom-generated with ElevenLabs text-to-sound and cached. Tap below to hear them." />
            <TechCard tag="DATA" tagColor={PAL.yellow} title="Hall of Fame" body="Every match lands in Snowflake, powering the leaderboard of highest scores by song." />
          </div>

          <AudioBoard />
        </div>
      </section>

      <Ticker bg={PAL.slime} label="MIC TICKER" items={[
        "PITCH BATTLE IS LIVE", "WINNER TAKES THE POT", "THE MC IS WARMING UP HIS BURNS",
        "STAKE · SING · SLAY", "DON'T CHOKE ON THE HIGH NOTE",
      ]} />

      <LowerThird kicker="GO LIVE" kickerColor={PAL.slime} kickerFg={PAL.ink}
        headline="Wager locked, mic hot. Put your pipes on air."
        bodyColor={PAL.white}
        action={<BevelBtn color={PAL.orange} onClick={() => go("/host")}>START »</BevelBtn>} />
    </div>
  );
}
