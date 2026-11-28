import { useState, type ChangeEvent, type ReactNode } from "react";
import { cx } from "./cx";
import { CriticalIcon, fieldIdFromName } from "./internal";

/** Опис файлу для повідомлень (без вмісту). */
export interface FileInputFile {
  name: string;
  size: number;
}

export interface FileInputProps {
  label: string;
  name: string;
  /** Розширення / типи для `accept` (напр. ".xlsx,.csv"). Розширення додатково перевіряються в браузері. */
  accept?: string;
  /** Ліміт розміру в байтах — перевірка в браузері до надсилання (сервер перевіряє сам, напр. 413). */
  maxBytes?: number;
  /** Текст кнопки вибору («Виберіть файл»). */
  buttonLabel: string;
  /** Текст кнопки, коли файл уже вибрано («Вибрати інший файл»); типово — buttonLabel. */
  changeLabel?: string;
  /** Текст, коли файл не вибрано («Файл не вибрано»). */
  emptyLabel: string;
  /** Опис вибраного файлу (назва й розмір); типово — назва. */
  describeFile?: (file: FileInputFile) => string;
  /** Повідомлення, коли файл більший за maxBytes (без нього браузер файл не відхиляє — вирішує сервер). */
  tooLargeMessage?: (file: FileInputFile) => string;
  /** Повідомлення, коли розширення не з accept (без нього браузер файл не відхиляє — вирішує сервер). */
  wrongTypeMessage?: (file: FileInputFile) => string;
  helpText?: ReactNode;
  /** Помилка від сервера (показується, якщо немає власної помилки браузера). */
  error?: string | null;
  required?: boolean;
  disabled?: boolean;
  id?: string;
  /** Атрибут form — поле належить формі з цим id. */
  form?: string;
  /** Файл, який сторінка тримає між кроками майстра (лише показ назви; вміст надсилає сторінка). */
  selectedFile?: FileInputFile | null;
  /** Викликається з вибраним файлом або null (скасовано / відхилено перевіркою). */
  onFileChange?: (file: File | null) => void;
  /** Сховати підпис візуально (лишається для читачів екрана). */
  labelHidden?: boolean;
  className?: string;
}

/** Розширення з `accept` (".xlsx,.csv" → [".xlsx", ".csv"]); MIME-типи ігноруються. */
export function acceptedExtensions(accept: string | undefined): string[] {
  return (accept ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.startsWith("."));
}

/** Перевірка файлу в браузері: "tooLarge" / "wrongType" / null. Вміст не читається. */
export function checkFile(file: FileInputFile, opts: { accept?: string; maxBytes?: number }): "tooLarge" | "wrongType" | null {
  const exts = acceptedExtensions(opts.accept);
  if (exts.length > 0 && !exts.some((e) => file.name.toLowerCase().endsWith(e))) return "wrongType";
  if (opts.maxBytes !== undefined && file.size > opts.maxBytes) return "tooLarge";
  return null;
}

/**
 * Поле вибору файлу: справжній `<input type="file">` (працює з «Файли» iPhone і клавіатурою), оформлений як кнопка
 * UI-кіту, з назвою вибраного файлу, підказкою й помилкою (aria-describedby / aria-invalid). Завеликий файл або файл
 * не того типу відхиляється ще в браузері: поле очищається, onFileChange(null), показується повідомлення.
 * Файл не читається і не зберігається — його надсилає форма або сторінка.
 */
export function FileInput({
  label,
  name,
  accept,
  maxBytes,
  buttonLabel,
  changeLabel,
  emptyLabel,
  describeFile,
  tooLargeMessage,
  wrongTypeMessage,
  helpText,
  error,
  required,
  disabled,
  id,
  form,
  selectedFile,
  onFileChange,
  labelHidden,
  className,
}: FileInputProps) {
  const fieldId = id ?? fieldIdFromName(name);
  const [chosen, setChosen] = useState<FileInputFile | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const shown = chosen ?? selectedFile ?? null;
  const message = localError ?? error ?? null;
  const helpId = helpText ? `${fieldId}-help` : undefined;
  const errorId = message ? `${fieldId}-error` : undefined;
  const statusId = `${fieldId}-status`;
  const describedBy = [statusId, errorId, helpId].filter(Boolean).join(" ");

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0] ?? null;
    if (!file) {
      setChosen(null);
      setLocalError(null);
      onFileChange?.(null);
      return;
    }
    const info = { name: file.name, size: file.size };
    const problem = checkFile(info, { accept, maxBytes });
    // Відхиляємо в браузері лише з поясненням (повідомлення передає сторінка); інакше вирішує сервер.
    const problemMessage = problem === "tooLarge" ? tooLargeMessage?.(info) : problem === "wrongType" ? wrongTypeMessage?.(info) : undefined;
    if (problemMessage) {
      input.value = "";
      setChosen(null);
      setLocalError(problemMessage);
      onFileChange?.(null);
      return;
    }
    setChosen(info);
    setLocalError(null);
    onFileChange?.(file);
  };

  return (
    <div className={cx("ot-field", "ot-file", message && "ot-field--invalid", disabled && "is-disabled", className)}>
      <label htmlFor={fieldId} className={cx("ot-field__label", labelHidden && "ot-visually-hidden")}>
        {label}
        {required ? (
          <span className="ot-field__required" aria-hidden="true">
            {" *"}
          </span>
        ) : null}
      </label>
      <div className="ot-file__control">
        {/* Справжнє поле лежить прозорим над кнопкою: дотик/клік відкриває вибір файлу системи (iPhone «Файли»),
            фокус клавіатури показується на кнопці (styles.css). */}
        <span className="ot-file__picker">
          <input
            id={fieldId}
            name={name}
            type="file"
            className="ot-file__input"
            accept={accept}
            required={required}
            disabled={disabled}
            form={form}
            onChange={onChange}
            aria-invalid={message ? true : undefined}
            aria-describedby={describedBy}
          />
          <span className="ot-button ot-button--secondary ot-file__button" aria-hidden="true">
            {shown ? (changeLabel ?? buttonLabel) : buttonLabel}
          </span>
        </span>
        <span id={statusId} className={cx("ot-file__name", !shown && "is-empty")}>
          {shown ? (describeFile ? describeFile(shown) : shown.name) : emptyLabel}
        </span>
      </div>
      {helpText ? (
        <div id={helpId} className="ot-field__help">
          {helpText}
        </div>
      ) : null}
      {message ? (
        <p id={errorId} className="ot-field__error" role="alert">
          <CriticalIcon width={16} height={16} />
          <span>{message}</span>
        </p>
      ) : null}
    </div>
  );
}
