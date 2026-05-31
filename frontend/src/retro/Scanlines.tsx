/**
 * CRT overlay: faint horizontal scanlines + a vignette, fixed above content but
 * non-interactive. The flicker only runs with motion enabled.
 */
export default function Scanlines() {
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-50 motion-safe:[animation:crt-flicker_4s_steps(2)_infinite]"
        style={{
          background:
            "repeating-linear-gradient(0deg, rgba(0,0,0,0.0) 0px, rgba(0,0,0,0.0) 2px, rgba(0,0,0,0.35) 3px, rgba(0,0,0,0.0) 4px)",
          opacity: 0.15,
        }}
      />
      {/* Vignette */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-40"
        style={{
          background:
            "radial-gradient(120% 120% at 50% 50%, transparent 55%, rgba(5,2,12,0.65) 100%)",
        }}
      />
    </>
  );
}
