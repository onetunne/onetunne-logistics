import type { ReactNode } from "react";

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}

/** Порожній стан списку/розділу — без ілюстрацій, лише текст і дія. */
export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="ot-empty">
      <p className="ot-empty__title">{title}</p>
      {description ? <div className="ot-empty__description">{description}</div> : null}
      {action ? <div className="ot-empty__action">{action}</div> : null}
    </div>
  );
}
