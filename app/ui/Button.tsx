import { forwardRef, type ButtonHTMLAttributes, type MouseEventHandler, type ReactNode, type Ref } from "react";
import { Link } from "react-router";
import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary" | "plain" | "critical";
export type ButtonSize = "sm" | "md";

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "onClick" | "children" | "variant"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Якщо задано — рендериться як <Link> з react-router. */
  to?: string;
  /** Для `to`: повне перезавантаження документа (напр. завантаження файлу). */
  reloadDocument?: boolean;
  type?: "button" | "submit" | "reset";
  /** Показує індикатор, ставить aria-busy і блокує кнопку. */
  loading?: boolean;
  fullWidth?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement | HTMLAnchorElement>;
  children?: ReactNode;
}

/** Кнопка або посилання у вигляді кнопки. Інші атрибути <button> передаються як є. */
export const Button = forwardRef<HTMLButtonElement | HTMLAnchorElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    to,
    reloadDocument,
    type = "button",
    loading = false,
    fullWidth = false,
    disabled,
    onClick,
    className,
    children,
    ...rest
  },
  ref,
) {
  const classes = cx(
    "ot-button",
    `ot-button--${variant}`,
    `ot-button--${size}`,
    fullWidth && "ot-button--full",
    loading && "is-loading",
    className,
  );
  const content = (
    <>
      {loading ? <span className="ot-button__spinner" aria-hidden="true" /> : null}
      <span className="ot-button__label">{children}</span>
    </>
  );

  // Неактивне посилання не має бути фокусованим <a> — рендеримо вимкнену кнопку.
  if (to !== undefined && !disabled && !loading) {
    return (
      <Link
        ref={ref as Ref<HTMLAnchorElement>}
        to={to}
        reloadDocument={reloadDocument}
        className={classes}
        onClick={onClick}
        id={rest.id}
        title={rest.title}
        aria-label={rest["aria-label"]}
        aria-describedby={rest["aria-describedby"]}
      >
        {content}
      </Link>
    );
  }

  return (
    <button
      {...rest}
      ref={ref as Ref<HTMLButtonElement>}
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      onClick={onClick}
    >
      {content}
    </button>
  );
});

export interface SpinnerProps {
  size?: "sm" | "md";
  /** Текст для екранних читачів, напр. «Завантаження…». */
  label: string;
}

/** Індикатор завантаження з доступною назвою. */
export function Spinner({ size = "md", label }: SpinnerProps) {
  return (
    <span className={cx("ot-spinner", `ot-spinner--${size}`)} role="status">
      <span className="ot-spinner__ring" aria-hidden="true" />
      <span className="ot-visually-hidden">{label}</span>
    </span>
  );
}
