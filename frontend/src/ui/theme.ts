// MIC DROP — "Broadcast" design tokens (early-2000s live-TV look).
// Ported from the design handoff (prototype/ds.jsx). Source of truth for color,
// type, and the chunky outline/bevel/shadow helpers used across the broadcast UI.
import type { CSSProperties } from "react";

export const PAL = {
  ink:      "#0B0B0B",  // outlines, bars, text on light
  slime:    "#B6FF00",  // primary accent / "win" / CTAs
  slimeDk:  "#79B000",
  orange:   "#FF6B00",  // secondary CTA / "waiting"
  orangeDk: "#B84A00",
  purple:   "#8E2DE2",  // brand, headers
  purpleDp: "#5A1799",  // stage base, deep bg
  magenta:  "#FF1C8E",  // MC voice, "loser", LIVE kicker
  cyan:     "#13D7E8",  // info / QR / standby
  cyanDk:   "#0792A0",
  yellow:   "#FFD400",  // "up next", highlights, payout
  red:      "#FF2E2E",  // ON AIR / REC
  cream:    "#FFFDEB",  // input fields on white panels
  paper:    "#F2ECD6",  // light page bg
  white:    "#FFFFFF",
} as const;

export const FONT = {
  display: "'Anton', 'Arial Narrow', sans-serif", // loud condensed headlines (UPPERCASE)
  logo:    "'Bungee', 'Anton', sans-serif",       // the MIC DROP wordmark only
  body:    "'Archivo', system-ui, sans-serif",    // UI copy & captions
  mono:    "'VT323', 'Courier New', monospace",   // codes, addrs, timers, "TV" status
} as const;

// Hard offset shadow + thick ink outline — the workhorse panel look.
export function bevelPanel(
  bg: string,
  { outline = PAL.ink, shadow = 6, bw = 3 }: { outline?: string; shadow?: number; bw?: number } = {},
): CSSProperties {
  return {
    background: bg,
    border: `${bw}px solid ${outline}`,
    boxShadow: `${shadow}px ${shadow}px 0 ${PAL.ink}`,
    borderRadius: 0,
  };
}

// Chunky 3D beveled button face.
export function bevelFace(bg: string): CSSProperties {
  return {
    background: bg,
    border: `3px solid ${PAL.ink}`,
    boxShadow: `inset 3px 3px 0 rgba(255,255,255,0.5), inset -3px -3px 0 rgba(0,0,0,0.28), 4px 4px 0 ${PAL.ink}`,
    borderRadius: 0,
  };
}
