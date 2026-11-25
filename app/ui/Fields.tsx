import type { ChangeEvent, HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";
import { ChevronDownIcon, CriticalIcon, fieldIdFromName } from "./internal";

/** Ідентифікатори допоміжного тексту та помилки для aria-describedby. */
function describe(fieldId: string, helpText: ReactNode, error: string | null | undefined) {
  const helpId = helpText ? `${fieldId}-help` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  const describedBy = [errorId, helpId].filter(Boolean).join(" ") || undefined;
  return { helpId, errorId, describedBy };
}

function FieldLabel({
  htmlFor,
  required,
  hidden,
  children,
}: {
  htmlFor: string;
  required?: boolean;
  hidden?: boolean;
  children: ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className={cx("ot-field__label", hidden && "ot-visually-hidden")}>
      {children}
      {required ? (
        <span className="ot-field__required" aria-hidden="true">
          {" *"}
        </span>
      ) : null}
    </label>
  );
}

function FieldMessages({
  helpId,
  errorId,
  helpText,
  error,
}: {
  helpId?: string;
  errorId?: string;
  helpText: ReactNode;
  error: string | null | undefined;
}) {
  return (
    <>
      {helpText ? (
        <div id={helpId} className="ot-field__help">
          {helpText}
        </div>
      ) : null}
      {error ? (
        <p id={errorId} className="ot-field__error">
          <CriticalIcon width={16} height={16} />
          <span>{error}</span>
        </p>
      ) : null}
    </>
  );
}

export type TextFieldType = "text" | "email" | "tel" | "number" | "password" | "search" | "url" | "date";

export interface TextFieldProps {
  label: string;
  name: string;
  defaultValue?: string | number | null;
  /** Керований режим (разом з onChange). */
  value?: string | number | null;
  onChange?: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  type?: TextFieldType;
  error?: string | null;
  helpText?: ReactNode;
  required?: boolean;
  autoComplete?: string;
  inputMode?: HTMLAttributes<HTMLInputElement>["inputMode"];
  placeholder?: string;
  readOnly?: boolean;
  disabled?: boolean;
  maxLength?: number;
  min?: number | string;
  max?: number | string;
  step?: number | string;
  pattern?: string;
  id?: string;
  /** Атрибут form — поле належить формі з цим id. */
  form?: string;
  /** Багаторядкове поле (textarea) з указаною кількістю рядків. */
  multiline?: number;
  /** Текст/одиниця всередині поля праворуч (напр. «кг», «см»). */
  suffix?: ReactNode;
  /** Текст всередині поля ліворуч (напр. «+380», «₴»). */
  prefix?: ReactNode;
  /** Сховати підпис візуально (залишається для екранних читачів). */
  labelHidden?: boolean;
  spellCheck?: boolean;
  autoCapitalize?: string;
  className?: string;
}

/**
 * Текстове поле з підписом, підказкою та помилкою (aria-describedby / aria-invalid).
 * id за замовчуванням виводиться з name — якщо одне ім'я повторюється на сторінці, передайте id.
 */
export function TextField({
  label,
  name,
  defaultValue,
  value,
  onChange,
  type = "text",
  error,
  helpText,
  required,
  autoComplete,
  inputMode,
  placeholder,
  readOnly,
  disabled,
  maxLength,
  min,
  max,
  step,
  pattern,
  id,
  form,
  multiline,
  suffix,
  prefix,
  labelHidden,
  spellCheck,
  autoCapitalize,
  className,
}: TextFieldProps) {
  const fieldId = id ?? fieldIdFromName(name);
  const { helpId, errorId, describedBy } = describe(fieldId, helpText, error);
  const controlled = value !== undefined;
  const valueProps = controlled
    ? { value: value ?? "", onChange }
    : { defaultValue: defaultValue ?? undefined, onChange };
  const common = {
    id: fieldId,
    name,
    className: "ot-input",
    required,
    placeholder,
    readOnly,
    disabled,
    maxLength,
    form,
    autoComplete,
    spellCheck,
    autoCapitalize,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
    ...valueProps,
  };
  const resolvedInputMode = inputMode ?? (type === "number" ? "decimal" : undefined);

  return (
    <div
      className={cx(
        "ot-field",
        error && "ot-field--invalid",
        disabled && "is-disabled",
        readOnly && "is-readonly",
        className,
      )}
    >
      <FieldLabel htmlFor={fieldId} required={required} hidden={labelHidden}>
        {label}
      </FieldLabel>
      <div className={cx("ot-input-wrap", multiline !== undefined && "ot-input-wrap--multiline")}>
        {prefix ? (
          <span className="ot-input-affix ot-input-affix--prefix" aria-hidden="true">
            {prefix}
          </span>
        ) : null}
        {multiline !== undefined ? (
          <textarea {...common} rows={Math.max(2, multiline)} />
        ) : (
          <input {...common} type={type} inputMode={resolvedInputMode} min={min} max={max} step={step} pattern={pattern} />
        )}
        {suffix ? (
          <span className="ot-input-affix ot-input-affix--suffix" aria-hidden="true">
            {suffix}
          </span>
        ) : null}
      </div>
      <FieldMessages helpId={helpId} errorId={errorId} helpText={helpText} error={error} />
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  label: string;
  name: string;
  options: SelectOption[];
  defaultValue?: string;
  /** Керований режим (разом з onChange). */
  value?: string;
  error?: string | null;
  helpText?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  id?: string;
  form?: string;
  /** Перший порожній варіант (value=""), напр. «Оберіть країну». */
  placeholder?: string;
  labelHidden?: boolean;
  onChange?: (event: ChangeEvent<HTMLSelectElement>) => void;
  className?: string;
}

/** Нативний список вибору (найкраще працює на iPhone). */
export function Select({
  label,
  name,
  options,
  defaultValue,
  value,
  error,
  helpText,
  required,
  disabled,
  id,
  form,
  placeholder,
  labelHidden,
  onChange,
  className,
}: SelectProps) {
  const fieldId = id ?? fieldIdFromName(name);
  const { helpId, errorId, describedBy } = describe(fieldId, helpText, error);
  const valueProps = value !== undefined ? { value } : { defaultValue };
  return (
    <div className={cx("ot-field", error && "ot-field--invalid", disabled && "is-disabled", className)}>
      <FieldLabel htmlFor={fieldId} required={required} hidden={labelHidden}>
        {label}
      </FieldLabel>
      <div className="ot-select">
        <select
          id={fieldId}
          name={name}
          className="ot-select__control"
          required={required}
          disabled={disabled}
          form={form}
          onChange={onChange}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          {...valueProps}
        >
          {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDownIcon className="ot-select__chevron" width={16} height={16} />
      </div>
      <FieldMessages helpId={helpId} errorId={errorId} helpText={helpText} error={error} />
    </div>
  );
}

export interface CheckboxProps {
  label: ReactNode;
  name: string;
  value?: string;
  defaultChecked?: boolean;
  /** Керований режим (разом з onChange). */
  checked?: boolean;
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
  helpText?: ReactNode;
  error?: string | null;
  disabled?: boolean;
  id?: string;
  form?: string;
  className?: string;
}

/** Прапорець з підписом; уся область підпису клікабельна (≥ 44px на мобільному). */
export function Checkbox({
  label,
  name,
  value,
  defaultChecked,
  checked,
  onChange,
  helpText,
  error,
  disabled,
  id,
  form,
  className,
}: CheckboxProps) {
  const fieldId = id ?? fieldIdFromName(name, value);
  const { helpId, errorId, describedBy } = describe(fieldId, helpText, error);
  const checkedProps = checked !== undefined ? { checked } : { defaultChecked };
  return (
    <div className={cx("ot-checkbox-field", error && "ot-field--invalid", disabled && "is-disabled", className)}>
      <label className="ot-checkbox" htmlFor={fieldId}>
        <input
          type="checkbox"
          id={fieldId}
          name={name}
          value={value}
          disabled={disabled}
          form={form}
          onChange={onChange}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          {...checkedProps}
        />
        <span className="ot-checkbox__label">{label}</span>
      </label>
      <FieldMessages helpId={helpId} errorId={errorId} helpText={helpText} error={error} />
    </div>
  );
}
