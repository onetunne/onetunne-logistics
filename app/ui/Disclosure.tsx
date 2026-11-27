import { useEffect, useState, type ReactNode } from "react";
import { cx } from "./cx";
import { Text } from "./Text";

/** Межа «телефон» (та сама, що в styles.css для `.ot-disclosure--collapse-mobile`). */
const MOBILE_QUERY = "(max-width: 767.98px)";

export interface DisclosureProps {
  /** Заголовок (вміст `<summary>`). */
  summary: ReactNode;
  /**
   * true — на телефоні згорнуто за замовчуванням, на ширших екранах відкрито (напр. фільтри переліків).
   * До гідратації вміст на телефоні прихований стилем (`:not([data-ready])`), тож фільтри не «блимають».
   */
  collapsedOnMobile?: boolean;
  /** Початковий стан без collapsedOnMobile. */
  defaultOpen?: boolean;
  className?: string;
  children?: ReactNode;
}

/**
 * Розкривний блок на `<details>/<summary>` (працює й без JavaScript). Ціль натискання заголовка — не менше 44px
 * (глобальне правило `details > summary` у styles.css).
 */
export function Disclosure({ summary, collapsedOnMobile = false, defaultOpen = false, className, children }: DisclosureProps) {
  const [open, setOpen] = useState(collapsedOnMobile ? true : defaultOpen);
  const [ready, setReady] = useState(!collapsedOnMobile);
  useEffect(() => {
    if (!collapsedOnMobile) return;
    if (window.matchMedia?.(MOBILE_QUERY).matches) setOpen(false);
    setReady(true);
  }, [collapsedOnMobile]);
  return (
    <details
      className={cx("ot-disclosure", collapsedOnMobile && "ot-disclosure--collapse-mobile", className)}
      data-ready={ready ? "" : undefined}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="ot-disclosure__summary">
        <Text as="span" variant="body-sm" weight="semibold">
          {summary}
        </Text>
      </summary>
      <div className="ot-disclosure__content">{children}</div>
    </details>
  );
}
