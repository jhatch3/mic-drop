// MIC DROP "Broadcast" kit — the live-TV pieces (ported from prototype/ds.jsx).
import type { CSSProperties, ReactNode } from "react";
import { PAL, FONT, bevelPanel } from "./theme";
import { Logo } from "./Kit";

// ── Stage background: radial wash + faint spotlight stripes ───────
export function StageBG({ children, style = {} }: { children?: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ position: "relative", flex: 1, overflow: "hidden", display: "flex", flexDirection: "column",
      background: `radial-gradient(circle at 50% 24%, ${PAL.purple} 0%, ${PAL.purpleDp} 72%)`, ...style }}>
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none",
        background: "repeating-linear-gradient(90deg, transparent 0 74px, rgba(255,255,255,0.05) 74px 76px)" }} />
      <div style={{ position: "relative", zIndex: 2, flex: 1, display: "flex", flexDirection: "column" }}>{children}</div>
    </div>
  );
}

// ── ON-AIR top bar ────────────────────────────────────────────────
export function OnAirBar({ right = "MIC DROP TV · LIVE FROM DEVNET", tag = "ON AIR", tagColor = PAL.red, blink = true, left, home }: {
  right?: ReactNode; tag?: string; tagColor?: string; blink?: boolean; left?: ReactNode;
  /** When set, shows a HOME button on the far left that navigates to this path. */
  home?: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 16px",
      borderBottom: `4px solid ${PAL.ink}`, background: PAL.ink, flexShrink: 0, flexWrap: "wrap" }}>
      {home != null && (
        <button onClick={() => { window.location.href = home; }} title="Home" style={{
          background: PAL.slime, color: PAL.ink, border: `2px solid ${PAL.slime}`, borderRadius: 0,
          fontFamily: FONT.display, fontSize: 14, letterSpacing: 1, padding: "4px 10px", cursor: "pointer", whiteSpace: "nowrap",
        }}>⌂ HOME</button>
      )}
      <span className={blink ? "md-blink" : undefined} style={{ background: tagColor, color: PAL.white,
        fontFamily: FONT.display, fontSize: 15, padding: "3px 12px", letterSpacing: 1 }}>● {tag}</span>
      <Logo scale={0.58} />
      {left}
      <span style={{ marginLeft: "auto", fontFamily: FONT.mono, fontSize: 18, color: PAL.slime }}>{right}</span>
    </div>
  );
}

// ── Lower-third banner — the signature element ────────────────────
export function LowerThird({ kicker = "LIVE", kickerColor = PAL.magenta, kickerFg = PAL.white, headline, bodyColor = PAL.slime, action }: {
  kicker?: ReactNode; kickerColor?: string; kickerFg?: string; headline: ReactNode; bodyColor?: string; action?: ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "stretch", borderTop: `4px solid ${PAL.ink}`, flexShrink: 0, flexWrap: "wrap" }}>
      <div style={{ background: kickerColor, color: kickerFg, fontFamily: FONT.display, fontSize: "clamp(15px,3vw,20px)", letterSpacing: 1,
        padding: "12px 16px", display: "flex", alignItems: "center", borderRight: `4px solid ${PAL.ink}`, whiteSpace: "nowrap" }}>{kicker}</div>
      <div style={{ background: bodyColor, color: PAL.ink, fontFamily: FONT.body, fontWeight: 800, fontSize: "clamp(15px,2.4vw,21px)",
        padding: "12px 16px", display: "flex", alignItems: "center", flex: 1, minWidth: 180, lineHeight: 1.12 }}>{headline}</div>
      {action && <div style={{ display: "flex", alignItems: "center", padding: "10px 14px", background: bodyColor, borderLeft: `4px solid ${PAL.ink}` }}>{action}</div>}
    </div>
  );
}

type BugSide = { name: ReactNode; score: ReactNode; color: string; fg?: string };

// ── VS score bug ──────────────────────────────────────────────────
export function ScoreBug({ a, b, big = false }: { a: BugSide; b: BugSide; big?: boolean }) {
  const fs = big ? "clamp(22px,5.5vw,34px)" : "clamp(17px,4vw,26px)";
  const vs = big ? "clamp(15px,3.6vw,24px)" : "clamp(12px,2.8vw,19px)";
  const seg = (s: BugSide, lead: boolean) => (
    <span style={{ background: s.color, color: s.fg || PAL.ink, fontFamily: FONT.display, fontSize: fs,
      padding: big ? "10px 16px" : "8px 12px", display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}>
      {lead ? <>{s.name}<b>{s.score}</b></> : <><b>{s.score}</b>{s.name}</>}
    </span>
  );
  return (
    <div style={{ display: "inline-flex", alignItems: "stretch", border: `4px solid ${PAL.ink}`, boxShadow: `6px 6px 0 ${PAL.ink}`, maxWidth: "100%" }}>
      {seg(a, true)}
      <span style={{ background: PAL.ink, color: PAL.white, fontFamily: FONT.display, fontSize: vs, padding: "0 10px", display: "flex", alignItems: "center" }}>VS</span>
      {seg(b, false)}
    </div>
  );
}

// ── Competitor nameplate ──────────────────────────────────────────
export function Nameplate({ name, sub, color = PAL.slime, kicker = "NOW SINGING" }: {
  name: ReactNode; sub?: ReactNode; color?: string; kicker?: string;
}) {
  return (
    <div style={{ border: `4px solid ${PAL.ink}`, boxShadow: `5px 5px 0 ${PAL.ink}`, display: "inline-block" }}>
      <div style={{ background: PAL.ink, color, fontFamily: FONT.display, fontSize: 14, letterSpacing: 2, padding: "4px 14px" }}>{kicker}</div>
      <div style={{ background: color, color: PAL.ink, fontFamily: FONT.display, fontSize: "clamp(22px,5vw,32px)", letterSpacing: 0.5,
        padding: "6px 16px", display: "flex", alignItems: "baseline", gap: 10 }}>
        {name}{sub && <span style={{ fontFamily: FONT.mono, fontSize: 16 }}>{sub}</span>}
      </div>
    </div>
  );
}

// ── The MC's "voice" — a commentary waveform (no mascot) ──────────
export function MCWave({ quote, label = "THE MC · ON THE CALL", bars = 30, color = PAL.slime, compact = false, live = true, style = {} }: {
  quote?: ReactNode; label?: string; bars?: number; color?: string; compact?: boolean; live?: boolean; style?: CSSProperties;
}) {
  const hs = Array.from({ length: bars }).map((_, i) =>
    16 + Math.abs(Math.sin(i * 0.9) * 0.6 + Math.sin(i * 0.37) * 0.4) * (compact ? 26 : 44));
  return (
    <div style={{ ...bevelPanel(PAL.white), padding: compact ? 12 : 16, ...style }}>
      <div style={{ marginBottom: 8 }}>
        <span style={{ background: PAL.magenta, color: PAL.white, fontFamily: FONT.display, fontSize: 14, letterSpacing: 1, padding: "4px 12px" }}>🔊 {label}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 3, height: compact ? 40 : 60, marginBottom: quote ? 10 : 0 }}>
        {hs.map((h, i) => (
          <div key={i} className={live ? "md-eq" : undefined} style={{ flex: 1, height: h,
            background: i % 3 === 0 ? PAL.magenta : color, border: `1.5px solid ${PAL.ink}`,
            animationDelay: `${(i % 7) * 0.11}s` }} />
        ))}
      </div>
      {quote && <div style={{ fontFamily: FONT.body, fontWeight: 800, fontSize: compact ? 17 : 21, lineHeight: 1.18 }}>{quote}</div>}
    </div>
  );
}
