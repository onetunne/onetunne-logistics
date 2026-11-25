import type { ReactNode } from "react";
import { cx } from "./cx";

export interface KeyValueItem {
  label: ReactNode;
  value: ReactNode;
  /** Стабільний ключ рядка (за замовчуванням — індекс). */
  key?: string;
}

export interface KeyValueListProps {
  items: KeyValueItem[];
  className?: string;
}

/** Список «назва — значення» (<dl>): деталі замовлення, адреса, параметри посилки. */
export function KeyValueList({ items, className }: KeyValueListProps) {
  if (items.length === 0) return null;
  return (
    <dl className={cx("ot-kv", className)}>
      {items.map((item, index) => (
        <div className="ot-kv__row" key={item.key ?? index}>
          <dt className="ot-kv__label">{item.label}</dt>
          <dd className="ot-kv__value">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
