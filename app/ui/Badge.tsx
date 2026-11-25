import type { ReactNode } from "react";
import { cx } from "./cx";

export type BadgeTone = "neutral" | "strong" | "outline" | "critical" | "warning" | "success" | "info";

export interface BadgeProps {
  tone?: BadgeTone;
  size?: "sm" | "md";
  /** Підказка при наведенні (напр. повна назва статусу). */
  title?: string;
  className?: string;
  children?: ReactNode;
}

/** Компактна позначка статусу. Колір — лише для семантичних станів. */
export function Badge({ tone = "neutral", size = "md", title, className, children }: BadgeProps) {
  return (
    <span className={cx("ot-badge", `ot-badge--${tone}`, `ot-badge--${size}`, className)} title={title}>
      {children}
    </span>
  );
}
