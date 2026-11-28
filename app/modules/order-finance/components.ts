/**
 * Етап 6, WP4: стани складників замовлення й прогнози (docs/stage6-design.md §2.6, §4, §6.5, §7.1, §8.1, §10.3) —
 * ЧИСТІ функції. Вхід — зведення фактів (sync.server.ts), вихід — значення складника (core/states.ts
 * ComponentValue без `actual`: його рахує sync.server з діючих записів) і рядки прогнозу (order_finance_forecasts, зі
 * знаком впливу на прибуток: витрата «−»).
 *
 * Правила (МАЄ): відсутнє НІКОЛИ не стає 0 (F4); факт замінює прогноз складника, ніколи не додається (§4); прогноз
 * рахується в «≈ Прогноз» лише коли складник не фактичний і `hasForecast` (isForecastCounted). Рядок прогнозу складника,
 * що покритий сумою періоду (`allocated` — факт; `awaiting_reallocation` — I16: прогноз НЕ рахується), лишається в
 * таблиці як вага розподілу (§10.3: «пропорційно їхнім прогнозам»), але `hasForecast = false` / стан фактичний.
 * `not_applicable` — лише за §2.6: платник Recipient (оцінка відправлення), позначки власника «Платить отримувач» /
 * «Без витрат на доставку», жодна позиція не потребує доставки; упаковка «обліковано загальною сумою».
 */
import type { ComponentReason, ComponentState, FinanceBasis, OrderComponent, OrderFinanceState, ShippingForecastBasis } from "~/domain/finance";
import { fromMinor, toMinorForCurrency } from "~/lib/decimal";
import { isSettled, type ComponentValue } from "~/modules/finance/core/states";

export interface Money {
  amount: string;
  currency: string;
}

/** Рядок прогнозу (зі знаком впливу на прибуток). */
export interface ForecastRow {
  component: OrderComponent;
  amount: string;
  currency: string;
  basis: FinanceBasis;
}

export type ComponentDraft = Omit<ComponentValue, "actual">;

export interface ComponentResult {
  value: ComponentDraft;
  forecasts: ForecastRow[];
}

const draft = (state: ComponentState, extra: Partial<ComponentDraft> = {}): ComponentDraft => ({
  state,
  reason: null,
  basis: null,
  hasForecast: false,
  required: true,
  ...extra,
});

const NOT_COUNTED = (reason: ComponentReason | null = null): ComponentDraft => draft("not_applicable", { reason, required: false });

/** Сума рядків за валютою (детермінований порядок валют). */
export function sumByCurrency(rows: readonly Money[]): Money[] {
  const by = new Map<string, bigint>();
  for (const r of rows) by.set(r.currency, (by.get(r.currency) ?? 0n) + toMinorForCurrency(r.amount, r.currency));
  return [...by.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([currency, minor]) => ({ currency, amount: fromMinor(minor) }));
}

function rowsOf(component: OrderComponent, rows: readonly Money[], basis: FinanceBasis, sign: 1 | -1): ForecastRow[] {
  return sumByCurrency(rows).map((r) => ({
    component,
    currency: r.currency,
    basis,
    amount: fromMinor(BigInt(sign) * toMinorForCurrency(r.amount, r.currency)),
  }));
}

const counted = (s: OrderFinanceState) => s === "recognized" || s === "open";

/**
 * Відкрите замовлення з ручною витратою: WP6 до визнання нічого не проводить (§3.3 — факти до визнання «чекають і
 * проводяться під час визнання»), тож це НЕ «Факт»: відома сума — прогноз з основою `manual` (рядок — сума витрати);
 * суми, що проводяться, немає — «немає даних».
 */
function pendingManualForecast(component: OrderComponent, amounts: readonly Money[] | undefined, missingReason: ComponentReason, extra: readonly ForecastRow[] = []): ComponentResult {
  if (!amounts || amounts.length === 0) return { value: draft("missing", { reason: missingReason }), forecasts: [] };
  return { value: draft("forecast", { basis: "manual", hasForecast: true }), forecasts: [...extra, ...rowsOf(component, amounts, "manual", -1)] };
}

/**
 * Відкрите замовлення, покрите часткою суми періоду: частка проводиться лише при визнанні (WP6), тож складник — не
 * «Факт», а прогноз з основою `allocated`; рядки прогнозу лишаються вагами розподілу (§10.3), у «≈ Прогноз» не входять.
 */
const pendingAllocation = (forecasts: ForecastRow[]): ComponentResult => ({ value: draft("forecast", { basis: "allocated" }), forecasts });

// ---------------------------------------------------------------------------------------------------------------
// Виручка (§4: продажі угод; «Оцінка» за orders.subtotal; підтверджені власником суми)
// ---------------------------------------------------------------------------------------------------------------

export interface RevenueInput {
  state: OrderFinanceState;
  /** Угоди Shopify прочитано повністю (snapshot.status.sales = complete; демо-факти — так само). */
  salesComplete: boolean;
  salesSource: "shopify" | "demo" | null;
  unsupportedCurrency: boolean;
  /** Підтверджені власником суми діють (лише без повних угод). */
  confirmed: Money[] | null;
  /** Замовлення недоступне для читання Shopify (без фактів). */
  unreadable: boolean;
  /** Відкрита підтверджена розбіжність звірки (RC3/RC5, змінений продаж). */
  reconciliationPartial: boolean;
  /** «Оцінка» за orders.subtotal (null — немає: subtotal 0 при total ≠ 0, F4). */
  estimate: Money | null;
  /** Відкрите замовлення: Σ чистих продажів угод (прогноз до визнання). */
  openSales: Money[];
}

export function revenueComponent(i: RevenueInput): ComponentResult {
  if (!counted(i.state)) return { value: NOT_COUNTED(), forecasts: [] };
  const sourceBasis: FinanceBasis = i.salesSource === "demo" ? "demo" : "shopify";
  if (i.salesComplete && !i.unsupportedCurrency) {
    if (i.state === "open") {
      const rows = rowsOf("revenue", i.openSales, sourceBasis, 1);
      return { value: rows.length ? draft("forecast", { basis: sourceBasis, hasForecast: true }) : draft("missing", { reason: "awaiting_shopify" }), forecasts: rows };
    }
    if (i.reconciliationPartial) return { value: draft("partial", { reason: "reconciliation_mismatch", basis: sourceBasis }), forecasts: [] };
    return { value: draft("actual", { basis: sourceBasis }), forecasts: [] };
  }
  if (i.confirmed) {
    if (i.state === "open") {
      const rows = rowsOf("revenue", i.confirmed, "owner_confirmed", 1);
      return { value: draft("forecast", { basis: "owner_confirmed", hasForecast: rows.length > 0 }), forecasts: rows };
    }
    return { value: draft("actual", { basis: "owner_confirmed" }), forecasts: [] };
  }
  // «Оцінка» — окремим рядком, НІКОЛИ не факт; без підтвердження власника замовлення incomplete (hasForecast = false).
  const reason: ComponentReason = i.unreadable ? "order_unreadable" : "awaiting_shopify";
  const forecasts = i.estimate ? rowsOf("revenue", [i.estimate], "order_snapshot", 1) : [];
  return { value: draft("missing", { reason, basis: i.estimate ? "order_snapshot" : null }), forecasts };
}

// ---------------------------------------------------------------------------------------------------------------
// Собівартість (§6.5)
// ---------------------------------------------------------------------------------------------------------------

export interface CogsLineInput {
  /** Одиниць, що мають бути оцінені (передано при визнанні; відкрите — до відвантаження). */
  required: number;
  /** Оцінено зі складу (відомі + завершені) або ручною собівартістю (stdcogs). */
  valued: number;
  /** З них — ручною собівартістю власника (stdcogs). */
  fromStandard: number;
  /** Прогноз одиниці для неоцінених (null — немає). */
  unitForecast: { unitCost: string; currency: string; basis: FinanceBasis } | null;
}

export function cogsComponent(state: OrderFinanceState, lines: readonly CogsLineInput[]): ComponentResult {
  if (!counted(state)) return { value: NOT_COUNTED(), forecasts: [] };
  const relevant = lines.filter((l) => l.required > 0);
  if (relevant.length === 0) return { value: draft("not_applicable", { reason: "no_product_lines", required: false }), forecasts: [] };
  let valued = 0;
  let fromStandard = 0;
  let allForecast = true;
  let basis: FinanceBasis | null = null;
  const rows: Money[] = [];
  for (const l of relevant) {
    const v = Math.min(l.valued, l.required);
    valued += v;
    fromStandard += Math.min(l.fromStandard, l.required);
    const missing = l.required - v;
    if (missing <= 0) continue;
    if (!l.unitForecast) {
      allForecast = false;
      continue;
    }
    basis ??= l.unitForecast.basis;
    rows.push({ currency: l.unitForecast.currency, amount: fromMinor(toMinorForCurrency(l.unitForecast.unitCost, l.unitForecast.currency) * BigInt(missing)) });
  }
  const required = relevant.reduce((s, l) => s + l.required, 0);
  if (valued >= required) return { value: draft("actual", { basis: fromStandard > 0 ? "owner_standard" : "valuation" }), forecasts: [] };
  const forecasts = allForecast ? rowsOf("cogs", rows, basis ?? "pool_average", -1) : [];
  const has = allForecast && forecasts.length > 0;
  if (state === "open") return { value: has ? draft("forecast", { basis, hasForecast: true }) : draft("missing", { reason: "no_cost" }), forecasts };
  return { value: draft(valued > 0 ? "partial" : "missing", { reason: "no_cost", hasForecast: has, basis: has ? basis : null }), forecasts };
}

// ---------------------------------------------------------------------------------------------------------------
// Упаковка (§2.6, §4)
// ---------------------------------------------------------------------------------------------------------------

export interface PackagingInput {
  state: OrderFinanceState;
  /** Є оцінені рухи material_consume замовлення (факт складу). */
  hasValuedFacts: boolean;
  /** Одиниць матеріалів без вартості в рухах замовлення. */
  unvaluedUnits: number;
  /** Прогноз для неоцінених одиниць (null — немає). */
  unvaluedForecast: Money[] | null;
  /** Ручна витрата упаковки із замовленням. */
  manual: boolean;
  covering: "allocated" | "awaiting_reallocation" | null;
  /** Місяць підтверджено «Упаковку цих замовлень обліковано загальною сумою» або позначка власника на замовленні. */
  accountedInTotal: boolean;
  /** Прогноз за шаблоном комплектації (null — немає даних). */
  kitForecast: Money[] | null;
  /**
   * Відкрите замовлення: відома вартість оцінених рухів material_consume (додатна; §3.3 — факти до визнання «чекають і
   * проводяться під час визнання», тож до визнання це прогноз, а не факт).
   */
  pendingValued?: Money[];
  /** Відкрите замовлення: Σ ручних витрат упаковки із замовленням (додатна — витрата). */
  pendingManual?: Money[];
}

export function packagingComponent(i: PackagingInput): ComponentResult {
  if (!counted(i.state)) return { value: NOT_COUNTED(), forecasts: [] };
  const kitRows = () => (i.kitForecast ? rowsOf("packaging", i.kitForecast, "kit_plan", -1) : []);
  // Відкрите замовлення: оцінені рухи, ручна витрата й частка суми періоду ще не проведені (проводяться при визнанні,
  // §3.3) — «Факт» лише з записами, до визнання це прогноз відомої суми.
  if (i.state === "open") {
    if (i.hasValuedFacts) {
      if (i.unvaluedUnits > 0 && !i.unvaluedForecast && !i.manual) return { value: draft("missing", { reason: "no_cost" }), forecasts: [] };
      const known = [...(i.pendingValued ?? []), ...(i.unvaluedUnits > 0 ? (i.unvaluedForecast ?? []) : []), ...(i.manual ? (i.pendingManual ?? []) : [])];
      const rows = rowsOf("packaging", known, "valuation", -1);
      return rows.length > 0 ? { value: draft("forecast", { basis: "valuation", hasForecast: true }), forecasts: rows } : { value: draft("missing", { reason: "no_cost" }), forecasts: [] };
    }
    if (i.manual) return pendingManualForecast("packaging", i.pendingManual, "no_cost");
    if (i.covering === "allocated") return pendingAllocation(kitRows());
  }
  if (i.hasValuedFacts && i.unvaluedUnits === 0) return { value: draft("actual", { basis: "valuation" }), forecasts: [] };
  if (i.manual) return { value: draft("actual", { basis: "manual" }), forecasts: [] };
  if (i.covering === "allocated") return { value: draft("actual", { basis: "allocated" }), forecasts: kitRows() };
  if (i.unvaluedUnits > 0) {
    const forecasts = i.unvaluedForecast ? rowsOf("packaging", i.unvaluedForecast, "catalogue", -1) : [];
    const has = forecasts.length > 0;
    return { value: draft(i.hasValuedFacts ? "partial" : "missing", { reason: "no_cost", hasForecast: has, basis: has ? "catalogue" : null }), forecasts };
  }
  const kit = kitRows();
  if (i.covering === "awaiting_reallocation") return { value: draft("missing", { reason: "awaiting_reallocation" }), forecasts: kit };
  if (i.accountedInTotal && i.state === "recognized") return { value: draft("not_applicable", { reason: "packaging_accounted_in_total" }), forecasts: [] };
  if (kit.length > 0) return { value: draft("forecast", { basis: "kit_plan", hasForecast: true }), forecasts: kit };
  return { value: draft("missing", { reason: "no_cost" }), forecasts: [] };
}

// ---------------------------------------------------------------------------------------------------------------
// Доставка (§2.6, §7.1)
// ---------------------------------------------------------------------------------------------------------------

export interface WaybillForecastInput {
  key: string;
  /** Є діючий фактичний рядок рахунку вартості (не R2-типу). */
  hasActual: boolean;
  /** Платник Recipient у розрахунку перевізника. */
  payerRecipient: boolean;
  /** Заморожений (визнане) / поточний (відкрите) прогноз. */
  forecast: { basis: ShippingForecastBasis; amount: string | null; currency: string | null } | null;
  /**
   * Відкрите замовлення: Σ діючих рядків рахунку вартості накладної (додатна вартість) — до визнання записів немає
   * (§3.3), тож це прогноз з основою `invoice`, а не факт.
   */
  invoiced?: Money[];
}

export interface ShippingInput {
  state: OrderFinanceState;
  /** Хоч одна позиція потребує доставки (requires_shipping ≠ false). */
  needsShipping: boolean;
  override: "recipient_pays" | "no_shipping_cost" | null;
  /** Ручна вартість доставки власника із замовленням. */
  manual: boolean;
  covering: "allocated" | "awaiting_reallocation" | null;
  /** Накладні замовлення (діючі відправлення застосунку й зовнішні номери). */
  waybills: readonly WaybillForecastInput[];
  /** Прогноз замовлення без накладної (рядок `order`). */
  orderForecast: { basis: ShippingForecastBasis; amount: string | null; currency: string | null } | null;
  /** Відкрите замовлення: Σ ручних витрат доставки із замовленням (додатна — витрата). */
  pendingManual?: Money[];
}

const hasAmount = (f: WaybillForecastInput["forecast"]): f is { basis: Exclude<ShippingForecastBasis, "none">; amount: string; currency: string } =>
  Boolean(f && f.basis !== "none" && f.amount !== null && f.currency !== null);

export function shippingComponent(i: ShippingInput): ComponentResult {
  if (!counted(i.state)) return { value: NOT_COUNTED(), forecasts: [] };
  if (!i.needsShipping) return { value: draft("not_applicable", { reason: "no_shippable_lines" }), forecasts: [] };
  if (i.override) return { value: draft("not_applicable", { reason: i.override, basis: "manual" }), forecasts: [] };
  if (i.manual) return i.state === "open" ? pendingManualForecast("shipping_cost", i.pendingManual, "no_invoice") : { value: draft("actual", { basis: "manual" }), forecasts: [] };
  const active = i.waybills;
  const weights = (list: readonly WaybillForecastInput[]) =>
    list.filter((w) => hasAmount(w.forecast)).map((w) => ({ amount: w.forecast!.amount!, currency: w.forecast!.currency! }));
  if (i.covering === "allocated") {
    const basis = active.find((w) => hasAmount(w.forecast))?.forecast?.basis ?? i.orderForecast?.basis ?? "owner_table";
    const rows = active.length ? weights(active) : hasAmount(i.orderForecast) ? [{ amount: i.orderForecast!.amount!, currency: i.orderForecast!.currency! }] : [];
    const forecasts = rowsOf("shipping_cost", rows, basis === "none" ? "owner_table" : basis, -1);
    return i.state === "open" ? pendingAllocation(forecasts) : { value: draft("actual", { basis: "allocated" }), forecasts };
  }
  if (active.length > 0 && active.every((w) => w.payerRecipient)) return { value: draft("not_applicable", { reason: "recipient_pays", basis: "carrier_reported" }), forecasts: [] };
  if (i.state === "open" && active.length > 0 && active.some((w) => w.hasActual && (w.invoiced?.length ?? 0) > 0)) {
    // Рахунок до передачі: вартість відома, але проводиться лише при визнанні — прогноз (рахунок або прогноз накладної).
    const rows: Money[] = [];
    let basis: FinanceBasis | null = null;
    let all = true;
    for (const w of active) {
      if (w.payerRecipient) continue;
      if (w.hasActual && (w.invoiced?.length ?? 0) > 0) {
        rows.push(...w.invoiced!);
        basis ??= "invoice";
      } else if (hasAmount(w.forecast)) {
        rows.push({ amount: w.forecast.amount, currency: w.forecast.currency });
        basis ??= w.forecast.basis as FinanceBasis;
      } else all = false;
    }
    const forecasts = all ? rowsOf("shipping_cost", rows, basis ?? "invoice", -1) : [];
    if (i.covering === "awaiting_reallocation") return { value: draft("missing", { reason: "awaiting_reallocation" }), forecasts };
    return forecasts.length > 0 ? { value: draft("forecast", { basis: basis ?? "invoice", hasForecast: true }), forecasts } : { value: draft("missing", { reason: "no_invoice" }), forecasts: [] };
  }
  let result: ComponentResult;
  if (active.length === 0) {
    const f = i.orderForecast;
    const has = hasAmount(f);
    const forecasts = has ? rowsOf("shipping_cost", [{ amount: f!.amount!, currency: f!.currency! }], f!.basis as FinanceBasis, -1) : [];
    result = { value: draft("missing", { reason: "no_waybill", hasForecast: has, basis: has ? (f!.basis as FinanceBasis) : null }), forecasts };
  } else {
    const pending = active.filter((w) => !w.hasActual && !w.payerRecipient);
    if (pending.length === 0) return { value: draft("actual", { basis: "invoice" }), forecasts: [] };
    const has = pending.every((w) => hasAmount(w.forecast));
    const st: ComponentState = pending.length < active.length ? "partial" : has ? "forecast" : "missing";
    const basis = has ? (pending[0]!.forecast!.basis as FinanceBasis) : null;
    const forecasts = has ? rowsOf("shipping_cost", weights(pending), basis!, -1) : [];
    result = { value: draft(st, { reason: has && st === "forecast" ? null : "no_invoice", hasForecast: has, basis }), forecasts };
  }
  // I16: сума періоду покриває складник, розподіл ще не перераховано — прогноз лишається вагою, але не рахується.
  if (i.covering === "awaiting_reallocation") return { value: draft("missing", { reason: "awaiting_reallocation" }), forecasts: result.forecasts };
  if (i.state === "open" && result.value.hasForecast) return { value: draft("forecast", { basis: result.value.basis, hasForecast: true }), forecasts: result.forecasts };
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Комісії (§8.1)
// ---------------------------------------------------------------------------------------------------------------

export type FeeRuleOutcome = { state: "none" } | { state: "zero_confirmed" } | { state: "forecast"; lines: Money[] };

export interface FeesInput {
  state: OrderFinanceState;
  /** Комісії Shopify замовлення (діючі записи для визнаного; рядки фактів для відкритого). */
  shopifyFees: Money[];
  /** snapshot.status.fees = complete (інакше збережені комісії — не повний набір, F4). */
  feesComplete: boolean;
  /** Замовлення з фактами Shopify (інакше «немає даних» — no_fee_data, а не «очікуємо Shopify»). */
  shopifyFacts: boolean;
  manual: boolean;
  covering: "allocated" | "awaiting_reallocation" | null;
  /** Позначка власника «Шлюз без комісії» для замовлення. */
  ownerZero: boolean;
  rule: FeeRuleOutcome;
  /**
   * Відкрита підтверджена розбіжність звірки, що впливає на комісії (§16.5: RC2 «Оплачено покупцем» ≠ netPaymentSet;
   * змінений незмінний TransactionFee) — WP3 partialComponents містить `fees`.
   */
  reconciliationPartial?: boolean;
  /**
   * §8.1 «Порожній fees = немає даних» — ПО ТРАНЗАКЦІЇ: хоч одна SUCCESS-оплата SALE/CAPTURE має рядки комісій Shopify
   * (без оплат — є хоч одна комісія Shopify). Типово — `shopifyFees.length > 0`.
   */
  knownFees?: boolean;
  /**
   * SUCCESS-оплат SALE/CAPTURE без жодного рядка комісії (сторонній шлюз поряд із Shopify Payments, друга оплата з
   * порожнім `fees`): їхня комісія невідома — правило шлюзу (`rule` — лише для цих оплат) або «немає даних», НІКОЛИ не 0.
   */
  uncoveredPayments?: number;
  /** Відкрите замовлення: Σ ручних комісій із замовленням (додатна — витрата). */
  pendingManual?: Money[];
}

export function feesComponent(i: FeesInput): ComponentResult {
  const r = feesComponentRaw(i);
  // §16.5 / §2.6: доки власник не розв'яже розбіжність, складник визнаного замовлення, що інакше був би остаточним, —
  // `partial` (`reconciliation_mismatch`): замовлення не `final`, місяць не закривається.
  if (i.reconciliationPartial && i.state === "recognized" && (r.value.state === "actual" || r.value.state === "zero_confirmed")) {
    return { value: draft("partial", { reason: "reconciliation_mismatch", basis: r.value.basis }), forecasts: r.forecasts };
  }
  return r;
}

function feesComponentRaw(i: FeesInput): ComponentResult {
  if (!counted(i.state)) return { value: NOT_COUNTED(), forecasts: [] };
  const open = i.state === "open";
  const ruleRows = i.rule.state === "forecast" ? rowsOf("fees", i.rule.lines, "fee_rule", -1) : [];
  if (i.covering === "allocated") return open ? pendingAllocation(ruleRows) : { value: draft("actual", { basis: "allocated" }), forecasts: ruleRows };
  if (i.manual) return open ? pendingManualForecast("fees", i.pendingManual, "no_fee_data", rowsOf("fees", i.shopifyFees, "shopify", -1)) : { value: draft("actual", { basis: "manual" }), forecasts: [] };
  const known = i.knownFees ?? i.shopifyFees.length > 0;
  const uncovered = i.uncoveredPayments ?? 0;
  if (known && (uncovered === 0 || i.ownerZero || i.rule.state === "zero_confirmed")) {
    if (open) {
      const rows = rowsOf("fees", i.shopifyFees, "shopify", -1);
      return { value: draft("forecast", { basis: "shopify", hasForecast: true }), forecasts: rows };
    }
    if (i.feesComplete) return { value: draft("actual", { basis: "shopify" }), forecasts: [] };
    return { value: draft("partial", { reason: "awaiting_shopify", basis: "shopify" }), forecasts: [] };
  }
  if (known) {
    // Частина оплат має комісії Shopify, решта — порожній `fees` (немає даних, НІКОЛИ не 0, §8.1): відома частина —
    // Shopify, невідома — прогноз правила шлюзу цих оплат, інакше складник неповний.
    if (i.covering === "awaiting_reallocation") return { value: draft("missing", { reason: "awaiting_reallocation" }), forecasts: ruleRows };
    const has = i.rule.state === "forecast" && ruleRows.length > 0;
    if (open) {
      return has
        ? { value: draft("forecast", { basis: "shopify", hasForecast: true }), forecasts: [...rowsOf("fees", i.shopifyFees, "shopify", -1), ...ruleRows] }
        : { value: draft("missing", { reason: "no_fee_data" }), forecasts: [] };
    }
    return { value: draft("partial", { reason: i.feesComplete ? "no_fee_data" : "awaiting_shopify", hasForecast: has, basis: has ? "fee_rule" : "shopify" }), forecasts: has ? ruleRows : [] };
  }
  if (i.ownerZero) return { value: draft("zero_confirmed", { reason: "owner_confirmed", basis: "manual" }), forecasts: [] };
  if (i.covering === "awaiting_reallocation") return { value: draft("missing", { reason: "awaiting_reallocation" }), forecasts: ruleRows };
  if (i.rule.state === "zero_confirmed") return { value: draft("zero_confirmed", { reason: "fee_rule_no_fees", basis: "fee_rule" }), forecasts: [] };
  const missingReason: ComponentReason = i.shopifyFacts && !i.feesComplete ? "awaiting_shopify" : "no_fee_data";
  if (i.rule.state === "forecast" && ruleRows.length > 0) {
    if (i.state === "open") return { value: draft("forecast", { basis: "fee_rule", hasForecast: true }), forecasts: ruleRows };
    return { value: draft("forecast", { basis: "fee_rule", hasForecast: true, reason: i.shopifyFacts && !i.feesComplete ? "awaiting_shopify" : null }), forecasts: ruleRows };
  }
  return { value: draft("missing", { reason: missingReason }), forecasts: [] };
}

// ---------------------------------------------------------------------------------------------------------------
// Мито компанії (DDP)
// ---------------------------------------------------------------------------------------------------------------

export function dutiesComponent(state: OrderFinanceState, input: { ddp: boolean; actual: boolean; basis: FinanceBasis | null }): ComponentResult {
  if (!counted(state) || !input.ddp) return { value: draft("not_applicable", { reason: "not_ddp", required: false }), forecasts: [] };
  if (input.actual) return { value: draft("actual", { basis: input.basis ?? "invoice" }), forecasts: [] };
  return { value: draft("missing", { reason: "no_invoice" }), forecasts: [] };
}

// ---------------------------------------------------------------------------------------------------------------
// Правило «рахується в ≈ Прогноз» (для картки, списку, агрегатора WP8)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Рядок прогнозу рахується в «≈ Прогноз» замовлення, лише якщо його складник (order_finance.components) не фактичний і
 * має `hasForecast` (прогноз покриває невідому частину). «Оцінка» виручки (`revenue`) у прибуток не входить ніколи —
 * це окремий рядок (§2.6). Прогнози-ваги розподілу (allocated / awaiting_reallocation) не рахуються.
 */
export function isForecastCounted(component: string, value: Pick<ComponentDraft, "state" | "hasForecast"> | undefined | null): boolean {
  if (component === "revenue" || !value) return false;
  return value.hasForecast && !isSettled(value.state);
}
