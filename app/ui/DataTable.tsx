import { useRef, type ChangeEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { cx } from "./cx";

export interface DataTableColumn<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: "start" | "end" | "center";
  /** Основна колонка: заголовок мобільної картки і посилання на рядок. За замовчуванням — перша колонка. */
  primary?: boolean;
  /** Не показувати в мобільній картці (< 768px). */
  hideOnMobile?: boolean;
  /** Ширина колонки в таблиці (CSS), напр. "120px" або "20%". */
  width?: string;
}

export interface DataTableSelection<T> {
  /** Ім'я поля форми для вибраних рядків (formData.getAll(name)). */
  name: string;
  value: (row: T) => string;
  /** Доступна назва прапорця рядка, напр. «Вибрати #1001». */
  label: (row: T) => string;
  /** id форми, якій належать прапорці (атрибут form). */
  formId?: string;
  /** Початково вибрані рядки. */
  defaultChecked?: (row: T) => boolean;
  /** Підпис прапорця «вибрати все» (якщо задано — прапорець показується). */
  allLabel?: string;
  /** Викликається на клієнті після кожної зміни з переліком вибраних значень. */
  onChange?: (values: string[]) => void;
}

export interface DataTableProps<T> {
  columns: Array<DataTableColumn<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  /** Посилання з основної комірки рядка. */
  rowHref?: (row: T) => string;
  selection?: DataTableSelection<T>;
  emptyState?: ReactNode;
  /** Назва таблиці для екранних читачів. */
  caption?: string;
  className?: string;
}

const ROW_SELECT_ATTR = "data-ot-row-select";
const ALL_SELECT_ATTR = "data-ot-select-all";

/**
 * Адаптивна таблиця: справжня <table> на ширині ≥ 768px; нижче кожен рядок
 * відображається як картка (основна колонка — заголовок, інші — рядки «назва: значення»).
 * Розмітка одна для обох режимів, тож прапорці вибору не дублюються у formData.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowHref,
  selection,
  emptyState,
  caption,
  className,
}: DataTableProps<T>) {
  const rootRef = useRef<HTMLDivElement>(null);

  if (rows.length === 0) {
    return emptyState ? <div className="ot-dt__empty">{emptyState}</div> : null;
  }

  const explicitPrimary = columns.findIndex((column) => column.primary);
  const primaryIndex = explicitPrimary === -1 ? 0 : explicitPrimary;

  // Синхронізація «вибрати все» та повідомлення про вибір — лише в обробниках подій (SSR-безпечно).
  const syncSelection = () => {
    const root = rootRef.current;
    if (!root) return;
    const boxes = Array.from(root.querySelectorAll<HTMLInputElement>(`input[${ROW_SELECT_ATTR}]`)).filter(
      (box) => !box.disabled,
    );
    const checked = boxes.filter((box) => box.checked);
    for (const all of Array.from(root.querySelectorAll<HTMLInputElement>(`input[${ALL_SELECT_ATTR}]`))) {
      all.checked = boxes.length > 0 && checked.length === boxes.length;
      all.indeterminate = checked.length > 0 && checked.length < boxes.length;
    }
    selection?.onChange?.(checked.map((box) => box.value));
  };

  const onSelectAll = (event: ChangeEvent<HTMLInputElement>) => {
    const root = rootRef.current;
    if (!root) return;
    const next = event.currentTarget.checked;
    for (const box of Array.from(root.querySelectorAll<HTMLInputElement>(`input[${ROW_SELECT_ATTR}]`))) {
      if (!box.disabled) box.checked = next;
    }
    syncSelection();
  };

  const selectAllProps = { [ALL_SELECT_ATTR]: "" };
  const rowSelectProps = { [ROW_SELECT_ATTR]: "" };

  return (
    <div ref={rootRef} className={cx("ot-dt", selection && "ot-dt--selectable", className)}>
      {selection?.allLabel ? (
        <div className="ot-dt__toolbar">
          <label className="ot-checkbox">
            <input type="checkbox" onChange={onSelectAll} {...selectAllProps} />
            <span className="ot-checkbox__label">{selection.allLabel}</span>
          </label>
        </div>
      ) : null}
      <div className="ot-dt__scroll">
        <table className="ot-dt__table">
          {caption ? <caption className="ot-visually-hidden">{caption}</caption> : null}
          <thead>
            <tr>
              {selection ? (
                <th scope="col" className="ot-dt__th ot-dt__cell--select">
                  {selection.allLabel ? (
                    <label className="ot-dt__select">
                      <input type="checkbox" onChange={onSelectAll} aria-label={selection.allLabel} {...selectAllProps} />
                    </label>
                  ) : null}
                </th>
              ) : null}
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={cx("ot-dt__th", `ot-dt__cell--${column.align ?? "start"}`)}
                  style={column.width ? { width: column.width } : undefined}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const key = rowKey(row);
              const href = rowHref?.(row);
              return (
                <tr key={key} className="ot-dt__row">
                  {selection ? (
                    <td className="ot-dt__cell ot-dt__cell--select">
                      <label className="ot-dt__select">
                        <input
                          type="checkbox"
                          name={selection.name}
                          value={selection.value(row)}
                          form={selection.formId}
                          defaultChecked={selection.defaultChecked?.(row)}
                          onChange={syncSelection}
                          {...rowSelectProps}
                        />
                        <span className="ot-visually-hidden">{selection.label(row)}</span>
                      </label>
                    </td>
                  ) : null}
                  {columns.map((column, index) => {
                    const isPrimary = index === primaryIndex;
                    const content = column.render(row);
                    const cellClass = cx(
                      "ot-dt__cell",
                      `ot-dt__cell--${column.align ?? "start"}`,
                      isPrimary && "ot-dt__cell--primary",
                      column.hideOnMobile && !isPrimary && "ot-dt__cell--hide-mobile",
                    );
                    if (isPrimary) {
                      return (
                        <th key={column.key} scope="row" className={cellClass}>
                          {href ? (
                            <Link to={href} className="ot-dt__link">
                              {content}
                            </Link>
                          ) : (
                            content
                          )}
                        </th>
                      );
                    }
                    return (
                      <td key={column.key} className={cellClass}>
                        <span className="ot-dt__label">{column.header}</span>
                        <span className="ot-dt__value">{content}</span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
