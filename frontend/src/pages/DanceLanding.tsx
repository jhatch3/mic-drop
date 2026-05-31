// MIC DROP DANCE landing: a clone of the karaoke landing, themed for the just-dance app.
// Hero (player-facing "cash"), how it works, the tech ("SOL"). No em dashes; punchy copy.
import type { CSSProperties } from "react";
import { PAL, FONT } from "../ui/theme";
import { Logo, BevelBtn, Panel, Ticker } from "../ui/Kit";
import { OnAirBar, StageBG, LowerThird } from "../ui/Broadcast";

const go = (path: string) => { window.location.href = path; };
const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });

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

const sectionHead = (color: string): CSSProperties => ({
  fontFamily: FONT.display, fontSize: "clamp(30px,6vw,60px)", color,
  WebkitTextStroke: `2px ${PAL.ink}`, textShadow: `4px 4px 0 ${PAL.ink}`, letterSpacing: 0.5, textAlign: "center", margin: 0,
});

export default function DanceLanding() {
  return (
    <div style={{ position: "relative", zIndex: 10, background: PAL.purpleDp, fontFamily: FONT.body }}>
      <OnAirBar tag="LIVE" tagColor={PAL.magenta} blink={false} right="MIC DROP DANCE · LIVE FROM DEVNET" />

      {/* HERO (player-facing: CASH) */}
      <StageBG style={{ minHeight: "calc(100vh - 58px)" }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 22, padding: "48px 20px", textAlign: "center" }}>
          <div style={{ fontFamily: FONT.display, fontSize: "clamp(16px,2.6vw,26px)", letterSpacing: 4, color: PAL.cyan, textShadow: `2px 2px 0 ${PAL.ink}` }}>
            THE WORLD'S LOUDEST DANCE FLOOR
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", justifyContent: "center" }}>
            <Logo scale={2.1} />
            <span style={{ fontFamily: FONT.logo, fontSize: "clamp(34px,9vw,72px)", color: PAL.magenta, WebkitTextStroke: `3px ${PAL.ink}`, textShadow: `4px 4px 0 ${PAL.ink}`, transform: "rotate(-3deg)" }}>DANCE</span>
          </div>

          <h1 style={{ margin: 0, fontFamily: FONT.display, fontSize: "clamp(34px,7.5vw,84px)", lineHeight: 0.95, color: PAL.white, WebkitTextStroke: `2px ${PAL.ink}`, textShadow: `4px 4px 0 ${PAL.ink}`, letterSpacing: 0.5, maxWidth: 900 }}>
            OUT-DANCE. <span style={{ color: PAL.magenta }}>CASH OUT.</span><br />SHOW OFF.
          </h1>

          <p style={{ margin: 0, maxWidth: 640, fontFamily: FONT.body, fontWeight: 700, fontSize: "clamp(15px,2.2vw,20px)", color: PAL.white, lineHeight: 1.35 }}>
            Head-to-head dance battles for <span style={{ color: PAL.cyan }}>real cash</span>. Nail the choreography on camera,
            grab the whole pot, and let the <span style={{ color: PAL.magenta, background: PAL.ink, padding: "0 6px" }}>AI host</span> roast whoever's got two left feet.
          </p>

          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "center", marginTop: 4 }}>
            <BevelBtn color={PAL.magenta} fg={PAL.white} big onClick={() => go("/dance-host")}>💃 HOST A DANCE BATTLE »</BevelBtn>
            <BevelBtn color={PAL.cyan} big onClick={() => go("/play")}>📱 JOIN ON PHONE »</BevelBtn>
            <BevelBtn color={PAL.yellow} big onClick={() => go("/dance-leaderboard")}>🏆 HALL OF FAME »</BevelBtn>
          </div>

          <div style={{ marginTop: 6 }}>
            <BevelBtn color={PAL.slime} big onClick={() => go("/")}>🎤 WANNA SING? »</BevelBtn>
          </div>

          <button onClick={() => scrollTo("how")} style={{ marginTop: 16, background: PAL.ink, color: PAL.magenta, border: `3px solid ${PAL.magenta}`, cursor: "pointer", fontFamily: FONT.display, fontSize: 16, letterSpacing: 2, padding: "8px 20px" }}>
            ▼ HOW IT WORKS
          </button>
        </div>
      </StageBG>

      {/* HOW IT WORKS (player-facing: CASH) */}
      <section id="how" style={{ background: PAL.paper, borderTop: `4px solid ${PAL.ink}`, padding: "56px 20px" }}>
        <div style={{ maxWidth: 980, margin: "0 auto", display: "flex", flexDirection: "column", gap: 26 }}>
          <h2 style={sectionHead(PAL.magenta)}>HOW IT WORKS</h2>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <Step n="01" color={PAL.orange} title="ANTE UP" body="Both dancers ante up the same cash. Win and you scoop the whole pot. Lose and you eat the burns." />
            <Step n="02" color={PAL.cyan} title="HIT YOUR MARKS" body="Step in front of the camera and follow the moves. We track your body in real time and grade how tight you match the choreography." />
            <Step n="03" color={PAL.magenta} title="GET ROASTED" body="The AI host tallies live, counts you down, crowns the champ, pays out the cash, and roasts whoever fell off the beat." />
          </div>
          <div style={{ display: "flex", justifyContent: "center" }}>
            <BevelBtn color={PAL.magenta} fg={PAL.white} big onClick={() => go("/dance-host")}>START A DANCE BATTLE »</BevelBtn>
          </div>
        </div>
      </section>

      {/* THE TECH (dev-facing: SOL) */}
      <section style={{ background: `radial-gradient(circle at 50% 0%, ${PAL.purple} 0%, ${PAL.purpleDp} 70%)`, borderTop: `4px solid ${PAL.ink}`, padding: "56px 20px" }}>
        <div style={{ maxWidth: 980, margin: "0 auto", display: "flex", flexDirection: "column", gap: 12 }}>
          <h2 style={sectionHead(PAL.white)}>UNDER THE HOOD</h2>
          <p style={{ textAlign: "center", fontFamily: FONT.mono, fontSize: "clamp(15px,2.2vw,19px)", color: PAL.cyan, margin: "0 0 14px" }}>
            under the hood, the "cash" is <b style={{ color: PAL.slime }}>devnet SOL</b>, staked on-chain and paid straight to the winner.
          </p>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <TechCard tag="POSE AI" tagColor={PAL.cyan} title="Camera is the judge" body="MediaPipe pose tracking runs live in your browser, reading 33 body landmarks per frame and scoring how closely your moves match the choreography. No special hardware, just a webcam." />
            <TechCard tag="SOLANA" tagColor={PAL.slime} title="On-chain escrow" body="An Anchor program on Solana devnet locks both dancers' SOL into a PDA and pays the pot to the winner's wallet. Only the backend oracle can settle, so nobody can rig the result." />
            <TechCard tag="AI MC" tagColor={PAL.magenta} title="The host runs the floor" body="Gemini drives the whole show and calls the moves through tools, all spoken in a custom game-show host voice cloned on ElevenLabs with custom sound effects." />
            <TechCard tag="DATA" tagColor={PAL.yellow} title="Hall of Fame" body="Every battle lands in Snowflake, powering the leaderboard of highest scores by routine." />
          </div>
        </div>
      </section>

      <Ticker bg={PAL.magenta} fg={PAL.white} label="DANCE TICKER" items={[
        "DANCE BATTLE IS LIVE", "WINNER TAKES THE POT", "THE MC IS WARMING UP HIS BURNS",
        "STAKE · MOVE · SLAY", "DON'T MISS THE BEAT DROP",
      ]} />

      <LowerThird kicker="GO LIVE" kickerColor={PAL.magenta} kickerFg={PAL.white}
        headline="Wager locked, floor's hot. Step into frame."
        bodyColor={PAL.white}
        action={<BevelBtn color={PAL.cyan} onClick={() => go("/dance-host")}>START »</BevelBtn>} />
    </div>
  );
}
