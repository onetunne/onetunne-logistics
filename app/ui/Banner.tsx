import type { AriaRole, ReactNode } from "react";
import { cx } from "./cx";
import { CriticalIcon, InfoIcon, SuccessIcon, WarningIcon } from "./internal";

export type BannerTone = "info" | "success" | "warning" | "critical";

export interface BannerProps {
  tone?: BannerTone;
  title?: ReactNode;
  action?: ReactNode;
  /** За замовчуванням: "alert" для critical, інакше "status". */
  role?: AriaRole;
  id?: string;
  className?: string;
  children?: ReactNode;
}

const ICONS = {
  info: InfoIcon,
  success: SuccessIcon,
  warning: WarningIcon,
  critical: CriticalIcon,
} as const;

/** Повідомлення на сторінці (помилки, попередження, підтвердження дій). */
export function Banner({ tone = "info", title, action, role, id, className, children }: BannerProps) {
  const Icon = ICONS[tone];
  const hasChildren = children !== undefined && children !== null && children !== false && children !== "";
  return (
    <div
      id={id}
      className={cx("ot-banner", `ot-banner--${tone}`, className)}
      role={role ?? (tone === "critical" ? "alert" : "status")}
    >
      <span className="ot-banner__icon">
        <Icon />
      </span>
      <div className="ot-banner__body">
        {title ? <p className="ot-banner__title">{title}</p> : null}
        {hasChildren ? <div className="ot-banner__content">{children}</div> : null}
        {action ? <div className="ot-banner__action">{action}</div> : null}
      </div>
    </div>
  );
}
