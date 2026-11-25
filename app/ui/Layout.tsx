import type { ReactNode } from "react";
import { cx } from "./cx";

export type SpaceScale = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface StackProps {
  /** 0=0, 1=4px, 2=8px, 3=12px, 4=16px, 5=24px, 6=32px. */
  gap?: SpaceScale;
  direction?: "vertical" | "horizontal";
  align?: "start" | "center" | "end" | "stretch" | "baseline";
  justify?: "start" | "center" | "end" | "between";
  /** За замовчуванням true для горизонтального стеку (щоб не було горизонтальної прокрутки на iPhone). */
  wrap?: boolean;
  as?: "div" | "section" | "ul" | "ol" | "li" | "span";
  id?: string;
  className?: string;
  children?: ReactNode;
}

/** Flex-стек з фіксованою шкалою відступів. */
export function Stack({
  gap = 3,
  direction = "vertical",
  align,
  justify,
  wrap,
  as: Tag = "div",
  id,
  className,
  children,
}: StackProps) {
  const shouldWrap = wrap ?? direction === "horizontal";
  return (
    <Tag
      id={id}
      className={cx(
        "ot-stack",
        `ot-stack--${direction}`,
        `ot-stack--gap-${gap}`,
        align && `ot-stack--align-${align}`,
        justify && `ot-stack--justify-${justify}`,
        shouldWrap && "ot-stack--wrap",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export interface GridColumns {
  xs?: number;
  md?: number;
  lg?: number;
}

export interface GridProps {
  /** Кількість колонок (1–6): xs < 768px, md ≥ 768px, lg ≥ 1024px. Відсутні значення успадковуються. */
  columns?: GridColumns;
  gap?: SpaceScale;
  className?: string;
  children?: ReactNode;
}

function clampColumns(n: number | undefined, fallback: number): number {
  if (n === undefined || !Number.isFinite(n)) return fallback;
  return Math.min(6, Math.max(1, Math.round(n)));
}

/** Адаптивна CSS-сітка. */
export function Grid({ columns, gap = 4, className, children }: GridProps) {
  const xs = clampColumns(columns?.xs, 1);
  const md = clampColumns(columns?.md, xs);
  const lg = clampColumns(columns?.lg, md);
  return (
    <div
      className={cx(
        "ot-grid",
        `ot-grid--xs-${xs}`,
        `ot-grid--md-${md}`,
        `ot-grid--lg-${lg}`,
        `ot-grid--gap-${gap}`,
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface FormLayoutProps {
  /** 2 — дві колонки на ширині ≥ 768px. */
  columns?: 1 | 2;
  className?: string;
  children?: ReactNode;
}

/**
 * Вертикальне розміщення полів форми. Щоб елемент займав усю ширину у 2-колонковій
 * розкладці, огорніть його в елемент з класом "ot-form-layout__full".
 */
export function FormLayout({ columns = 1, className, children }: FormLayoutProps) {
  return <div className={cx("ot-form-layout", columns === 2 && "ot-form-layout--2", className)}>{children}</div>;
}

/** Горизонтальна розділова лінія. */
export function Divider({ className }: { className?: string }) {
  return <hr className={cx("ot-divider", className)} />;
}
