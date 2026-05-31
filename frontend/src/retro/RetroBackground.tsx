/**
 * Fixed synthwave backdrop: a deep indigo sky with a neon sun on the horizon and
 * a scrolling perspective grid below it. Purely decorative (pointer-events: none),
 * sits behind all content. Grid scroll auto-freezes under prefers-reduced-motion.
 */
export default function RetroBackground() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-background"
    >
      {/* Sky glow */}
      <div
        className="absolute inset-x-0 top-0 h-[60%]"
        style={{
          background:
            "radial-gradient(120% 80% at 50% 0%, #2a0f4d 0%, #160a2b 45%, #0b0617 80%)",
        }}
      />
      {/* Neon sun on the horizon */}
      <div
        className="absolute left-1/2 top-[44%] h-64 w-64 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          background:
            "linear-gradient(180deg, var(--sun-top) 0%, #ff5fa2 40%, var(--sun-bottom) 100%)",
          filter: "blur(2px) drop-shadow(0 0 60px #ff2e9799)",
          opacity: 0.9,
        }}
      />
      {/* Sun "blinds" mask — horizontal cuts for the retro sun look */}
      <div
        className="absolute left-1/2 top-[44%] h-64 w-72 -translate-x-1/2 -translate-y-1/2"
        style={{
          background:
            "repeating-linear-gradient(180deg, transparent 0 14px, #0b0617 14px 20px)",
          maskImage: "linear-gradient(180deg, transparent 55%, #000 100%)",
        }}
      />
      {/* Perspective grid floor */}
      <div className="absolute inset-x-0 bottom-0 top-[52%] [perspective:300px]">
        <div
          className="absolute inset-0 origin-top motion-safe:[animation:grid-scroll_1.6s_linear_infinite]"
          style={{
            transform: "rotateX(62deg)",
            backgroundImage:
              "linear-gradient(var(--neon-purple) 1px, transparent 1px), linear-gradient(90deg, var(--neon-purple) 1px, transparent 1px)",
            backgroundSize: "44px 44px",
            opacity: 0.35,
            maskImage: "linear-gradient(180deg, transparent 0%, #000 35%)",
          }}
        />
      </div>
    </div>
  );
}
