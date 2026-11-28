/**
 * Виробництво (етап 5): чисті правила без БД — номери партій, стани, кількості, брак, прострочення, собівартість.
 *
 * Кількості позиції партії:
 * - ordered — замовлено у виробника; received — отримано ЯКІСНИХ; defective — отримано браку;
 * - виготовлено (produced) = received + defective; незавершений залишок (remaining) = max(0, ordered − produced);
 * - понад замовлене (overReceived) = max(0, produced − ordered) — лише з явним прапорцем при надходженні
 *   (такі одиниці йдуть одразу у «Фактично»/«Брак», не зменшуючи «У виробництві»).
 * - значення залишку залежить від стану (REMAINDER_KIND): заплановано — «до виготовлення» (у кошику
 *   «У виробництві» його ще немає); запущено — справді «у виробництві»; закрито/скасовано — «не виготовлено»
 *   (знято з «У виробництві»). Кошик складу «У виробництві» від партії = inProductionQuantity(стан, залишок).
 *
 * Собівартість (лише власник, finance.view):
 * - кількість до оплати позиції (billed): поки партія відкрита — max(ordered, produced) (замовлене або фактично
 *   виготовлене, якщо більше); закрито/скасовано — лише produced (залишок «не буде виготовлено» й не оплачується;
 *   якщо його все ж оплачено — власник додає суму до додаткових витрат);
 * - загальна = Σ billed × ціна одиниці + додаткові витрати;
 * - вартість виготовленого = Σ produced × ціна одиниці + додаткові витрати × Σ produced / Σ billed;
 * - собівартість ЯКІСНОЇ одиниці = вартість виготовленого / Σ якісних (брак «оплачують» якісні одиниці). Для
 *   отриманої або закритої партії вартість виготовленого = загальна, тож це «загальна / якісні»; для частково
 *   отриманої — лише за вже отриманим (без ще не виготовлених одиниць, які завищували б показник).
 * - unit_cost рухів запуску й надходження = планова собівартість ОДИНИЦІ ВИГОТОВЛЕНОГО (landedUnitCost: ціна одиниці
 *   + додаткові витрати / Σ billed на момент руху) — однакова для якісних і браку цього руху, БЕЗ розподілу браку
 *   на якісні; не перераховується після зміни собівартості (журнал лише доповнюється). Отже unit_cost × (якісні +
 *   брак) руху — вартість виготовлених одиниць, а собівартість якісної одиниці (COGS з урахуванням браку) —
 *   показник партії: batchCostSummary().costPerGoodUnit, а не unit_cost руху.
 * Округлення — до копійки, половина вгору (BigInt, без float).
 */
import type { ProductionBatchStatus } from "~/db/schema";
import { formatMoney, fromMinor, toMinor } from "~/lib/money";

export const BATCH_NUMBER_PREFIX = "PB";

/** Стани партії (копія PRODUCTION_BATCH_STATUSES без залежності від схеми БД — для інтерфейсу). */
export const BATCH_STATUSES = ["planned", "in_production", "partially_received", "received", "closed", "cancelled"] as const satisfies readonly ProductionBatchStatus[];
// Перевірка повноти на рівні типів: кожен стан схеми є в BATCH_STATUSES.
type MissingStatus = Exclude<ProductionBatchStatus, (typeof BATCH_STATUSES)[number]>;
const _allStatuses: MissingStatus extends never ? true : never = true;
void _allStatuses;

export function isBatchStatus(value: unknown): value is ProductionBatchStatus {
  return typeof value === "string" && (BATCH_STATUSES as readonly string[]).includes(value);
}

/** Вигляд позначки стану (тон Badge з app/ui). */
export const BATCH_STATUS_TONE: Readonly<Record<ProductionBatchStatus, "outline" | "info" | "warning" | "success" | "neutral">> = {
  planned: "outline",
  in_production: "info",
  partially_received: "warning",
  received: "success",
  closed: "neutral",
  cancelled: "neutral",
};

/** Стани, у яких партія «активна» (потребує дій): заплановано, у виробництві, частково/повністю отримано. */
export const ACTIVE_BATCH_STATUSES = ["planned", "in_production", "partially_received", "received"] as const satisfies readonly ProductionBatchStatus[];
/** Ще не отримано повністю — для позначки «прострочено». */
export const NOT_RECEIVED_STATUSES = ["planned", "in_production", "partially_received"] as const satisfies readonly ProductionBatchStatus[];
/** Можна оприбуткувати надходження (у стані received — лише понад замовлене, з прапорцем). */
export const RECEIVABLE_STATUSES = ["in_production", "partially_received", "received"] as const satisfies readonly ProductionBatchStatus[];
/** Можна закрити (незавершений залишок знімається з «У виробництві»). */
export const CLOSABLE_STATUSES = ["in_production", "partially_received", "received"] as const satisfies readonly ProductionBatchStatus[];

/** Межі введення (захист від помилок і зловживань). */
export const LIMITS = {
  title: 200,
  manufacturer: 200,
  notes: 2000,
  receiptNote: 500,
  defectReason: 200,
  /** Максимальна кількість однієї позиції (замовлено або в одному надходженні). */
  quantity: 100_000,
  /** Позицій у партії. */
  lines: 500,
  /** Цілих розрядів суми (numeric(14,2) → 12). */
  moneyIntegerDigits: 12,
} as const;

export function isStatusIn<T extends ProductionBatchStatus>(status: ProductionBatchStatus, list: readonly T[]): status is T {
  return (list as readonly ProductionBatchStatus[]).includes(status);
}

/**
 * Що означає незавершений залишок (замовлено − виготовлено) у стані партії:
 * - toProduce — заплановано, ще не запущено: у кошику «У виробництві» його немає;
 * - inProduction — запущено (у виробництві / частково отримано / отримано): залишок справді «У виробництві»;
 * - notProduced — закрито або скасовано: залишок знято з «У виробництві», його не буде виготовлено.
 */
export type RemainderKind = "toProduce" | "inProduction" | "notProduced";

export const REMAINDER_KIND: Readonly<Record<ProductionBatchStatus, RemainderKind>> = {
  planned: "toProduce",
  in_production: "inProduction",
  partially_received: "inProduction",
  received: "inProduction",
  closed: "notProduced",
  cancelled: "notProduced",
};

/** Скільки одиниць партії (позиції) зараз у кошику складу «У виробництві»: залишок лише запущеної партії. */
export function inProductionQuantity(status: ProductionBatchStatus, remaining: number): number {
  return REMAINDER_KIND[status] === "inProduction" ? Math.max(0, remaining) : 0;
}

// ---------------------------------------------------------------------------
// Номер партії
// ---------------------------------------------------------------------------

/** PB-2026-0001 (послідовність — щонайменше 4 цифри; після 9999 — більше). */
export function formatBatchNumber(year: number, seq: number): string {
  if (!Number.isSafeInteger(year) || year < 2000 || year > 9999) throw new RangeError("invalid batch year");
  if (!Number.isSafeInteger(seq) || seq < 1) throw new RangeError("invalid batch sequence");
  return `${BATCH_NUMBER_PREFIX}-${year}-${String(seq).padStart(4, "0")}`;
}

export function parseBatchNumber(value: string): { year: number; seq: number } | null {
  const m = /^PB-(\d{4})-(\d{4,9})$/.exec(value);
  if (!m) return null;
  return { year: Number(m[1]), seq: Number(m[2]) };
}

// ---------------------------------------------------------------------------
// Дати (Europe/Kyiv)
// ---------------------------------------------------------------------------

const KYIV_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" });

/** Сьогоднішня дата в Києві: YYYY-MM-DD. */
export function kyivDate(now: Date): string {
  return KYIV_DATE.format(now);
}

export function kyivYear(now: Date): number {
  return Number(kyivDate(now).slice(0, 4));
}

/** Справжня календарна дата YYYY-MM-DD у розумних межах (2000–2100). */
export function isValidDateString(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100) return false;
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** Прострочено: планова дата готовності раніше за сьогодні, а партію ще не отримано повністю. */
export function isOverdue(status: ProductionBatchStatus, plannedReadyDate: string | null, today: string): boolean {
  return Boolean(plannedReadyDate) && plannedReadyDate! < today && isStatusIn(status, NOT_RECEIVED_STATUSES);
}

// ---------------------------------------------------------------------------
// Кількості й брак
// ---------------------------------------------------------------------------

export interface LineQuantities {
  ordered: number;
  received: number;
  defective: number;
}

export const lineProduced = (l: LineQuantities) => l.received + l.defective;
export const lineRemaining = (l: LineQuantities) => Math.max(0, l.ordered - lineProduced(l));
export const lineOverReceived = (l: LineQuantities) => Math.max(0, lineProduced(l) - l.ordered);
/** Кількість до оплати: відкрита партія — max(замовлено, виготовлено); закрита/скасована — лише виготовлене. */
export const billedQuantity = (l: LineQuantities, status: ProductionBatchStatus) =>
  REMAINDER_KIND[status] === "notProduced" ? lineProduced(l) : Math.max(l.ordered, lineProduced(l));

/** Частка браку від виготовленого (якісні + брак), %, один знак після коми; null — ще нічого не отримано. */
export function defectRatePercent(defective: number, produced: number): number | null {
  if (produced <= 0) return null;
  return Math.round((defective * 1000) / produced) / 10;
}

export interface QuantityTotals {
  lines: number;
  ordered: number;
  received: number;
  defective: number;
  produced: number;
  remaining: number;
  overReceived: number;
  defectRate: number | null;
}

export function quantityTotals(lines: readonly LineQuantities[]): QuantityTotals {
  const t = { lines: lines.length, ordered: 0, received: 0, defective: 0, produced: 0, remaining: 0, overReceived: 0 };
  for (const l of lines) {
    t.ordered += l.ordered;
    t.received += l.received;
    t.defective += l.defective;
    t.produced += lineProduced(l);
    t.remaining += lineRemaining(l);
    t.overReceived += lineOverReceived(l);
  }
  return { ...t, defectRate: defectRatePercent(t.defective, t.produced) };
}

/** Стан після надходження: усі позиції виготовлено повністю → received, інакше partially_received. */
export function statusAfterReceipt(lines: readonly LineQuantities[]): "received" | "partially_received" {
  return lines.length > 0 && lines.every((l) => lineRemaining(l) === 0) ? "received" : "partially_received";
}

/**
 * Розподіл рядка надходження: скільки одиниць знімається з «У виробництві» (не більше за залишок позиції),
 * а скільки — понад замовлене (лише з прапорцем; йдуть одразу у «Фактично»/«Брак»).
 */
export function allocateReceipt(remaining: number, good: number, defective: number): { fromInProduction: number; over: number } {
  const qty = good + defective;
  const fromInProduction = Math.min(qty, Math.max(0, remaining));
  return { fromInProduction, over: qty - fromInProduction };
}

// ---------------------------------------------------------------------------
// Гроші
// ---------------------------------------------------------------------------

const MONEY_INPUT_RE = /^\d+(?:\.\d{1,2})?$/;

/**
 * Сума з форми: "1 250,5" → "1250.50"; порожньо → null; помилка → "invalid".
 * Лише невід'ємні значення, до 12 цілих розрядів (numeric(14,2)).
 */
export function parseMoneyInput(raw: string | null | undefined): string | null | "invalid" {
  const value = (raw ?? "").replace(/[\s  ]/g, "").replace(",", ".");
  if (value === "") return null;
  if (!MONEY_INPUT_RE.test(value)) return "invalid";
  const int = value.split(".")[0]!.replace(/^0+(?=\d)/, "");
  if (int.length > LIMITS.moneyIntegerDigits) return "invalid";
  return fromMinor(toMinor(value));
}

/** Ділення мінорних одиниць із округленням половина вгору (для невід'ємних значень). */
export function divideMinorHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("denominator must be positive");
  if (numerator < 0n) throw new RangeError("numerator must be non-negative");
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/**
 * Розподіл суми (мінорні одиниці, ≥ 0) за вагами методом найбільших остач (нічия — менший індекс); Σ = total точно.
 * Те саме правило, що allocateMinor (app/lib/decimal.ts), — локально, бо decimal.ts реекспортує divideMinorHalfUp звідси.
 */
function allocateExtra(total: bigint, weights: readonly bigint[]): bigint[] {
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum <= 0n) return weights.map(() => 0n);
  const parts = weights.map((w) => (total * w) / sum);
  const order = weights.map((w, i) => ({ i, r: (total * w) % sum })).sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  let left = total - parts.reduce((a, b) => a + b, 0n);
  for (const { i } of order) {
    if (left === 0n) break;
    parts[i] = parts[i]! + 1n;
    left -= 1n;
  }
  return parts;
}

export interface CostLineInput extends LineQuantities {
  id: string;
  unitCost: string | null;
  costCurrency: string | null;
}

export interface LineCostSummary {
  id: string;
  billedQty: number;
  unitCost: string | null;
  /** billed × ціна одиниці. */
  total: string | null;
  /** Частка додаткових витрат (пропорційно billed). */
  extraShare: string | null;
  /** Планова собівартість одиниці: ціна + додаткові витрати на одиницю. */
  landedUnitCost: string | null;
  /** Вартість виготовлених одиниць позиції / якісні; null — якісних ще немає або ціни немає. */
  costPerGoodUnit: string | null;
  /**
   * Етап 6 (§6.7): вартість виготовлених одиниць позиції = ціна × produced + частка додаткових витрат виготовленого
   * (allocateMinor з вагами produced) — ціль переоцінки рядка; Σ за позиціями = producedTotal точно (коли ціни повні).
   * null — ціни позиції немає.
   */
  producedValue: string | null;
}

export interface CostSummary {
  currency: string | null;
  /** Ціну одиниці вказано для всіх позицій (у валюті партії). */
  complete: boolean;
  linesWithoutCost: number;
  linesTotal: string | null;
  extraCost: string | null;
  /** Σ billed × ціна + додаткові витрати (за відомими цінами). Відкрита партія — планова, закрита — фактична. */
  total: string | null;
  /** Вартість уже виготовлених одиниць (Σ produced × ціна + частка додаткових витрат); для отриманої/закритої = total. */
  producedTotal: string | null;
  goodReceived: number;
  /** producedTotal / якісні — лише коли ціни повні й якісні є. */
  costPerGoodUnit: string | null;
  lines: LineCostSummary[];
}

/** Планова собівартість одиниці позиції (unit_cost рухів): ціна + додаткові витрати / Σ billed. */
export function landedUnitCost(unitCost: string | null, extraCost: string | null, totalBilled: number): string | null {
  if (unitCost === null) return null;
  const base = toMinor(unitCost);
  if (!extraCost || totalBilled <= 0) return fromMinor(base);
  return fromMinor(base + divideMinorHalfUp(toMinor(extraCost), BigInt(totalBilled)));
}

/**
 * Собівартість партії (лише для finance.view) з урахуванням стану (див. заголовок файлу: що оплачується після
 * закриття). Ціни в іншій валюті, ніж валюта партії, вважаються невідомими (сумувати різні валюти не можна) —
 * тоді complete = false.
 */
export function batchCostSummary(
  lines: readonly CostLineInput[],
  extraCost: string | null,
  batchCurrency: string | null,
  status: ProductionBatchStatus,
): CostSummary {
  const currency = batchCurrency ?? lines.find((l) => l.unitCost !== null)?.costCurrency ?? null;
  const known = (l: CostLineInput) => l.unitCost !== null && (l.costCurrency ?? currency) === currency;
  const totalBilled = lines.reduce((s, l) => s + billedQuantity(l, status), 0);
  const extraMinor = extraCost ? toMinor(extraCost) : 0n;
  /** Частка додаткових витрат для qty одиниць (пропорційно Σ billed). */
  const extraFor = (qty: number) => (totalBilled > 0 && extraMinor > 0n ? divideMinorHalfUp(extraMinor * BigInt(qty), BigInt(totalBilled)) : 0n);
  let linesMinor = 0n;
  let producedLinesMinor = 0n;
  let totalProduced = 0;
  let anyLineCost = false;
  let goodReceived = 0;
  const out: LineCostSummary[] = [];
  for (const l of lines) {
    goodReceived += l.received;
    const billed = billedQuantity(l, status);
    const produced = lineProduced(l);
    totalProduced += produced;
    const extraShareMinor = extraFor(billed);
    if (!known(l)) {
      out.push({
        id: l.id,
        billedQty: billed,
        unitCost: null,
        total: null,
        extraShare: extraCost ? fromMinor(extraShareMinor) : null,
        landedUnitCost: null,
        costPerGoodUnit: null,
        producedValue: null,
      });
      continue;
    }
    anyLineCost = true;
    const unitMinor = toMinor(l.unitCost!);
    const totalMinor = unitMinor * BigInt(billed);
    linesMinor += totalMinor;
    producedLinesMinor += unitMinor * BigInt(produced);
    out.push({
      id: l.id,
      billedQty: billed,
      unitCost: l.unitCost,
      total: fromMinor(totalMinor),
      extraShare: extraCost ? fromMinor(extraShareMinor) : null,
      landedUnitCost: landedUnitCost(l.unitCost, extraCost, totalBilled),
      costPerGoodUnit: l.received > 0 ? fromMinor(divideMinorHalfUp(unitMinor * BigInt(produced) + extraFor(produced), BigInt(l.received))) : null,
      // Заповнюється нижче (частка додаткових витрат виготовленого — allocateMinor за всіма позиціями).
      producedValue: fromMinor(unitMinor * BigInt(produced)),
    });
  }
  const linesWithoutCost = lines.filter((l) => !known(l)).length;
  const complete = lines.length > 0 && linesWithoutCost === 0;
  const hasAny = anyLineCost || extraCost !== null;
  const totalMinor = linesMinor + extraMinor;
  // Отримана/закрита партія: Σ produced = Σ billed → уся сума додаткових витрат (без похибки округлення).
  const producedExtraMinor = totalProduced === totalBilled ? extraMinor : extraFor(totalProduced);
  const producedMinor = producedLinesMinor + producedExtraMinor;
  // Етап 6 (§6.7): частки додаткових витрат виготовленого за позиціями (вага — produced), Σ = producedExtraMinor точно.
  if (totalProduced > 0 && producedExtraMinor > 0n) {
    const shares = allocateExtra(producedExtraMinor, lines.map((l) => BigInt(lineProduced(l))));
    out.forEach((o, i) => {
      if (o.producedValue !== null) o.producedValue = fromMinor(toMinor(o.producedValue) + shares[i]!);
    });
  }
  return {
    currency: hasAny ? currency : null,
    complete,
    linesWithoutCost,
    linesTotal: anyLineCost ? fromMinor(linesMinor) : null,
    extraCost,
    total: hasAny ? fromMinor(totalMinor) : null,
    producedTotal: hasAny ? fromMinor(producedMinor) : null,
    goodReceived,
    costPerGoodUnit: complete && goodReceived > 0 ? fromMinor(divideMinorHalfUp(producedMinor, BigInt(goodReceived))) : null,
    lines: out,
  };
}

// ---------------------------------------------------------------------------
// Кількості з форми
// ---------------------------------------------------------------------------

/** Ціле число з форми: порожньо → 0; "invalid" — не ціле, від'ємне або більше за межу. */
export function parseQuantityInput(raw: string | null | undefined, max: number = LIMITS.quantity): number | "invalid" {
  const value = (raw ?? "").replace(/[\s  ]/g, "");
  if (value === "") return 0;
  if (!/^\d{1,9}$/.test(value)) return "invalid";
  const n = Number(value);
  return n > max ? "invalid" : n;
}

// ---------------------------------------------------------------------------
// Відображення сум
// ---------------------------------------------------------------------------

/**
 * Сума для відображення — через спільний детермінований форматер (lib/money formatMoney): однаково на сервері й
 * у браузері (без Intl style:"currency", символ якого відрізняється між Node і браузерами) і так само, як на
 * інших сторінках складу.
 */
export function formatCost(amount: string | null | undefined, currency: string | null | undefined, locale: "uk" | "en"): string {
  if (!amount || !currency) return "—";
  return formatMoney(amount, currency, locale);
}
