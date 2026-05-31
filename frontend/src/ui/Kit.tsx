// MIC DROP "Broadcast" kit — the chunky retro primitives.
// Ported from the design handoff (prototype/ds.jsx) to TS + React.
import type { CSSProperties, ReactNode } from "react";
import { PAL, FONT, bevelFace, bevelPanel } from "./theme";

// ── Chevron run "»»" ──────────────────────────────────────────────
export function Chevrons({ color = PAL.ink, size = 16, n = 2, style = {} }: {
  color?: string; size?: number; n?: number; style?: CSSProperties;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", ...style }}>
      {Array.from({ length: n }).map((_, i) => (
        <span key={i} style={{ fontFamily: FONT.display, color, fontSize: size, lineHeight: 1, marginLeft: i ? -size * 0.28 : 0 }}>»</span>
      ))}
    </span>
  );
}

// ── Splat blob (organic irregular ellipse) ───────────────────────
export function Splat({ color = PAL.orange, size = 120, children, style = {}, spin = false, outline = PAL.ink }: {
  color?: string; size?: number; children?: ReactNode; style?: CSSProperties; spin?: boolean; outline?: string;
}) {
  return (
    <div className={spin ? "md-spin" : undefined} style={{
      width: size, height: size, background: color, border: `3px solid ${outline}`,
      borderRadius: "49% 51% 47% 53% / 53% 47% 53% 47%",
      display: "flex", alignItems: "center", justifyContent: "center",
      textAlign: "center", flexShrink: 0, ...style,
    }}>{children}</div>
  );
}

// ── Beveled action button ─────────────────────────────────────────
export function BevelBtn({ color = PAL.orange, fg = PAL.ink, children, big = false, blink = false, onClick, disabled = false, style = {} }: {
  color?: string; fg?: string; children?: ReactNode; big?: boolean; blink?: boolean;
  onClick?: () => void; disabled?: boolean; style?: CSSProperties;
}) {
  return (
    <button
      className={disabled ? undefined : (blink ? "md-blink" : "md-press")}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        ...bevelFace(color), color: fg, fontFamily: FONT.display,
        fontSize: big ? 26 : 18, letterSpacing: 0.5, textTransform: "uppercase",
        padding: big ? "12px 28px" : "8px 18px",
        display: "inline-flex", alignItems: "center", gap: 8,
        cursor: disabled ? "not-allowed" : "pointer", userSelect: "none", whiteSpace: "nowrap",
        opacity: disabled ? 0.45 : 1, ...style,
      }}
    >{children}</button>
  );
}

// ── Black "GO!" pill ──────────────────────────────────────────────
export function GoPill({ label = "GO!", color = PAL.slime, style = {} }: { label?: string; color?: string; style?: CSSProperties }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6, background: PAL.ink, color,
      fontFamily: FONT.display, fontSize: 16, letterSpacing: 1, padding: "5px 14px",
      borderRadius: 999, border: `2px solid ${PAL.ink}`, whiteSpace: "nowrap", ...style,
    }}>{label}<Chevrons color={color} size={13} /></span>
  );
}

// ── Colored panel with optional title strip ───────────────────────
export function Panel({ color = PAL.cream, title, titleBg = PAL.ink, titleFg = PAL.slime, children, shadow = 6, style = {}, bodyStyle = {} }: {
  color?: string; title?: ReactNode; titleBg?: string; titleFg?: string;
  children?: ReactNode; shadow?: number; style?: CSSProperties; bodyStyle?: CSSProperties;
}) {
  return (
    <div style={{ ...bevelPanel(color, { shadow }), ...style }}>
      {title && (
        <div style={{
          background: titleBg, color: titleFg, fontFamily: FONT.display, fontSize: 17,
          letterSpacing: 0.6, textTransform: "uppercase", padding: "6px 12px",
          borderBottom: `3px solid ${PAL.ink}`, display: "flex", alignItems: "center", gap: 8,
        }}>{title}</div>
      )}
      <div style={{ padding: 14, ...bodyStyle }}>{children}</div>
    </div>
  );
}

// ── Marquee ticker bar ────────────────────────────────────────────
export function Ticker({ items = [], bg = PAL.slime, fg = PAL.ink, label = "MIC TICKER", speed = 26 }: {
  items?: string[]; bg?: string; fg?: string; label?: string; speed?: number;
}) {
  const row = items.join("    ◆    ");
  return (
    <div style={{ display: "flex", alignItems: "stretch", background: bg,
      borderTop: `3px solid ${PAL.ink}`, borderBottom: `3px solid ${PAL.ink}`, height: 34, overflow: "hidden" }}>
      <div style={{ background: PAL.ink, color: bg, fontFamily: FONT.display, fontSize: 15, letterSpacing: 1,
        display: "flex", alignItems: "center", padding: "0 12px", whiteSpace: "nowrap", flexShrink: 0 }}>
        {label}<Chevrons color={bg} size={14} n={3} style={{ marginLeft: 6 }} />
      </div>
      <div style={{ overflow: "hidden", flex: 1, display: "flex", alignItems: "center" }}>
        <div style={{ fontFamily: FONT.mono, fontSize: 20, color: fg, whiteSpace: "nowrap",
          animation: `mdMarquee ${speed}s linear infinite`, paddingLeft: "100%" }}>
          {row}{"    ◆    "}{row}
        </div>
      </div>
    </div>
  );
}

// ── MIC DROP wordmark ─────────────────────────────────────────────
export function Logo({ scale = 1 }: { scale?: number }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 10 * scale }}>
      <span style={{
        fontFamily: FONT.logo, fontSize: 34 * scale, lineHeight: 0.9, color: PAL.white,
        WebkitTextStroke: `${2.5 * scale}px ${PAL.ink}`, textShadow: `${3 * scale}px ${3 * scale}px 0 ${PAL.ink}`,
        letterSpacing: 0.5, transform: "rotate(-8deg)",
      }}>MIC</span>
      <span style={{
        fontFamily: FONT.logo, fontSize: 34 * scale, lineHeight: 0.9, color: PAL.yellow,
        WebkitTextStroke: `${2.5 * scale}px ${PAL.ink}`, textShadow: `${3 * scale}px ${3 * scale}px 0 ${PAL.ink}`,
        background: PAL.purple, padding: `${4 * scale}px ${10 * scale}px`,
        border: `${3 * scale}px solid ${PAL.ink}`, transform: "rotate(2deg)",
      }}>DROP</span>
    </div>
  );
}

// ── Striped image placeholder ─────────────────────────────────────
export function ImgSlot({ label = "IMAGE", w = "100%", h = 120, color = PAL.cyan, style = {} }: {
  label?: string; w?: number | string; h?: number | string; color?: string; style?: CSSProperties;
}) {
  return (
    <div style={{
      width: w, height: h,
      background: `repeating-linear-gradient(45deg, ${color}22 0 10px, ${color}44 10px 20px)`,
      border: `3px dashed ${PAL.ink}`, display: "flex", alignItems: "center", justifyContent: "center", ...style,
    }}>
      <span style={{ fontFamily: FONT.mono, fontSize: 16, color: PAL.ink, letterSpacing: 1,
        background: PAL.cream, padding: "2px 8px", border: `2px solid ${PAL.ink}` }}>{label}</span>
    </div>
  );
}
