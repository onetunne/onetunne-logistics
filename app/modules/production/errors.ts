import { DomainError } from "~/lib/errors";

/**
 * Помилки полів форми партії/надходження: { [ім'я поля]: ключ i18n }.
 * Імена полів — як у формах сторінок: title, plannedReadyDate, manufacturer, notes, extraCost, costCurrency,
 * qty.<variantId>, cost.<variantId>, lines, good.<lineId>, defective.<lineId>, reason.<lineId>, note.
 */
export class ProductionValidationError extends DomainError {
  constructor(readonly fieldErrors: Record<string, string>) {
    super("error.validation", 400);
    this.name = "ProductionValidationError";
  }
}

/** Коди помилок модуля (ключі i18n у app/i18n/messages/production.ts). */
export const PRODUCTION_ERRORS = {
  invalidStatus: "production.error.invalidStatus",
  noLines: "production.error.noLines",
  overReceipt: "production.error.overReceipt",
  emptyReceipt: "production.error.emptyReceipt",
  receiptKey: "production.error.receiptKey",
  cannotCancel: "production.error.cannotCancel",
  numberConflict: "production.error.numberConflict",
} as const;

export const FIELD_ERRORS = {
  required: "production.fieldError.required",
  tooLong: "production.fieldError.tooLong",
  invalidDate: "production.fieldError.invalidDate",
  invalidQuantity: "production.fieldError.invalidQuantity",
  invalidMoney: "production.fieldError.invalidMoney",
  invalidCurrency: "production.fieldError.invalidCurrency",
  duplicate: "production.fieldError.duplicate",
  tooManyLines: "production.fieldError.tooManyLines",
  noLines: "production.fieldError.noLines",
} as const;
