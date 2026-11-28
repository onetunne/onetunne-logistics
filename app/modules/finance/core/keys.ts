/**
 * Етап 6: ключі ідемпотентності фінансового журналу, оцінок складу й завдань (docs/stage6-design.md §14.5).
 * ЄДИНЕ місце, де складаються ключі: одна бізнес-подія = один ключ; виправлення — сторно `<ключ>:rev` + новий ключ
 * з наступною версією (`:v<n>` / `:m<n>`). Ключі будуються з глобальних id (uuid, GID) — без персональних даних.
 * Довжина ключа запису ≤ 200 (CHECK finance_entries_key_len_chk).
 *
 * ПОКОЛІННЯ (F2 + §2.5): факт без власної версії (продаж, комісія, оцінка складу, виплата…) може бути сторнований і
 * ЗНОВУ стати чинним (тестове замовлення при перемиканні `finance.includeTestOrders`, замовлення excluded →
 * recognized). Повторне проведення того самого ключа ON CONFLICT DO NOTHING пропустило б — сума зникла б мовчки. Тому
 * кожен ключ факту має покоління: 1 — базовий ключ у форматі §14.5 (без суфікса), n > 1 — `<базовий>:g<n>`
 * (`withGeneration`). Наступне покоління обирає ЛИШЕ ядро — `repostEntries` (entries.server.ts): якщо діє будь-яке
 * покоління — пропуск, інакше 1 + найбільше наявне. Сторно покоління n — `<базовий>:g<n>:rev`.
 */

export const MAX_FINANCE_KEY_LENGTH = 200;

const v = (n: number) => {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`version must be a positive integer, got ${n}`);
  return `v${n}`;
};

/** Суфікс-частина ключа: короткий код; не `rev` і не `g<n>` (інакше ключ сплутався б зі сторно чи поколінням). */
const PART_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const RESERVED_PART_RE = /^(?:rev|g\d+)$/;
const withPart = (key: string, part?: string) => {
  if (part === undefined || part === "") return key;
  if (!PART_RE.test(part) || RESERVED_PART_RE.test(part)) throw new RangeError(`invalid key part: ${part.slice(0, 40)}`);
  return `${key}:${part}`;
};

/** Суфікс покоління наприкінці ключа (`:g2`, `:g13`). */
const GENERATION_SUFFIX_RE = /:g[1-9]\d*$/;

/**
 * Ключ покоління `generation` базового ключа: 1 → сам базовий ключ (формат §14.5), n > 1 → `<базовий>:g<n>`.
 * Базовий ключ не може бути сторно чи вже ключем покоління.
 */
export function withGeneration(baseKey: string, generation = 1): string {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new RangeError(`generation must be a positive integer, got ${generation}`);
  if (!isBaseFactKey(baseKey)) throw new RangeError("a reversal or generation key cannot be a base key");
  return generation === 1 ? baseKey : `${baseKey}:g${generation}`;
}

/** Покоління ключа `key` відносно `baseKey`: 1 — сам базовий, n — `<базовий>:g<n>` (n ≥ 2); інакше null. */
export function generationOf(key: string, baseKey: string): number | null {
  if (key === baseKey) return 1;
  const prefix = `${baseKey}:g`;
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  if (!/^[1-9]\d*$/.test(rest)) return null;
  const n = Number(rest);
  return Number.isSafeInteger(n) && n >= 2 ? n : null;
}

/** Базовий ключ факту (не сторно, без суфікса покоління)? */
export function isBaseFactKey(key: string): boolean {
  return typeof key === "string" && key.length > 0 && !isReversalKey(key) && !GENERATION_SUFFIX_RE.test(key);
}

const gen = (key: string, generation = 1) => withGeneration(key, generation);

/** Ключі записів finance_entries. `part` — суфікс для кількох записів однієї події (напр. категорія). */
export const financeKeys = {
  /** Продаж угоди Shopify: нетто (без податку), податок (tax_collected_memo), знижка (discount_memo). */
  sale: (saleId: string, part: "net" | "tax" | "disc", generation?: number) => gen(`sale:${saleId}:${part}`, generation),
  /** Комісія транзакції Shopify Payments (TransactionFee.id). */
  fee: (feeId: string, generation?: number) => gen(`fee:${feeId}`, generation),
  /** Коригування курсу транзакції Shopify (довідково). */
  fxAdjustment: (adjustmentId: string, generation?: number) => gen(`fxadj:${adjustmentId}`, generation),
  /** Chargeback зі спору: втрата / податкова частина / комісія, версія рішення. */
  chargeback: (disputeId: string, part: "loss" | "tax" | "fee", version: number) => `cb:${disputeId}:${part}:${v(version)}`,
  /** Ручний chargeback (інші шлюзи). */
  chargebackManual: (operationId: string, part?: string) => withPart(`cb:manual:${operationId}`, part),
  /** Наслідок оцінки складу без замовлення (inventory_loss/gain, packaging_unlinked, довідкові). */
  valuation: (valuationId: string, part?: string, generation?: number) => gen(withPart(`val:${valuationId}`, part), generation),
  /** Собівартість замовлення з оцінки виходу (консьюм) — проводить syncOrderFinance. */
  cogs: (valuationId: string, part?: string, generation?: number) => gen(withPart(`cogs:${valuationId}`, part), generation),
  /** Завершення невідомої / дефіцитної вартості. */
  valuationCompletion: (completionId: string, part?: string, generation?: number) =>
    gen(withPart(`valc:${completionId}`, part), generation),
  /** Ручна собівартість рядка (кількість, передана при визнанні — у details.quantity). */
  standardCogs: (lineId: string, version: number) => `stdcogs:${lineId}:${v(version)}`,
  /**
   * Коригування собівартості партії для руху надходження (§6.7: ключ за рухом, не за рядком партії — у рядка може бути
   * кілька надходжень; §14.5 «adj:<batchLineId>» уточнено цим).
   */
  batchAdjustment: (movementId: string, lineVersion: number, part?: string) => withPart(`adj:${movementId}:${v(lineVersion)}`, part),
  /** Рядок рахунку перевізника, версія зіставлення. */
  invoiceLine: (lineId: string, matchVersion: number, part?: string) => withPart(`inv:${lineId}:m${matchVersion}`, part),
  /** Ручна витрата; з періодом послуги — по запису на день (yyyy-mm-dd). */
  expense: (expenseId: string, version: number, day?: string) => withPart(`exp:${expenseId}:${v(version)}`, day),
  /** Частка суми періоду, розподілена на замовлення. */
  allocation: (expenseId: string, orderId: string, version: number) => `alloc:${expenseId}:${orderId}:${v(version)}`,
  /** Подія винагороди партнера (n — наступний номер під блокуванням замовлення). */
  partnerEvent: (orderId: string, partnerId: string, n: number) => `pc:${orderId}:${partnerId}:${n}`,
  /** Виплата партнеру (довідковий запис). */
  payout: (payoutId: string, generation?: number) => gen(`pay:${payoutId}`, generation),
  /** Обмін валюти. */
  fxConversion: (conversionId: string, version: number) => `fxconv:${conversionId}:${v(version)}`,
  /** Підтверджені власником суми замовлення замість «Оцінки» (§4). */
  ownerConfirmation: (orderId: string, version: number, part: string) => `confirm:${orderId}:${v(version)}:${part}`,
  /** Сторно запису. */
  reversal: (originalKey: string) => `${originalKey}:rev`,
  /** Демо-факти (ідемпотентне повторне заповнення). */
  demo: (name: string) => `demo:${name}`,
} as const;

/** Ключі подій оцінки складу (inventory_valuations.event_key, §6.2). */
export const valuationEventKeys = {
  movement: (movementId: string) => `mv:${movementId}`,
  adjustment: (movementId: string, version: number) => `adj:${movementId}:${v(version)}`,
  completion: (operationId: string, stockItemId: string) => `complete:${operationId}:${stockItemId}`,
  fxPending: (layerId: string) => `fx:${layerId}`,
} as const;

/** Ключ запису сторно? */
export function isReversalKey(key: string): boolean {
  return key.endsWith(":rev");
}

/** Кінцева перевірка довжини ключа запису. */
export function assertFinanceKey(key: string): string {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_FINANCE_KEY_LENGTH) {
    throw new RangeError(`finance idempotency key must be 1..${MAX_FINANCE_KEY_LENGTH} chars`);
  }
  return key;
}
