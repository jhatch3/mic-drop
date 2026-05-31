import { cn } from "@/lib/utils";

type Color = "magenta" | "cyan" | "purple" | "lime" | "yellow";

const COLOR: Record<Color, string> = {
  magenta: "text-magenta",
  cyan: "text-cyan",
  purple: "text-purple",
  lime: "text-lime",
  yellow: "text-yellow",
};

/** Pixel-font heading with neon glow. Use `as` to pick the tag (default h1). */
export default function NeonHeading({
  children,
  color = "magenta",
  as: Tag = "h1",
  className,
}: {
  children: React.ReactNode;
  color?: Color;
  as?: "h1" | "h2" | "h3";
  className?: string;
}) {
  return (
    <Tag className={cn("font-display text-glow", COLOR[color], className)}>
      {children}
    </Tag>
  );
}
