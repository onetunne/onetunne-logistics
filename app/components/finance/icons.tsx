/**
 * Етап 6, WP0-UI: значки станів фінансів (inline SVG, без зовнішніх ресурсів). Стан ніколи не передається лише
 * кольором: значок + текст (§2.6 «значок + текст, не лише колір»). Значки декоративні (aria-hidden) — текст поруч.
 */
import type { ReactElement, SVGProps } from "react";
import type { CompletenessMarker, ComponentState, OrderFinanceState, ProfitState } from "~/domain/finance";

export type FinanceIconName = "check" | "half" | "approx" | "warning" | "zero" | "dash" | "clock" | "cross" | "blocked" | "dot";

type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { name: FinanceIconName };

const PATHS: Readonly<Record<FinanceIconName, ReactElement>> = {
  check: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M5.25 8.25l1.9 1.9 3.6-3.9" />
    </>
  ),
  half: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 1.75a6.25 6.25 0 0 1 0 12.5z" fill="currentColor" stroke="none" />
    </>
  ),
  approx: (
    <>
      <path d="M3 6.5c1.5-1.5 3-1.5 5 0s3.5 1.5 5 0" />
      <path d="M3 10.5c1.5-1.5 3-1.5 5 0s3.5 1.5 5 0" />
    </>
  ),
  warning: (
    <>
      <path d="M8 2.25L14.25 13.5H1.75L8 2.25z" />
      <path d="M8 6.5v3M8 11.5v.01" />
    </>
  ),
  zero: (
    <>
      <ellipse cx="8" cy="8" rx="3.25" ry="5.25" />
    </>
  ),
  dash: <path d="M3.5 8h9" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.75V8l2.25 1.5" />
    </>
  ),
  cross: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M5.75 5.75l4.5 4.5M10.25 5.75l-4.5 4.5" />
    </>
  ),
  blocked: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M3.6 12.4l8.8-8.8" />
    </>
  ),
  dot: <circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" />,
};

/** Значок стану 16×16 (успадковує колір тексту). */
export function FinanceIcon({ name, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="ot-finance-icon"
      data-icon={name}
      {...props}
    >
      {PATHS[name]}
    </svg>
  );
}

export type AnyFinanceState = ComponentState | ProfitState | OrderFinanceState;

/** Значок і тон для кожного стану складника / прибутку / визнання замовлення. */
export const STATE_PRESENTATION: Readonly<Record<AnyFinanceState, { icon: FinanceIconName; tone: "success" | "info" | "warning" | "outline" | "neutral" }>> = {
  actual: { icon: "check", tone: "success" },
  partial: { icon: "half", tone: "info" },
  forecast: { icon: "approx", tone: "info" },
  missing: { icon: "warning", tone: "warning" },
  zero_confirmed: { icon: "zero", tone: "success" },
  not_applicable: { icon: "dash", tone: "outline" },
  final: { icon: "check", tone: "success" },
  preliminary: { icon: "approx", tone: "info" },
  incomplete: { icon: "warning", tone: "warning" },
  "n/a": { icon: "dash", tone: "outline" },
  open: { icon: "clock", tone: "outline" },
  recognized: { icon: "dot", tone: "neutral" },
  closed_unrecognized: { icon: "cross", tone: "outline" },
  excluded: { icon: "blocked", tone: "outline" },
};

/** Маркер повноти плитки (§2.6): «Повні дані» / «З прогнозом» / «Неповні дані». */
export const MARKER_PRESENTATION: Readonly<Record<CompletenessMarker, { icon: FinanceIconName; tone: "success" | "info" | "warning" }>> = {
  complete: { icon: "check", tone: "success" },
  with_forecast: { icon: "approx", tone: "info" },
  incomplete: { icon: "warning", tone: "warning" },
};
