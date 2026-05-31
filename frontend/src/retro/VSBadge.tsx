import { motion } from "motion/react";
import { cn } from "@/lib/utils";

/** The "VS" battle divider — slams in with a spring. */
export default function VSBadge({ className }: { className?: string }) {
  return (
    <motion.div
      initial={{ scale: 2.2, opacity: 0, rotate: -12 }}
      animate={{ scale: 1, opacity: 1, rotate: -6 }}
      transition={{ type: "spring", stiffness: 320, damping: 16 }}
      className={cn(
        "font-display text-yellow text-glow select-none text-2xl",
        className,
      )}
    >
      VS
    </motion.div>
  );
}
