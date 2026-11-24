/**
 * Внутрішні помічники UI-кіту: іконки (inline SVG, без зовнішніх ресурсів),
 * блокування прокрутки сторінки, ідентифікатори полів.
 * Усе SSR-безпечне: доступ до document — лише всередині функцій, які викликаються з effect/обробників.
 */
import type { ReactNode, SVGProps } from "react";

type IconProps = Omit<SVGProps<SVGSVGElement>, "children">;

function Svg({ children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 6h13M3.5 10h13M3.5 14h13" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
    </Svg>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M16 10H4.5M9 5l-5 5 5 5" />
    </Svg>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5l-5 5 5 5" />
    </Svg>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 5l5 5-5 5" />
    </Svg>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5.5 8l4.5 4.5L14.5 8" />
    </Svg>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="10" cy="10" r="7.25" />
      <path d="M10 9v4.5M10 6.5v.01" />
    </Svg>
  );
}

export function SuccessIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="10" cy="10" r="7.25" />
      <path d="M6.75 10.25l2.25 2.25 4.25-4.5" />
    </Svg>
  );
}

export function WarningIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 3.25L17.25 16H2.75L10 3.25z" />
      <path d="M10 8.25v3.5M10 13.75v.01" />
    </Svg>
  );
}

export function CriticalIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="10" cy="10" r="7.25" />
      <path d="M10 6.25v4.5M10 13.5v.01" />
    </Svg>
  );
}

export function ImageIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <circle cx="7.5" cy="8.5" r="1.25" />
      <path d="M17 13l-3.5-3.5L6 16" />
    </Svg>
  );
}

/** Стабільний id поля з імені: "shipping[address1]" → "ot-shipping-address1". */
export function fieldIdFromName(name: string, suffix?: string): string {
  const base = `${name}${suffix ? `-${suffix}` : ""}`
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `ot-${base || "field"}`;
}

const SCROLL_LOCK_CLASS = "ot-scroll-locked";
let scrollLocks = 0;

/**
 * Блокує прокрутку сторінки (drawer, модальне вікно). Повертає функцію зняття блокування.
 * Лічильник дозволяє кільком джерелам блокувати прокрутку одночасно.
 * Викликати лише на клієнті (з useEffect або обробника подій).
 */
export function lockPageScroll(): () => void {
  if (typeof document === "undefined") return () => {};
  scrollLocks += 1;
  document.documentElement.classList.add(SCROLL_LOCK_CLASS);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    scrollLocks = Math.max(0, scrollLocks - 1);
    if (scrollLocks === 0) document.documentElement.classList.remove(SCROLL_LOCK_CLASS);
  };
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Елементи, на які можна перевести фокус, всередині контейнера (для пастки фокусу). */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true",
  );
}
