import { motion } from "motion/react";
import { cn } from "@/lib/utils";

type Glow = "magenta" | "cyan" | "purple";

const GLOW: Record<Glow, string> = {
  magenta: "box-glow",
  cyan: "box-glow-cyan",
  purple:
    "shadow-[0_0_0_1px_#b537f2aa,0_0_16px_#b537f255] border-[#b537f2aa]",
};

/** Bordered, glowing CRT panel with an optional pixel-font title bar. */
export default function CRTCard({
  children,
  title,
  glow = "magenta",
  className,
  animate = true,
}: {
  children: React.ReactNode;
  title?: string;
  glow?: Glow;
  className?: string;
  animate?: boolean;
}) {
  return (
    <motion.div
      initial={animate ? { opacity: 0, y: 12 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className={cn(
        "rounded-lg border border-border bg-card/80 p-5 backdrop-blur-sm",
        GLOW[glow],
        className,
      )}
    >
      {title && (
        <div className="font-display text-[10px] uppercase tracking-widest text-muted-foreground mb-3">
          {title}
        </div>
      )}
      {children}
    </motion.div>
  );
}
