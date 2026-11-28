/**
 * Етап 6, WP0-UI: поле файлу для фінансів (§7.3, §18.5) — `FileInput` UI-кіту з текстами uk/en і розміром у
 * «КБ / МБ»: «Виберіть файл», «Файл не вибрано», «Файл завеликий (14 МБ). Максимум — 10 МБ.», «Цей тип файлу не
 * підтримується. Підходять: .xlsx, .csv.». Сервер не довіряє цій перевірці (ліміт тіла, «магічні» байти — WP5).
 */
import type { ReactNode } from "react";
import { type Locale, makeT, type TFunction, useLocale } from "~/i18n";
import { formatDecimal } from "~/lib/format";
import { FileInput, acceptedExtensions, type FileInputFile } from "~/ui";

const KB = 1024;
const MB = 1024 * 1024;

/** Розмір файлу: «512 Б», «12,5 КБ», «14 МБ» (1 знак, без «,0»). */
export function formatFileSize(bytes: number, locale: Locale, ft: TFunction = makeT(locale)): string {
  const b = Math.max(0, Math.floor(bytes));
  if (b < KB) return ft("financeUi.file.size.b", { n: formatDecimal(b, locale, { maximumFractionDigits: 0 }) });
  const unit = b < MB ? "kb" : "mb";
  const tenths = Math.round((b * 10) / (unit === "kb" ? KB : MB));
  return ft(`financeUi.file.size.${unit}`, { n: formatDecimal(tenths / 10, locale, { maximumFractionDigits: 1 }) });
}

export interface FinanceFileInputProps {
  label: string;
  name: string;
  /** Типово ".xlsx,.csv" (§7.3). */
  accept?: string;
  /** Ліміт у байтах (§7.3: 10 МБ = 10 × 1024 × 1024). */
  maxBytes?: number;
  helpText?: ReactNode;
  error?: string | null;
  required?: boolean;
  disabled?: boolean;
  id?: string;
  form?: string;
  selectedFile?: FileInputFile | null;
  onFileChange?: (file: File | null) => void;
}

export function FinanceFileInput({ accept = ".xlsx,.csv", maxBytes, ...rest }: FinanceFileInputProps) {
  const locale = useLocale();
  const ft = makeT(locale);
  const size = (n: number) => formatFileSize(n, locale, ft);
  const types = acceptedExtensions(accept).join(", ");
  return (
    <FileInput
      {...rest}
      accept={accept}
      maxBytes={maxBytes}
      buttonLabel={ft("financeUi.file.choose")}
      changeLabel={ft("financeUi.file.change")}
      emptyLabel={ft("financeUi.file.none")}
      describeFile={(f) => `${f.name} · ${size(f.size)}`}
      tooLargeMessage={maxBytes !== undefined ? (f) => ft("financeUi.file.tooLarge", { size: size(f.size), max: size(maxBytes) }) : undefined}
      wrongTypeMessage={types ? () => ft("financeUi.file.wrongType", { types }) : undefined}
    />
  );
}
