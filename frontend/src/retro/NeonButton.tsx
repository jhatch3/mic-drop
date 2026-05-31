import { motion } from "motion/react";
import { cn } from "@/lib/utils";

type Variant = "magenta" | "cyan" | "lime" | "ghost";

const VARIANT: Record<Variant, string> = {
  magenta:
    "text-primary-foreground [background:linear-gradient(100deg,#ff2e97,#b537f2)] shadow-[0_0_18px_#ff2e9788]",
  cyan: "text-secondary-foreground [background:linear-gradient(100deg,#05d9e8,#3b82f6)] shadow-[0_0_18px_#05d9e888]",
  lime: "text-[#06121a] [background:linear-gradient(100deg,#aaff00,#05d9e8)] shadow-[0_0_18px_#aaff0088]",
  ghost:
    "bg-transparent text-foreground border border-border hover:border-primary",
};

const SIZE = {
  sm: "px-3 py-2 text-[10px]",
  md: "px-5 py-3 text-xs",
  lg: "px-7 py-4 text-sm",
} as const;

/** Pixel-font action button with a neon gradient + glow and a springy press. */
export default function NeonButton({
  children,
  variant = "magenta",
  size = "md",
  className,
  disabled,
  type = "button",
  onClick,
}: {
  children: React.ReactNode;
  variant?: Variant;
  size?: keyof typeof SIZE;
  className?: string;
  disabled?: boolean;
  type?: "button" | "submit";
  onClick?: () => void;
}) {
  return (
    <motion.button
      type={type}
      onClick={onClick}
      disabled={disabled}
      whileHover={disabled ? undefined : { scale: 1.03 }}
      whileTap={disabled ? undefined : { scale: 0.96 }}
      transition={{ type: "spring", stiffness: 500, damping: 28 }}
      className={cn(
        "font-display inline-flex items-center justify-center gap-2 rounded-md uppercase tracking-wider outline-none transition-[filter] hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none",
        VARIANT[variant],
        SIZE[size],
        className,
      )}
    >
      {children}
    </motion.button>
  );
}
