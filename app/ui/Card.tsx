import type { ReactNode } from "react";
import { cx } from "./cx";

export interface CardProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** false — вміст без внутрішніх відступів (таблиці, списки). За замовчуванням true. */
  padded?: boolean;
  id?: string;
  /** Рівень заголовка картки (за замовчуванням h2 — під h1 сторінки). */
  titleAs?: "h2" | "h3" | "h4";
  className?: string;
  children?: ReactNode;
}

/** Картка-контейнер: радіус 12px, тонка рамка. */
export function Card({ title, description, actions, padded = true, id, titleAs = "h2", className, children }: CardProps) {
  const TitleTag = titleAs;
  const hasHeader = Boolean(title || description || actions);
  return (
    <section id={id} className={cx("ot-card", !padded && "ot-card--flush", className)}>
      {hasHeader ? (
        <div className="ot-card__header">
          <div className="ot-card__heading">
            {title ? <TitleTag className="ot-card__title">{title}</TitleTag> : null}
            {description ? <div className="ot-card__description">{description}</div> : null}
          </div>
          {actions ? <div className="ot-card__actions">{actions}</div> : null}
        </div>
      ) : null}
      <div className="ot-card__body">{children}</div>
    </section>
  );
}
