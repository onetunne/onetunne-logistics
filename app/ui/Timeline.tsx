import type { ReactNode } from "react";
import { cx } from "./cx";

export type TimelineTone = "default" | "success" | "warning" | "critical";

export interface TimelineItem {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  time: ReactNode;
  tone?: TimelineTone;
}

export interface TimelineProps {
  items: TimelineItem[];
  className?: string;
}

/** Хронологія подій (історія замовлення, журнал дій, трекінг). */
export function Timeline({ items, className }: TimelineProps) {
  if (items.length === 0) return null;
  return (
    <ol className={cx("ot-timeline", className)}>
      {items.map((item) => (
        <li key={item.id} className={cx("ot-timeline__item", `ot-timeline__item--${item.tone ?? "default"}`)}>
          <span className="ot-timeline__dot" aria-hidden="true" />
          <div className="ot-timeline__body">
            <div className="ot-timeline__head">
              <span className="ot-timeline__title">{item.title}</span>
              <span className="ot-timeline__time">{item.time}</span>
            </div>
            {item.description ? <div className="ot-timeline__description">{item.description}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
