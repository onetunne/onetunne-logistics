import type { ReactNode } from "react";
import { Link } from "react-router";
import { cx } from "./cx";
import { ArrowLeftIcon } from "./internal";

export interface PageProps {
  title: string;
  subtitle?: ReactNode;
  backHref?: string;
  /** Доступна назва кнопки «Назад» (рекомендовано передавати разом з backHref). */
  backLabel?: string;
  /** Позначки біля заголовка (статуси, «Тест»). */
  titleMeta?: ReactNode;
  primaryAction?: ReactNode;
  secondaryActions?: ReactNode;
  /** Ширина вмісту: default — 1200px, narrow — 760px (форми), full — без обмеження. */
  width?: "default" | "narrow" | "full";
  className?: string;
  children?: ReactNode;
}

/** Сторінка: заголовок, дії та вміст. На мобільному дії розтягуються на всю ширину. */
export function Page({
  title,
  subtitle,
  backHref,
  backLabel,
  titleMeta,
  primaryAction,
  secondaryActions,
  width = "default",
  className,
  children,
}: PageProps) {
  const hasActions = Boolean(primaryAction || secondaryActions);
  return (
    <div className={cx("ot-page", width !== "default" && `ot-page--${width}`, className)}>
      <header className="ot-page__header">
        {backHref ? (
          <Link to={backHref} className="ot-page__back" aria-label={backLabel ?? "←"} title={backLabel}>
            <ArrowLeftIcon />
          </Link>
        ) : null}
        <div className="ot-page__heading">
          <div className="ot-page__title-row">
            <h1 className="ot-page__title">{title}</h1>
            {titleMeta ? <div className="ot-page__title-meta">{titleMeta}</div> : null}
          </div>
          {subtitle ? <div className="ot-page__subtitle">{subtitle}</div> : null}
        </div>
        {hasActions ? (
          <div className="ot-page__actions">
            {secondaryActions ? <div className="ot-page__secondary">{secondaryActions}</div> : null}
            {primaryAction ? <div className="ot-page__primary">{primaryAction}</div> : null}
          </div>
        ) : null}
      </header>
      <div className="ot-page__content">{children}</div>
    </div>
  );
}
