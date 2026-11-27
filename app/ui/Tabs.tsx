import { useEffect, useRef, type ReactNode } from "react";
import { Link } from "react-router";
import { cx } from "./cx";

export interface TabItem {
  key: string;
  label: ReactNode;
  href: string;
  count?: number | null;
}

export interface TabsProps {
  items: TabItem[];
  selected: string;
  ariaLabel: string;
  /** Не прокручувати сторінку вгору при перемиканні (фільтри списку). За замовчуванням true. */
  preventScrollReset?: boolean;
  className?: string;
}

/** Вкладки-посилання (фільтри за статусом тощо). На мобільному прокручуються горизонтально. */
export function Tabs({ items, selected, ariaLabel, preventScrollReset = true, className }: TabsProps) {
  const listRef = useRef<HTMLUListElement>(null);

  // Прокрутити вибрану вкладку у видиму область (лише всередині списку, без прокрутки сторінки).
  useEffect(() => {
    const list = listRef.current;
    if (!list || list.scrollWidth <= list.clientWidth) return;
    const current = list.querySelector<HTMLElement>('[aria-current="page"]');
    if (!current) return;
    const listRect = list.getBoundingClientRect();
    const rect = current.getBoundingClientRect();
    const left = rect.left - listRect.left + list.scrollLeft;
    const right = left + rect.width;
    if (left < list.scrollLeft || right > list.scrollLeft + list.clientWidth) {
      list.scrollLeft = Math.max(0, left - (list.clientWidth - rect.width) / 2);
    }
  }, [selected]);

  // Підказка прокрутки: м'яке згасання краю, за яким є ще вкладки (data-fade = start | end | both).
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const update = () => {
      const max = list.scrollWidth - list.clientWidth;
      const start = list.scrollLeft > 1;
      const end = max > 1 && list.scrollLeft < max - 1;
      const fade = start && end ? "both" : start ? "start" : end ? "end" : null;
      if (fade) list.dataset.fade = fade;
      else delete list.dataset.fade;
    };
    update();
    list.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(list);
    return () => {
      list.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [items.length]);

  return (
    <nav className={cx("ot-tabs", className)} aria-label={ariaLabel}>
      <ul className="ot-tabs__list" ref={listRef}>
        {items.map((item) => {
          const isSelected = item.key === selected;
          return (
            <li key={item.key} className="ot-tabs__item">
              <Link
                to={item.href}
                preventScrollReset={preventScrollReset}
                className={cx("ot-tabs__link", isSelected && "is-selected")}
                aria-current={isSelected ? "page" : undefined}
              >
                <span className="ot-tabs__label">{item.label}</span>
                {item.count !== undefined && item.count !== null ? (
                  <span className="ot-tabs__count">{item.count}</span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
