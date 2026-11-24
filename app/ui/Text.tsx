import type { ElementType, JSX, ReactNode } from "react";
import { cx } from "./cx";

export type TextVariant = "heading-lg" | "heading-md" | "heading-sm" | "body" | "body-sm" | "caption" | "mono";
export type TextTone = "default" | "subdued" | "critical" | "success" | "warning";
export type TextWeight = "regular" | "medium" | "semibold" | "bold";

export interface TextProps {
  as?: keyof JSX.IntrinsicElements;
  variant?: TextVariant;
  tone?: TextTone;
  weight?: TextWeight;
  align?: "start" | "center" | "end";
  /** Обрізати довгий текст трьома крапками в один рядок. */
  truncate?: boolean;
  /** Табличні цифри (для сум, кількостей). */
  numeric?: boolean;
  id?: string;
  className?: string;
  children?: ReactNode;
}

const DEFAULT_ELEMENT: Record<TextVariant, keyof JSX.IntrinsicElements> = {
  "heading-lg": "h2",
  "heading-md": "h3",
  "heading-sm": "h4",
  body: "p",
  "body-sm": "p",
  caption: "span",
  mono: "span",
};

/** Типографіка з фіксованою шкалою. Елемент за замовчуванням залежить від варіанта. */
export function Text({
  as,
  variant = "body",
  tone = "default",
  weight,
  align,
  truncate,
  numeric,
  id,
  className,
  children,
}: TextProps) {
  const Tag = (as ?? DEFAULT_ELEMENT[variant]) as ElementType;
  return (
    <Tag
      id={id}
      className={cx(
        "ot-text",
        `ot-text--${variant}`,
        tone !== "default" && `ot-text--tone-${tone}`,
        weight && `ot-text--weight-${weight}`,
        align && `ot-text--align-${align}`,
        truncate && "ot-text--truncate",
        numeric && "ot-text--numeric",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

/** Текст лише для допоміжних технологій (екранних читачів). */
export function VisuallyHidden({ children, id }: { children?: ReactNode; id?: string }) {
  return (
    <span className="ot-visually-hidden" id={id}>
      {children}
    </span>
  );
}

/** Короткий фрагмент коду / ідентифікатор (номер накладної, ключ). */
export function InlineCode({ children }: { children?: ReactNode }) {
  return <code className="ot-inline-code">{children}</code>;
}
