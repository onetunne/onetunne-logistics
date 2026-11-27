/**
 * Константи модуля «Підготовка замовлень» (пакування) без імпорту схеми БД — їх використовують і сторінки
 * (клієнтський код). Відповідність схемі (orders.priority, PACKING_STATUSES) перевіряється на рівні типів.
 */
import type { OrderPriority, PackingStatus } from "~/db/schema";
import type { OrderStatus } from "~/domain/order-status";

/** Статуси замовлення в черзі пакування (накладна створена, ще не передано перевізнику). */
export const PACKING_QUEUE_STATUSES = ["waybill_created", "awaiting_picking", "packed"] as const satisfies readonly OrderStatus[];
export type PackingQueueStatus = (typeof PACKING_QUEUE_STATUSES)[number];

/** Статуси, з яких можна почати (або продовжити) комплектацію. */
export const STARTABLE_STATUSES = ["waybill_created", "awaiting_picking"] as const satisfies readonly OrderStatus[];

/** Вкладка «Потрібна накладна»: перевірені замовлення без активної накладної. */
export const NEEDS_WAYBILL_STATUSES = ["awaiting_review"] as const satisfies readonly OrderStatus[];

/** Пріоритет відправлення (orders.priority): 0 — звичайний, 1 — високий, 2 — терміновий. */
export const PRIORITIES = [0, 1, 2] as const satisfies readonly OrderPriority[];
export const PRIORITY_KEYS: Readonly<Record<OrderPriority, "normal" | "high" | "urgent">> = { 0: "normal", 1: "high", 2: "urgent" };

export function isPriority(value: unknown): value is OrderPriority {
  return typeof value === "number" && (PRIORITIES as readonly number[]).includes(value);
}

/** Пріоритет із поля форми ("0" | "1" | "2") або null. */
export function parsePriority(value: unknown): OrderPriority | null {
  if (typeof value !== "string" || !/^[0-2]$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return isPriority(n) ? n : null;
}

/** Активні стани пакування (одне на замовлення — частковий унікальний індекс order_packing_one_active_uq). */
export const ACTIVE_PACKING_STATUSES = ["queued", "in_progress", "packed"] as const satisfies readonly PackingStatus[];

/**
 * Причини ручної зміни кількості в чеклісті (коди — без вільного тексту: журнал без персональних даних).
 */
export const MANUAL_ADJUST_REASONS = ["barcode_unreadable", "no_barcode", "scanner_unavailable", "correction", "other"] as const;
export type ManualAdjustReason = (typeof MANUAL_ADJUST_REASONS)[number];

export function isManualAdjustReason(value: unknown): value is ManualAdjustReason {
  return typeof value === "string" && (MANUAL_ADJUST_REASONS as readonly string[]).includes(value);
}

/** Допуск розбіжності посилки з накладною: вага ±10 %, кожен габарит ±10 мм. */
export const PARCEL_WEIGHT_TOLERANCE_PERCENT = 10;
export const PARCEL_DIMENSION_TOLERANCE_MM = 10;

/** Межі введення (як у модулі «Упаковка»: габарити до 3000 мм; вага посилки до 100 кг). */
export const MAX_PARCEL_WEIGHT_GRAMS = 100_000;
export const MAX_PARCEL_DIMENSION_MM = 3000;

export const MAX_SCAN_LENGTH = 64;
/** Причина підтвердження без повного комплекту (рішення власника) — у історії замовлення. */
export const MAX_OVERRIDE_REASON_LENGTH = 300;

/** Масові дії черги. */
export const MAX_BULK_ORDERS = 100;
/** Друк пакувальних листів/інвойсів — замовлень за раз. */
export const MAX_PRINT_ORDERS = 50;
/** Об'єднаний PDF етикеток — замовлень за раз (кожна етикетка — окремий запит до перевізника). */
export const MAX_LABEL_ORDERS = 25;
/** Межі однієї етикетки в об'єднаному PDF (захист пам'яті сервера від завеликої/пошкодженої відповіді). */
export const MAX_LABEL_PAGES = 10;
/** Найбільший розмір однієї етикетки, байтів (як MAX_DOCUMENT_BYTES клієнта Nova Post). */
export const MAX_LABEL_BYTES = 5 * 1024 * 1024;
/** PNG: найбільша площа зображення, пікселів (декодується повністю в RGBA). */
export const MAX_LABEL_PNG_PIXELS = 25_000_000;
/** Загальний час отримання етикеток одного пакета (менше за типові тайм-аути проксі/браузера 60–100 с). */
export const LABEL_BATCH_DEADLINE_MS = 45_000;
/** Список передачі перевізнику — посилок за раз. */
export const MAX_HANDOVER_ORDERS = 200;
/** Зведений лист комплектації (pick list) — замовлень за раз. */
export const MAX_PICK_LIST_ORDERS = 100;

/** Чому вибране замовлення не включено до листа комплектації. */
export const PICK_LIST_SKIP_REASONS = ["packed", "not_in_queue", "fulfilled_in_shopify"] as const;
export type PickListSkipReason = (typeof PICK_LIST_SKIP_REASONS)[number];

/**
 * Типи подій пакування в історії замовлення (shipment_events активної накладної; без неї — останньої).
 * packing_cancelled — замовлення скасовано (пакування закрито); packing_returned — склад повернув товар скасованого
 * замовлення на полицю; packing_skipped_handover — передано перевізнику без «Запаковано»; packed_at_handover —
 * власник підтвердив пакування під час ручної передачі (lifecycle.server.ts).
 */
export const PACKING_EVENT_TYPES = [
  "packing_started",
  "packed",
  "packed_override",
  "unpacked",
  "packing_cancelled",
  "packing_returned",
  "packing_skipped_handover",
  "packed_at_handover",
] as const;
export type PackingEventType = (typeof PACKING_EVENT_TYPES)[number];

/** Документи пакетного друку. */
export const PRINT_DOCUMENTS = ["slip", "invoice"] as const;
export type PrintDocument = (typeof PRINT_DOCUMENTS)[number];

/** Причини, з яких етикетку не додано до об'єднаного PDF. */
export const LABEL_SKIP_REASONS = [
  "not_in_queue",
  "no_waybill",
  "not_supported",
  "carrier_error",
  "encrypted",
  "invalid_pdf",
  "unsupported_format",
  /** Етикетка завелика (сторінок/пікселів/байтів понад межу) — друк окремо з картки замовлення. */
  "too_large",
  /** Загальний час запиту вичерпано (LABEL_BATCH_DEADLINE_MS) — решту етикеток надрукувати наступним пакетом. */
  "timeout",
] as const;
export type LabelSkipReason = (typeof LABEL_SKIP_REASONS)[number];

type Exhaustive<All, Listed> = [Exclude<All, Listed>] extends [never] ? true : false;
const prioritiesComplete: Exhaustive<OrderPriority, (typeof PRIORITIES)[number]> = true;
void prioritiesComplete;
