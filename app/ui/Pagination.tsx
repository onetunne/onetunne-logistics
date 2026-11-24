import type { ReactNode } from "react";
import { Link } from "react-router";
import { cx } from "./cx";
import { ChevronLeftIcon, ChevronRightIcon } from "./internal";

export interface PaginationProps {
  prevHref?: string | null;
  nextHref?: string | null;
  /** Текст між кнопками, напр. «Сторінка 2 з 5». */
  label?: ReactNode;
  prevLabel: string;
  nextLabel: string;
  /** Доступна назва навігації (напр. «Навігація сторінками»). */
  ariaLabel?: string;
  className?: string;
}

/** Попередня / наступна сторінка. Нічого не рендерить, якщо сторінка одна. */
export function Pagination({ prevHref, nextHref, label, prevLabel, nextLabel, ariaLabel, className }: PaginationProps) {
  if (!prevHref && !nextHref) return null;
  return (
    <nav className={cx("ot-pagination", className)} aria-label={ariaLabel}>
      {prevHref ? (
        <Link to={prevHref} rel="prev" className="ot-button ot-button--secondary ot-button--sm ot-pagination__link">
          <ChevronLeftIcon />
          <span className="ot-pagination__text">{prevLabel}</span>
        </Link>
      ) : (
        <span className="ot-button ot-button--secondary ot-button--sm ot-pagination__link is-disabled" aria-disabled="true">
          <ChevronLeftIcon />
          <span className="ot-pagination__text">{prevLabel}</span>
        </span>
      )}
      {label ? <span className="ot-pagination__label">{label}</span> : null}
      {nextHref ? (
        <Link to={nextHref} rel="next" className="ot-button ot-button--secondary ot-button--sm ot-pagination__link">
          <span className="ot-pagination__text">{nextLabel}</span>
          <ChevronRightIcon />
        </Link>
      ) : (
        <span className="ot-button ot-button--secondary ot-button--sm ot-pagination__link is-disabled" aria-disabled="true">
          <span className="ot-pagination__text">{nextLabel}</span>
          <ChevronRightIcon />
        </span>
      )}
    </nav>
  );
}
