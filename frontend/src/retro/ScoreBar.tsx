import { motion } from "motion/react";
import { cn } from "@/lib/utils";

type Color = "magenta" | "cyan" | "lime";

const FILL: Record<Color, string> = {
  magenta: "bg-magenta shadow-[0_0_8px_#ff2e97]",
  cyan: "bg-cyan shadow-[0_0_8px_#05d9e8]",
  lime: "bg-lime shadow-[0_0_8px_#aaff00]",
};

/**
 * Chunky segmented score meter (▮▮▮▯▯). `value` is 0–100; segments fill in
 * with a staggered pop. Empty segments are dim.
 */
export default function ScoreBar({
  value,
  color = "magenta",
  segments = 20,
  className,
}: {
  value: number;
  color?: Color;
  segments?: number;
  className?: string;
}) {
  const filled = Math.round((Math.max(0, Math.min(100, value)) / 100) * segments);
  return (
    <div className={cn("flex gap-[3px]", className)}>
      {Array.from({ length: segments }).map((_, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, scaleY: 0.4 }}
          animate={{ opacity: 1, scaleY: 1 }}
          transition={{ delay: i * 0.02, duration: 0.18 }}
          className={cn(
            "h-5 flex-1 rounded-[2px]",
            i < filled ? FILL[color] : "bg-muted",
          )}
        />
      ))}
    </div>
  );
}
