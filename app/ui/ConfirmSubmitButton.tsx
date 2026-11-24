import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "./Button";
import { cx } from "./cx";
import { lockPageScroll } from "./internal";

export interface ConfirmSubmitButtonProps {
  children?: ReactNode;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  /** Вигляд кнопки-тригера. За замовчуванням "secondary". */
  variant?: ButtonVariant;
  /** Вигляд кнопки підтвердження. За замовчуванням "critical" для critical-тригера, інакше "primary". */
  confirmVariant?: ButtonVariant;
  size?: ButtonSize;
  /** name/value кнопки підтвердження (type="submit") — потрапляють у formData. */
  name?: string;
  value?: string;
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  /** id форми, якщо кнопка розміщена поза нею. */
  form?: string;
  "aria-label"?: string;
  className?: string;
}

/**
 * Кнопка з підтвердженням для небезпечних та масових дій.
 * Тригер (type="button") відкриває модальний <dialog> (showModal); «Підтвердити» — type="submit"
 * з name/value і знаходиться всередині батьківської форми (або пов'язаний через атрибут form),
 * тож відправляє її звичайним способом (працює і з <Form> react-router).
 * Фокус: при відкритті — на «Скасувати» (безпечна дія), після закриття — повертається на тригер.
 */
export function ConfirmSubmitButton({
  children,
  title,
  message,
  confirmLabel,
  cancelLabel,
  variant = "secondary",
  confirmVariant,
  size = "md",
  name,
  value,
  disabled,
  loading,
  fullWidth,
  form,
  "aria-label": ariaLabel,
  className,
}: ConfirmSubmitButtonProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement | HTMLAnchorElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const messageId = `${baseId}-message`;

  // Поки діалог відкритий — блокуємо прокрутку сторінки під ним.
  useEffect(() => {
    if (!open) return;
    return lockPageScroll();
  }, [open]);

  // Закрити діалог, якщо компонент зникає (напр. після навігації).
  useEffect(() => {
    const dialog = dialogRef.current;
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  const handleClose = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const openDialog = () => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open || disabled || loading) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    setOpen(true);
    cancelRef.current?.focus();
  };

  const closeDialog = () => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.close === "function") {
      if (dialog.open) dialog.close();
    } else {
      dialog.removeAttribute("open");
      handleClose();
    }
  };

  // Клік по підкладці (поза панеллю) закриває діалог.
  const onDialogClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) closeDialog();
  };

  // Закриваємо після того, як браузер почав відправлення форми (кнопка лишається у формі).
  const onConfirmClick = () => {
    window.setTimeout(closeDialog, 0);
  };

  const resolvedConfirmVariant = confirmVariant ?? (variant === "critical" ? "critical" : "primary");

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant={variant}
        size={size}
        disabled={disabled}
        loading={loading}
        fullWidth={fullWidth}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={className}
        onClick={openDialog}
      >
        {children}
      </Button>
      <dialog
        ref={dialogRef}
        className="ot-dialog"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        onClose={handleClose}
        onClick={onDialogClick}
      >
        <div className="ot-dialog__panel">
          <h2 id={titleId} className="ot-dialog__title">
            {title}
          </h2>
          <div id={messageId} className="ot-dialog__message">
            {message}
          </div>
          <div className="ot-dialog__actions">
            <button
              ref={cancelRef}
              type="button"
              className="ot-button ot-button--secondary ot-button--md"
              onClick={closeDialog}
            >
              <span className="ot-button__label">{cancelLabel}</span>
            </button>
            <button
              type="submit"
              name={name}
              value={value}
              form={form}
              className={cx("ot-button", `ot-button--${resolvedConfirmVariant}`, "ot-button--md")}
              onClick={onConfirmClick}
            >
              <span className="ot-button__label">{confirmLabel}</span>
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
