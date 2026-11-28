/**
 * Етап 6, WP7: сервіси партнерської програми для власника (docs/stage6-design.md §9, §18.6, §14). КОЖНА функція
 * перевіряє requireFinance: читання — finance.view, зміни — finance.manage (дозвіл + роль owner); працівник — 403.
 *
 * - партнери (ім'я — лише в partners.display_name: сторінки й експорти власника; НІКОЛИ в audit_log / finance_change_log
 *   / логах — там id і `nameChanged`), коди (вид + код, дійсність), ставки з датою дії («Новий відсоток діятиме для
 *   нових замовлень» — атрибуція фіксує ставку на дату замовлення);
 * - ручна атрибуція (призначити / зняти / повернути автоматичну) — з причиною й історією змін; ручні рішення не
 *   перезаписуються автоматикою; після зміни — синхронізація фінансів замовлення (WP4), яка сама проводить винагороду
 *   (syncPartnerCommission з повними вхідними даними); лише якщо вона цього не зробила (заглушка WP4) —
 *   syncPartnerCommission викликається тут (watchPartnerSyncs: ніколи двічі);
 * - додавання коду атрибутує вже синхронізовані замовлення з цим кодом (без ручних рішень, ≤ 500 найновіших); код із
 *   тим самим значенням, що раніше вимкнений, без дати початку діє з сьогодні (старіші замовлення лишаються за
 *   попереднім кодом); вимкнення коду, пауза чи архів партнера не знімають уже ухвалених атрибуцій (sync.server.ts);
 * - назва партнера унікальна серед неархівних (без урахування регістру) — перевірка й запис під FINANCE_OP_LOCK назви
 *   (подвійне натискання / паралельні запити не створюють другого партнера);
 * - список і деталь: стани винагороди й баланс (ledger.ts), очікувана — з прогнозів (order_finance_forecasts).
 * Виплати — payouts.server.ts; ефективність — performance.server.ts.
 */
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import type { Tx } from "~/db/client.server";
import {
  financeChangeLog,
  financeDiscrepancies,
  financeExpenses,
  orderFinanceForecasts,
  orderShopifyFinance,
  orders,
  partnerAttributions,
  partnerCodes,
  partnerCommissionEvents,
  partnerPayouts,
  partnerRates,
  partners,
} from "~/db/schema";
import { PARTNER_CODE_SOURCES, PARTNER_KINDS, PARTNER_STATUSES } from "~/domain/finance";
import { ConflictError, DomainError, NotFoundError } from "~/lib/errors";
import { fromMinor, isSupportedCurrency, toMinorForCurrency } from "~/lib/decimal";
import { businessDate, parseIsoDate, type DateRange } from "~/lib/periods";
import { writeAudit } from "~/modules/audit/audit.server";
import { requireFinance } from "~/modules/finance/core/access.server";
import { writeFinanceChange, type FinanceChangeRow } from "~/modules/finance/core/change-log.server";
import { resolveDiscrepancy } from "~/modules/finance/core/discrepancies.server";
import { lockFinanceOperation, lockFinanceOrder } from "~/modules/finance/core/locks.server";
import { loadFinanceSettings } from "~/modules/finance/core/settings.server";
import { syncOrderFinance } from "~/modules/order-finance/sync.server";
import { maskFreeTextNote } from "~/modules/privacy/notes";
import type { ServiceContext } from "~/server/types";
import { rateOn } from "./attribution";
import { parsePartnerCode, parseValidity } from "./codes";
import { PARTNER_NAME_MAX, PARTNER_NOTE_MAX, parseHoldDays } from "./input";
import { deriveLedger, type CurrencyLedger, type LedgerEvent, type LedgerPayout } from "./ledger";
import { commissionCurrenciesOf } from "./currency.server";
import { loadOrderEvents, loadPartnerEvents } from "./events.server";
import { ambiguityKey, ordersWithCode, partnerTermsOn, syncPartnerCommission, watchPartnerSyncs } from "./sync.server";
import type { Money, PartnerCodeSource, PartnerKind, PartnerStatus } from "./types";

type Ctx = Pick<ServiceContext, "db" | "actor" | "now">;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (code: string, params: Record<string, string | number> = {}, status = 400): never => {
  throw new DomainError(`partners.error.${code}`, status, params);
};
const assertUuid = (id: string, what = "notFound") => {
  if (!UUID_RE.test(id)) fail(what, {}, 404);
};

/** Ліміт повторної атрибуції замовлень після зміни коду (найновіші). */
export const REATTRIBUTE_LIMIT = 500;

// ---------------------------------------------------------------------------
// Перевірка полів
// ---------------------------------------------------------------------------

function parseName(raw: string | null | undefined): string {
  const name = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!name) fail("nameEmpty");
  if (name.length > PARTNER_NAME_MAX) fail("nameTooLong", { max: PARTNER_NAME_MAX });
  return name;
}

function parseKind(raw: string | null | undefined): PartnerKind {
  const k = (raw ?? "") as PartnerKind;
  if (!(PARTNER_KINDS as readonly string[]).includes(k)) fail("kindInvalid");
  return k;
}

function parseStatus(raw: string | null | undefined): PartnerStatus {
  const s = (raw ?? "") as PartnerStatus;
  if (!(PARTNER_STATUSES as readonly string[]).includes(s)) fail("statusInvalid");
  return s;
}

function parseSource(raw: string | null | undefined): PartnerCodeSource {
  const s = (raw ?? "") as PartnerCodeSource;
  if (!(PARTNER_CODE_SOURCES as readonly string[]).includes(s)) fail("codeSourceInvalid");
  return s;
}

function holdDaysOf(raw: string | number | null | undefined): number {
  const n = parseHoldDays(raw);
  if (n === null) fail("holdDaysInvalid");
  return n!;
}

function rateBpOf(bp: number | null | undefined): number {
  if (bp === null || bp === undefined || !Number.isInteger(bp) || bp < 0 || bp > 10_000) fail("rateInvalid");
  return bp!;
}

function payoutCurrencyOf(raw: string | null | undefined): string | null {
  const c = (raw ?? "").trim().toUpperCase();
  if (!c) return null;
  if (!isSupportedCurrency(c)) fail("currencyInvalid");
  return c;
}

function reasonOf(raw: string | null | undefined, required: boolean): string | null {
  const r = maskFreeTextNote(raw, 300);
  if (required && !r) fail("reasonRequired");
  return r;
}

export interface CodeInput {
  source: string;
  code: string;
  validFrom?: string | null;
  validTo?: string | null;
}

function parseCodeInput(input: CodeInput): { source: PartnerCodeSource; code: string; norm: string; validFrom: string | null; validTo: string | null } {
  const source = parseSource(input.source);
  const parsed = parsePartnerCode(input.code);
  if (!parsed.ok) throw new DomainError(parsed.error, 400);
  const validity = parseValidity(input.validFrom, input.validTo);
  if (!validity.ok) fail("validityInvalid");
  const v = validity as { validFrom: string | null; validTo: string | null };
  return { source, code: parsed.code, norm: parsed.norm, validFrom: v.validFrom, validTo: v.validTo };
}

async function assertCodeFree(tx: Tx, source: PartnerCodeSource, norm: string, code: string): Promise<void> {
  const [taken] = await tx
    .select({ id: partnerCodes.id })
    .from(partnerCodes)
    .where(and(eq(partnerCodes.source, source), eq(partnerCodes.codeNorm, norm), eq(partnerCodes.active, true)));
  if (taken) fail("codeTaken", { code }, 409);
}

// ---------------------------------------------------------------------------
// Синхронізація замовлень після рішень власника (у транзакції)
// ---------------------------------------------------------------------------

/**
 * Перерахунок одного замовлення після рішення власника (викликач тримає транзакцію): фінанси замовлення (WP4 — вона ж
 * проводить винагороду з усіма вхідними даними, зокрема підтвердженими сумами); якщо syncOrderFinance винагороду не
 * провела (заглушка або інша причина) — syncPartnerCommission тут. Ніколи двічі (другий виклик без confirmedProducts
 * зіпсував би прогноз «Очікується»).
 */
async function resyncOrder(tx: Tx, ctx: Ctx, orderId: string): Promise<void> {
  await lockFinanceOrder(tx, orderId);
  const { synced } = await watchPartnerSyncs(() => syncOrderFinance(tx, ctx.actor, orderId));
  if (!synced.has(orderId)) await syncPartnerCommission(tx, ctx.actor, orderId, { now: ctx.now() });
}

/**
 * Перерахунок замовлень (у порядку id). Повертає кількість замовлень, що тепер атрибутовані партнеру `partnerId`
 * (якщо задано).
 */
async function resyncOrders(tx: Tx, ctx: Ctx, orderIds: readonly string[], partnerId?: string): Promise<number> {
  const ids = [...new Set(orderIds)].sort();
  for (const orderId of ids) await resyncOrder(tx, ctx, orderId);
  if (!partnerId || ids.length === 0) return 0;
  const [row] = await tx
    .select({ c: count() })
    .from(partnerAttributions)
    .where(and(inArray(partnerAttributions.orderId, ids), eq(partnerAttributions.partnerId, partnerId), eq(partnerAttributions.status, "attributed")));
  return Number(row?.c ?? 0);
}

/** Серіалізація перевірки «назва вільна» й запису (FINANCE_OP_LOCK за нормалізованою назвою). */
function lockPartnerName(tx: Tx, displayName: string): Promise<void> {
  return lockFinanceOperation(tx, `partner-name:${displayName.normalize("NFC").toLowerCase()}`);
}

/**
 * Код, значення якого вже було в іншого (вимкненого) коду: без дати початку діє з сьогодні — інакше старіші
 * замовлення з цим значенням стали б неоднозначними між старим і новим партнером. Повертає дату початку або null.
 */
async function reusedCodeStart(tx: Tx, c: { source: PartnerCodeSource; norm: string; validFrom: string | null; validTo: string | null }, today: string): Promise<string | null> {
  if (c.validFrom !== null || (c.validTo !== null && c.validTo < today)) return null;
  const [old] = await tx
    .select({ id: partnerCodes.id })
    .from(partnerCodes)
    .where(and(eq(partnerCodes.source, c.source), eq(partnerCodes.codeNorm, c.norm), eq(partnerCodes.active, false)))
    .limit(1);
  return old ? today : null;
}

// ---------------------------------------------------------------------------
// Партнери
// ---------------------------------------------------------------------------

export interface CreatePartnerInput {
  displayName: string;
  kind: string;
  rateBp: number | null;
  holdDays: string | number;
  payoutCurrency?: string | null;
  note?: string | null;
  codes?: CodeInput[];
}

/** «Додати партнера»: ім'я, тип, відсоток, днів утримання, коди. Повертає id і скільки наявних замовлень атрибутовано. */
export async function createPartner(ctx: Ctx, input: CreatePartnerInput): Promise<{ id: string; attributed: number; reusedCodes: number }> {
  requireFinance(ctx, "manage");
  const displayName = parseName(input.displayName);
  const kind = parseKind(input.kind);
  const rateBp = rateBpOf(input.rateBp);
  const holdDays = holdDaysOf(input.holdDays);
  const payoutCurrency = payoutCurrencyOf(input.payoutCurrency);
  const note = maskFreeTextNote(input.note, PARTNER_NOTE_MAX);
  const codes = (input.codes ?? []).filter((c) => (c.code ?? "").trim() !== "").map(parseCodeInput);
  const seen = new Set<string>();
  for (const c of codes) {
    const k = `${c.source}|${c.norm}`;
    if (seen.has(k)) fail("codeDuplicate", { code: c.code });
    seen.add(k);
  }
  const today = businessDate(ctx.now());
  return ctx.db.transaction(async (tx) => {
    await lockPartnerName(tx, displayName);
    const [dup] = await tx
      .select({ id: partners.id })
      .from(partners)
      .where(and(sql`lower(${partners.displayName}) = lower(${displayName})`, ne(partners.status, "archived")));
    if (dup) fail("nameTaken", {}, 409);
    let reusedCodes = 0;
    for (const c of codes) {
      await assertCodeFree(tx, c.source, c.norm, c.code);
      const start = await reusedCodeStart(tx, c, today);
      if (start) {
        c.validFrom = start;
        reusedCodes++;
      }
    }
    const [p] = await tx
      .insert(partners)
      .values({ displayName, kind, holdDays, payoutCurrency, note, createdBy: ctx.actor.id })
      .returning({ id: partners.id, version: partners.version, status: partners.status });
    const id = p!.id;
    const [rate] = await tx.insert(partnerRates).values({ partnerId: id, codeId: null, rateBp, effectiveFrom: today, reason: null, createdBy: ctx.actor.id }).returning({ id: partnerRates.id });
    await writeFinanceChange(tx, ctx.actor, {
      entityType: "partner",
      entityId: id,
      action: "create",
      after: { kind, status: p!.status, holdDays, payoutCurrency, version: p!.version },
    });
    await writeFinanceChange(tx, ctx.actor, { entityType: "partner_rate", entityId: rate!.id, action: "create", after: { partnerId: id, codeId: null, rateBp, effectiveFrom: today } });
    for (const c of codes) {
      const [row] = await tx
        .insert(partnerCodes)
        .values({ partnerId: id, code: c.code, codeNorm: c.norm, source: c.source, validFrom: c.validFrom, validTo: c.validTo, createdBy: ctx.actor.id })
        .returning({ id: partnerCodes.id });
      await writeFinanceChange(tx, ctx.actor, {
        entityType: "partner_code",
        entityId: row!.id,
        action: "create",
        after: { partnerId: id, code: c.norm, source: c.source, validFrom: c.validFrom, validTo: c.validTo, active: true },
      });
    }
    await writeAudit(tx, ctx.actor, "finance.partner_created", { type: "partner", id }, { codes: codes.length });
    const orderIds: string[] = [];
    for (const c of codes) orderIds.push(...(await ordersWithCode(tx, c.source, c.norm, REATTRIBUTE_LIMIT)));
    const attributed = await resyncOrders(tx, ctx, orderIds, id);
    return { id, attributed, reusedCodes };
  });
}

export interface UpdatePartnerInput {
  id: string;
  expectedVersion: number;
  displayName: string;
  kind: string;
  status: string;
  holdDays: string | number;
  payoutCurrency?: string | null;
  note?: string | null;
  reason?: string | null;
}

/**
 * Зміна партнера (CAS за version). Дні утримання й ставки діють для нових атрибуцій (уже ухвалені зафіксовані); пауза
 * чи архів — нові замовлення з кодами партнера не атрибутуються, ухвалені атрибуції лишаються.
 */
export async function updatePartner(ctx: Ctx, input: UpdatePartnerInput): Promise<{ version: number }> {
  requireFinance(ctx, "manage");
  assertUuid(input.id);
  const displayName = parseName(input.displayName);
  const kind = parseKind(input.kind);
  const status = parseStatus(input.status);
  const holdDays = holdDaysOf(input.holdDays);
  const payoutCurrency = payoutCurrencyOf(input.payoutCurrency);
  const note = maskFreeTextNote(input.note, PARTNER_NOTE_MAX);
  const reason = reasonOf(input.reason, false);
  return ctx.db.transaction(async (tx) => {
    if (status !== "archived") await lockPartnerName(tx, displayName);
    const [row] = await tx.select().from(partners).where(eq(partners.id, input.id)).for("update");
    if (!row) throw new NotFoundError("partner");
    if (row.version !== input.expectedVersion) throw new ConflictError();
    if (status !== "archived" && (displayName.toLowerCase() !== row.displayName.toLowerCase() || row.status === "archived")) {
      const [dup] = await tx
        .select({ id: partners.id })
        .from(partners)
        .where(and(sql`lower(${partners.displayName}) = lower(${displayName})`, ne(partners.status, "archived"), ne(partners.id, row.id)));
      if (dup) fail("nameTaken", {}, 409);
    }
    const [updated] = await tx
      .update(partners)
      .set({ displayName, kind, status, holdDays, payoutCurrency, note, version: row.version + 1, updatedAt: new Date() })
      .where(and(eq(partners.id, row.id), eq(partners.version, row.version)))
      .returning({ version: partners.version });
    if (!updated) throw new ConflictError();
    await writeFinanceChange(tx, ctx.actor, {
      entityType: "partner",
      entityId: row.id,
      action: "update",
      before: { kind: row.kind, status: row.status, holdDays: row.holdDays, payoutCurrency: row.payoutCurrency, version: row.version },
      after: { kind, status, holdDays, payoutCurrency, version: updated.version, nameChanged: displayName !== row.displayName },
      reason,
    });
    await writeAudit(tx, ctx.actor, "finance.partner_updated", { type: "partner", id: row.id }, { version: updated.version });
    return { version: updated.version };
  });
}

/** Новий код партнера (код знижки Shopify або реферальний) + атрибуція наявних замовлень із цим кодом. */
export async function addPartnerCode(ctx: Ctx, input: CodeInput & { partnerId: string }): Promise<{ id: string; attributed: number; validFrom: string | null; reused: boolean }> {
  requireFinance(ctx, "manage");
  assertUuid(input.partnerId);
  const c = parseCodeInput(input);
  const today = businessDate(ctx.now());
  return ctx.db.transaction(async (tx) => {
    const [p] = await tx.select({ id: partners.id }).from(partners).where(eq(partners.id, input.partnerId)).for("update");
    if (!p) throw new NotFoundError("partner");
    await assertCodeFree(tx, c.source, c.norm, c.code);
    const start = await reusedCodeStart(tx, c, today);
    if (start) c.validFrom = start;
    const [row] = await tx
      .insert(partnerCodes)
      .values({ partnerId: p.id, code: c.code, codeNorm: c.norm, source: c.source, validFrom: c.validFrom, validTo: c.validTo, createdBy: ctx.actor.id })
      .returning({ id: partnerCodes.id });
    await writeFinanceChange(tx, ctx.actor, {
      entityType: "partner_code",
      entityId: row!.id,
      action: "create",
      after: { partnerId: p.id, code: c.norm, source: c.source, validFrom: c.validFrom, validTo: c.validTo, active: true },
    });
    await writeAudit(tx, ctx.actor, "finance.partner_code_added", { type: "partner_code", id: row!.id }, { partnerId: p.id });
    const attributed = await resyncOrders(tx, ctx, await ordersWithCode(tx, c.source, c.norm, REATTRIBUTE_LIMIT), p.id);
    return { id: row!.id, attributed, validFrom: c.validFrom, reused: start !== null };
  });
}

/**
 * Вимкнути код: нові замовлення з ним не атрибутуються; уже ухвалені атрибуції цього коду (і нараховані винагороди)
 * лишаються за партнером (sync.server.ts фіксує атрибуцію); перераховуються лише неоднозначні атрибуції, де цей код був
 * одним із кандидатів (вимкнення може зняти неоднозначність).
 */
export async function deactivatePartnerCode(ctx: Ctx, input: { codeId: string; reason?: string | null }): Promise<{ resynced: number }> {
  requireFinance(ctx, "manage");
  assertUuid(input.codeId);
  const reason = reasonOf(input.reason, false);
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(partnerCodes).where(eq(partnerCodes.id, input.codeId)).for("update");
    if (!row) throw new NotFoundError("partner_code");
    if (!row.active) return { resynced: 0 };
    await tx.update(partnerCodes).set({ active: false }).where(eq(partnerCodes.id, row.id));
    await writeFinanceChange(tx, ctx.actor, {
      entityType: "partner_code",
      entityId: row.id,
      action: "update",
      before: { partnerId: row.partnerId, code: row.codeNorm, source: row.source, active: true },
      after: { active: false },
      reason,
    });
    await writeAudit(tx, ctx.actor, "finance.partner_code_deactivated", { type: "partner_code", id: row.id }, { partnerId: row.partnerId });
    const affected = await tx
      .select({ orderId: partnerAttributions.orderId })
      .from(partnerAttributions)
      .where(
        and(
          eq(partnerAttributions.status, "ambiguous"),
          ne(partnerAttributions.source, "owner"),
          sql`${partnerAttributions.details} -> 'codeIds' @> ${JSON.stringify([row.id])}::jsonb`,
        ),
      )
      .limit(REATTRIBUTE_LIMIT);
    await resyncOrders(tx, ctx, affected.map((a) => a.orderId));
    return { resynced: affected.length };
  });
}

/** Нова ставка з датою дії (для партнера або окремого коду). Діє для замовлень з цієї дати (на дату замовлення). */
export async function addPartnerRate(
  ctx: Ctx,
  input: { partnerId: string; codeId?: string | null; rateBp: number | null; effectiveFrom: string; reason?: string | null },
): Promise<{ id: string }> {
  requireFinance(ctx, "manage");
  assertUuid(input.partnerId);
  const rateBp = rateBpOf(input.rateBp);
  const effectiveFrom = parseIsoDate(input.effectiveFrom);
  if (!effectiveFrom) fail("dateInvalid");
  const codeId = input.codeId ? input.codeId : null;
  if (codeId) assertUuid(codeId, "codeNotOfPartner");
  const reason = reasonOf(input.reason, false);
  return ctx.db.transaction(async (tx) => {
    const [p] = await tx.select({ id: partners.id }).from(partners).where(eq(partners.id, input.partnerId)).for("update");
    if (!p) throw new NotFoundError("partner");
    if (codeId) {
      const [c] = await tx.select({ id: partnerCodes.id }).from(partnerCodes).where(and(eq(partnerCodes.id, codeId), eq(partnerCodes.partnerId, p.id)));
      if (!c) fail("codeNotOfPartner", {}, 404);
    }
    const [exists] = await tx
      .select({ id: partnerRates.id })
      .from(partnerRates)
      .where(and(eq(partnerRates.partnerId, p.id), codeId ? eq(partnerRates.codeId, codeId) : isNull(partnerRates.codeId), eq(partnerRates.effectiveFrom, effectiveFrom!)));
    if (exists) fail("rateExists", { date: effectiveFrom! }, 409);
    const [row] = await tx
      .insert(partnerRates)
      .values({ partnerId: p.id, codeId, rateBp, effectiveFrom: effectiveFrom!, reason, createdBy: ctx.actor.id })
      .returning({ id: partnerRates.id });
    await writeFinanceChange(tx, ctx.actor, {
      entityType: "partner_rate",
      entityId: row!.id,
      action: "create",
      after: { partnerId: p.id, codeId, rateBp, effectiveFrom: effectiveFrom! },
      reason,
    });
    await writeAudit(tx, ctx.actor, "finance.partner_rate_added", { type: "partner_rate", id: row!.id }, { partnerId: p.id });
    return { id: row!.id };
  });
}

// ---------------------------------------------------------------------------
// Атрибуція замовлення (рішення власника)
// ---------------------------------------------------------------------------

export interface SetAttributionInput {
  orderId: string;
  /** manual — призначити partnerId або зняти (null); auto — скасувати ручне рішення (діє автоматична атрибуція). */
  mode: "manual" | "auto";
  partnerId?: string | null;
  codeId?: string | null;
  reason: string;
}

/** «Партнер: змінити» / «Обрати партнера» (неоднозначна атрибуція): з причиною й історією змін. */
export async function setOrderAttribution(ctx: Ctx, input: SetAttributionInput): Promise<{ status: "attributed" | "removed" | "auto"; events: number }> {
  requireFinance(ctx, "manage");
  assertUuid(input.orderId, "orderNotFound");
  const reason = reasonOf(input.reason, true);
  const partnerId = input.mode === "manual" ? (input.partnerId ?? null) : null;
  if (partnerId) assertUuid(partnerId);
  const codeId = partnerId && input.codeId ? input.codeId : null;
  if (codeId) assertUuid(codeId, "codeNotOfPartner");
  const settings = await loadFinanceSettings(ctx.db);
  const result = await ctx.db.transaction(async (tx) => {
    await lockFinanceOrder(tx, input.orderId);
    const [order] = await tx.select({ id: orders.id, placedAt: orders.placedAt }).from(orders).where(eq(orders.id, input.orderId));
    if (!order) fail("orderNotFound", {}, 404);
    const [before] = await tx.select().from(partnerAttributions).where(eq(partnerAttributions.orderId, input.orderId)).for("update");
    const beforeLog = before
      ? { orderId: before.orderId, partnerId: before.partnerId, codeId: before.codeId, source: before.source, rateBp: before.rateBp ?? undefined, holdDays: before.holdDays ?? undefined, status: before.status }
      : null;
    let status: "attributed" | "removed" | "auto";
    let after: Record<string, unknown>;
    if (input.mode === "auto") {
      if (before && before.source === "owner") await tx.delete(partnerAttributions).where(eq(partnerAttributions.orderId, input.orderId));
      status = "auto";
      after = { orderId: input.orderId, status: "removed", source: "owner" };
    } else if (partnerId) {
      if (codeId) {
        const [c] = await tx.select({ id: partnerCodes.id }).from(partnerCodes).where(and(eq(partnerCodes.id, codeId), eq(partnerCodes.partnerId, partnerId)));
        if (!c) fail("codeNotOfPartner", {}, 404);
      }
      const terms = await partnerTermsOn(tx, partnerId, codeId, businessDate(order!.placedAt), settings.partners.defaultRateBp);
      if (!terms) throw new NotFoundError("partner");
      const values = {
        partnerId,
        codeId,
        source: "owner" as const,
        rateBp: terms!.rateBp,
        holdDays: terms!.holdDays,
        status: "attributed" as const,
        details: {},
        decidedBy: ctx.actor.id,
        decidedAt: ctx.now(),
        reason,
      };
      await tx.insert(partnerAttributions).values({ orderId: input.orderId, ...values }).onConflictDoUpdate({ target: partnerAttributions.orderId, set: values });
      status = "attributed";
      after = { orderId: input.orderId, partnerId, codeId, source: "owner", rateBp: terms!.rateBp, holdDays: terms!.holdDays, status: "attributed" };
    } else {
      const values = { partnerId: null, codeId: null, source: "owner" as const, rateBp: null, holdDays: null, status: "removed" as const, details: {}, decidedBy: ctx.actor.id, decidedAt: ctx.now(), reason };
      await tx.insert(partnerAttributions).values({ orderId: input.orderId, ...values }).onConflictDoUpdate({ target: partnerAttributions.orderId, set: values });
      status = "removed";
      after = { orderId: input.orderId, partnerId: null, codeId: null, source: "owner", status: "removed" };
    }
    await writeFinanceChange(tx, ctx.actor, {
      entityType: "partner_attribution",
      entityId: input.orderId,
      action: input.mode === "auto" ? "reopen" : before ? "update" : "create",
      before: beforeLog,
      after,
      reason,
    });
    const [open] = await tx
      .select({ id: financeDiscrepancies.id, version: financeDiscrepancies.version })
      .from(financeDiscrepancies)
      .where(and(eq(financeDiscrepancies.dedupeKey, ambiguityKey(input.orderId)), eq(financeDiscrepancies.status, "open")));
    if (open && input.mode === "manual") {
      await resolveDiscrepancy({ db: tx, actor: ctx.actor }, { id: open.id, status: "resolved", resolutionCode: "partner_chosen", note: reason, expectedVersion: open.version });
    }
    await writeAudit(tx, ctx.actor, "finance.partner_attribution_set", { type: "order", id: input.orderId }, { status });
    const eventsBefore = await countOrderEvents(tx, input.orderId);
    await resyncOrder(tx, ctx, input.orderId);
    return { status, events: (await countOrderEvents(tx, input.orderId)) - eventsBefore };
  });
  return result;
}

async function countOrderEvents(tx: Tx, orderId: string): Promise<number> {
  const [row] = await tx.select({ c: count() }).from(partnerCommissionEvents).where(eq(partnerCommissionEvents.orderId, orderId));
  return Number(row?.c ?? 0);
}

// ---------------------------------------------------------------------------
// Читання
// ---------------------------------------------------------------------------

export interface PartnerCodeView {
  id: string;
  code: string;
  source: PartnerCodeSource;
  validFrom: string | null;
  validTo: string | null;
  active: boolean;
}

export type LedgerTotals = Omit<CurrencyLedger, "orders">;

export interface PartnerListItem {
  id: string;
  displayName: string;
  kind: PartnerKind;
  status: PartnerStatus;
  holdDays: number;
  payoutCurrency: string | null;
  codes: PartnerCodeView[];
  /** Чинна ставка партнера сьогодні (bp). */
  rateBp: number | null;
  /** Атрибутованих замовлень, оформлених у періоді. */
  ordersInPeriod: number;
  ledger: LedgerTotals[];
  /** Очікується (прогноз до визнання), ≥ 0 за валютами. */
  expected: Money[];
}

export interface AmbiguousAttribution {
  orderId: string;
  orderNumber: string;
  placedOn: string;
  candidates: Array<{ id: string; displayName: string }>;
  codes: string[];
}

async function loadLedgers(db: Ctx["db"], partnerIds: readonly string[], today: string): Promise<Map<string, CurrencyLedger[]>> {
  const out = new Map<string, CurrencyLedger[]>();
  if (partnerIds.length === 0) return out;
  // Події з ознакою чинності (сторновані — замовлення виключено — у баланс не входять, ledger.ts).
  const events = await loadPartnerEvents(db, partnerIds);
  const payouts = await db
    .select({ partnerId: partnerPayouts.partnerId, id: partnerPayouts.id, coversAmount: partnerPayouts.coversAmount, coversCurrency: partnerPayouts.coversCurrency, status: partnerPayouts.status })
    .from(partnerPayouts)
    .where(inArray(partnerPayouts.partnerId, [...partnerIds]));
  for (const id of partnerIds) {
    const ev: LedgerEvent[] = events.filter((e) => e.partnerId === id);
    const pay: LedgerPayout[] = payouts.filter((p) => p.partnerId === id);
    out.set(id, deriveLedger(ev, pay, today));
  }
  return out;
}

async function expectedByPartner(db: Ctx["db"], partnerIds: readonly string[]): Promise<Map<string, Money[]>> {
  const out = new Map<string, Money[]>();
  if (partnerIds.length === 0) return out;
  const rows = await db
    .select({ partnerId: partnerAttributions.partnerId, currency: orderFinanceForecasts.currency, amount: sql<string>`sum(${orderFinanceForecasts.amount})::text` })
    .from(orderFinanceForecasts)
    .innerJoin(partnerAttributions, eq(partnerAttributions.orderId, orderFinanceForecasts.orderId))
    .where(and(eq(orderFinanceForecasts.component, "partner"), eq(partnerAttributions.status, "attributed"), inArray(partnerAttributions.partnerId, [...partnerIds])))
    .groupBy(partnerAttributions.partnerId, orderFinanceForecasts.currency);
  for (const r of rows) {
    if (!r.partnerId) continue;
    const amount = fromMinor(-toMinorForCurrency(r.amount, r.currency));
    out.set(r.partnerId, [...(out.get(r.partnerId) ?? []), { amount, currency: r.currency }]);
  }
  return out;
}

function totalsOf(l: CurrencyLedger): LedgerTotals {
  const { orders: _orders, ...rest } = l;
  return rest;
}

/** Список партнерів (§18.6) + неоднозначні атрибуції («Обрати партнера»). */
export async function listPartners(ctx: Ctx, input: { range: DateRange; includeArchived?: boolean }): Promise<{ partners: PartnerListItem[]; ambiguous: AmbiguousAttribution[] }> {
  requireFinance(ctx, "view");
  const today = businessDate(ctx.now());
  const rows = await ctx.db
    .select()
    .from(partners)
    .where(input.includeArchived ? undefined : ne(partners.status, "archived"))
    .orderBy(asc(partners.displayName), asc(partners.id));
  const ids = rows.map((r) => r.id);
  const [codes, rates, ledgers, expected, counts] = [
    ids.length ? await ctx.db.select().from(partnerCodes).where(inArray(partnerCodes.partnerId, ids)).orderBy(desc(partnerCodes.active), asc(partnerCodes.codeNorm)) : [],
    ids.length ? await ctx.db.select({ partnerId: partnerRates.partnerId, codeId: partnerRates.codeId, rateBp: partnerRates.rateBp, effectiveFrom: partnerRates.effectiveFrom }).from(partnerRates).where(inArray(partnerRates.partnerId, ids)) : [],
    await loadLedgers(ctx.db, ids, today),
    await expectedByPartner(ctx.db, ids),
    ids.length
      ? await ctx.db
          .select({ partnerId: partnerAttributions.partnerId, c: sql<number>`count(*)::int` })
          .from(partnerAttributions)
          .innerJoin(orders, eq(orders.id, partnerAttributions.orderId))
          .where(
            and(
              eq(partnerAttributions.status, "attributed"),
              inArray(partnerAttributions.partnerId, ids),
              gte(sql`(${orders.placedAt} at time zone 'Europe/Kyiv')::date`, input.range.from),
              lte(sql`(${orders.placedAt} at time zone 'Europe/Kyiv')::date`, input.range.to),
            ),
          )
          .groupBy(partnerAttributions.partnerId)
      : [],
  ];
  const list: PartnerListItem[] = rows.map((p) => ({
    id: p.id,
    displayName: p.displayName,
    kind: p.kind,
    status: p.status,
    holdDays: p.holdDays,
    payoutCurrency: p.payoutCurrency,
    codes: codes.filter((c) => c.partnerId === p.id).map(codeView),
    rateBp: rateOn(rates.filter((r) => r.partnerId === p.id && r.codeId === null), null, today),
    ordersInPeriod: Number(counts.find((c) => c.partnerId === p.id)?.c ?? 0),
    ledger: (ledgers.get(p.id) ?? []).map(totalsOf),
    expected: expected.get(p.id) ?? [],
  }));
  return { partners: list, ambiguous: await loadAmbiguous(ctx) };
}

function codeView(c: typeof partnerCodes.$inferSelect): PartnerCodeView {
  return { id: c.id, code: c.code, source: c.source as PartnerCodeSource, validFrom: c.validFrom, validTo: c.validTo, active: c.active };
}

async function loadAmbiguous(ctx: Ctx, limit = 100): Promise<AmbiguousAttribution[]> {
  const rows = await ctx.db
    .select({ orderId: partnerAttributions.orderId, details: partnerAttributions.details, orderNumber: orders.orderNumber, placedAt: orders.placedAt, discountCodes: orderShopifyFinance.discountCodes })
    .from(partnerAttributions)
    .innerJoin(orders, eq(orders.id, partnerAttributions.orderId))
    .leftJoin(orderShopifyFinance, eq(orderShopifyFinance.orderId, partnerAttributions.orderId))
    .where(eq(partnerAttributions.status, "ambiguous"))
    .orderBy(desc(orders.placedAt))
    .limit(limit);
  if (rows.length === 0) return [];
  const partnerIds = [...new Set(rows.flatMap((r) => (Array.isArray(r.details.partnerIds) ? (r.details.partnerIds as string[]) : [])))].filter((id) => UUID_RE.test(id));
  const names = partnerIds.length ? await ctx.db.select({ id: partners.id, displayName: partners.displayName }).from(partners).where(inArray(partners.id, partnerIds)) : [];
  return rows.map((r) => ({
    orderId: r.orderId,
    orderNumber: r.orderNumber,
    placedOn: businessDate(r.placedAt),
    candidates: (Array.isArray(r.details.partnerIds) ? (r.details.partnerIds as string[]) : []).flatMap((id) => names.filter((n) => n.id === id)),
    codes: r.discountCodes ?? [],
  }));
}

/** Партнери для вибору («Партнер: змінити» на картці замовлення, «Обрати партнера»). */
export async function listPartnerOptions(ctx: Ctx): Promise<Array<{ id: string; displayName: string; status: PartnerStatus }>> {
  requireFinance(ctx, "view");
  return ctx.db
    .select({ id: partners.id, displayName: partners.displayName, status: partners.status })
    .from(partners)
    .where(ne(partners.status, "archived"))
    .orderBy(asc(partners.displayName));
}

export interface CommissionRowView {
  orderId: string;
  orderNumber: string;
  currency: string;
  firstOn: string;
  lastOn: string;
  base: string;
  rateBp: number;
  net: string;
  accrued: string;
  adjustments: string;
  paid: string;
  outstanding: string;
  /** Непокрита дозріла частина / непокрита частина в утриманні (утримання — для кожної додатної події окремо). */
  payable: string;
  inHold: string;
  holdUntil: string | null;
  state: "accrued" | "payable" | "paid" | "cancelled";
}

export interface ExpectedRowView {
  orderId: string;
  orderNumber: string;
  placedOn: string;
  amount: Money;
}

export interface PayoutView {
  id: string;
  paidOn: string;
  amount: Money;
  covers: Money;
  method: string;
  reference: string | null;
  note: string | null;
  status: "active" | "voided";
  voidReason: string | null;
  createdAt: string;
}

export interface FixedFeeView {
  id: string;
  date: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  amount: Money;
  status: string;
  description: string | null;
}

export interface PartnerDetail {
  partner: {
    id: string;
    displayName: string;
    kind: PartnerKind;
    status: PartnerStatus;
    holdDays: number;
    payoutCurrency: string | null;
    note: string | null;
    version: number;
    createdAt: string;
  };
  codes: PartnerCodeView[];
  rates: Array<{ id: string; codeId: string | null; code: string | null; rateBp: number; effectiveFrom: string; reason: string | null }>;
  currentRateBp: number | null;
  /**
   * Валюта комісії (баланс і покриття виплат): одна валюта подій, інакше валюта магазину; null — не визначено (немає
   * жодного замовлення). Не валюта виплати й не валюта звітності.
   */
  commissionCurrency: string | null;
  /** Допустимі валюти покриття виплати. */
  commissionCurrencies: string[];
  ledger: LedgerTotals[];
  commissions: CommissionRowView[];
  expected: ExpectedRowView[];
  /** Σ очікуваної винагороди за валютами (прогноз, не в балансі). */
  expectedTotals: Money[];
  payouts: PayoutView[];
  fixedFees: FixedFeeView[];
  history: FinanceChangeRow[];
}

/** Картка партнера: коди, ставки, комісії (стани), очікувані, виплати, фіксовані оплати, історія змін. */
export async function getPartnerDetail(ctx: Ctx, partnerId: string): Promise<PartnerDetail | null> {
  requireFinance(ctx, "view");
  if (!UUID_RE.test(partnerId)) return null;
  const today = businessDate(ctx.now());
  const [p] = await ctx.db.select().from(partners).where(eq(partners.id, partnerId));
  if (!p) return null;
  const codes = await ctx.db.select().from(partnerCodes).where(eq(partnerCodes.partnerId, p.id)).orderBy(desc(partnerCodes.active), asc(partnerCodes.codeNorm));
  const rates = await ctx.db.select().from(partnerRates).where(eq(partnerRates.partnerId, p.id)).orderBy(desc(partnerRates.effectiveFrom), desc(partnerRates.createdAt));
  const ledger = (await loadLedgers(ctx.db, [p.id], today)).get(p.id) ?? [];
  const orderIds = [...new Set(ledger.flatMap((l) => l.orders.map((o) => o.orderId)))];
  const numbers = orderIds.length ? await ctx.db.select({ id: orders.id, orderNumber: orders.orderNumber }).from(orders).where(inArray(orders.id, orderIds)) : [];
  const numberOf = (id: string) => numbers.find((n) => n.id === id)?.orderNumber ?? "—";
  const expectedRows = await ctx.db
    .select({ orderId: orderFinanceForecasts.orderId, currency: orderFinanceForecasts.currency, amount: orderFinanceForecasts.amount, orderNumber: orders.orderNumber, placedAt: orders.placedAt })
    .from(orderFinanceForecasts)
    .innerJoin(partnerAttributions, eq(partnerAttributions.orderId, orderFinanceForecasts.orderId))
    .innerJoin(orders, eq(orders.id, orderFinanceForecasts.orderId))
    .where(and(eq(orderFinanceForecasts.component, "partner"), eq(partnerAttributions.status, "attributed"), eq(partnerAttributions.partnerId, p.id)))
    .orderBy(desc(orders.placedAt))
    .limit(500);
  const payouts = await ctx.db.select().from(partnerPayouts).where(eq(partnerPayouts.partnerId, p.id)).orderBy(desc(partnerPayouts.paidOn), desc(partnerPayouts.createdAt));
  const fees = await ctx.db
    .select()
    .from(financeExpenses)
    .where(and(eq(financeExpenses.partnerId, p.id), eq(financeExpenses.category, "partner_fixed_fee")))
    .orderBy(desc(financeExpenses.createdAt))
    .limit(200);
  const codeOf = (id: string | null) => (id ? (codes.find((c) => c.id === id)?.code ?? null) : null);
  const history = await partnerHistory(ctx, [p.id, ...codes.map((c) => c.id), ...rates.map((r) => r.id), ...payouts.map((x) => x.id)]);
  const commissionCurrency = (await commissionCurrenciesOf(ctx.db, [p.id])).get(p.id) ?? { primary: null, allowed: [] };
  return {
    partner: {
      id: p.id,
      displayName: p.displayName,
      kind: p.kind,
      status: p.status,
      holdDays: p.holdDays,
      payoutCurrency: p.payoutCurrency,
      note: p.note,
      version: p.version,
      createdAt: p.createdAt.toISOString(),
    },
    codes: codes.map(codeView),
    rates: rates.map((r) => ({ id: r.id, codeId: r.codeId, code: codeOf(r.codeId), rateBp: r.rateBp, effectiveFrom: r.effectiveFrom, reason: r.reason })),
    currentRateBp: rateOn(rates.filter((r) => r.codeId === null), null, today),
    commissionCurrency: commissionCurrency.primary,
    commissionCurrencies: commissionCurrency.allowed,
    ledger: ledger.map(totalsOf),
    commissions: ledger.flatMap((l) =>
      l.orders.map((o) => ({
        orderId: o.orderId,
        orderNumber: numberOf(o.orderId),
        currency: o.currency,
        firstOn: o.firstOn,
        lastOn: o.lastOn,
        base: o.base,
        rateBp: o.rateBp,
        net: o.net,
        accrued: o.accrued,
        adjustments: o.adjustments,
        paid: o.paid,
        outstanding: o.outstanding,
        payable: o.payable,
        inHold: o.inHold,
        holdUntil: o.holdUntil,
        state: o.state,
      })),
    ),
    expectedTotals: (await expectedByPartner(ctx.db, [p.id])).get(p.id) ?? [],
    expected: expectedRows.map((r) => ({
      orderId: r.orderId,
      orderNumber: r.orderNumber,
      placedOn: businessDate(r.placedAt),
      amount: { amount: fromMinor(-toMinorForCurrency(r.amount, r.currency)), currency: r.currency },
    })),
    payouts: payouts.map((x) => ({
      id: x.id,
      paidOn: x.paidOn,
      amount: { amount: x.amount, currency: x.currency },
      covers: { amount: x.coversAmount, currency: x.coversCurrency },
      method: x.method,
      reference: x.reference,
      note: x.note,
      status: x.status,
      voidReason: x.voidReason,
      createdAt: x.createdAt.toISOString(),
    })),
    fixedFees: fees.map((f) => ({
      id: f.id,
      date: f.expenseDate,
      periodFrom: f.periodFrom,
      periodTo: f.periodTo,
      amount: { amount: f.amount, currency: f.currency },
      status: f.status,
      description: f.description,
    })),
    history,
  };
}

/** Історія змін партнера, його кодів, ставок і виплат (найновіші першими). */
async function partnerHistory(ctx: Ctx, entityIds: readonly string[], limit = 100): Promise<FinanceChangeRow[]> {
  requireFinance(ctx, "view");
  if (entityIds.length === 0) return [];
  return ctx.db
    .select()
    .from(financeChangeLog)
    .where(and(inArray(financeChangeLog.entityType, ["partner", "partner_code", "partner_rate", "payout"]), inArray(financeChangeLog.entityId, [...entityIds])))
    .orderBy(desc(financeChangeLog.createdAt), desc(financeChangeLog.id))
    .limit(limit);
}

/** Атрибуція й винагорода замовлення для картки «Фінанси замовлення» (WP4; §18.4 «Партнер …»). */
export async function getOrderPartner(
  ctx: Ctx,
  orderId: string,
): Promise<{
  attribution: { status: string; source: string; partnerId: string | null; displayName: string | null; code: string | null; rateBp: number | null; holdDays: number | null; decidedAt: string | null; manual: boolean } | null;
  commission: CommissionRowView | null;
  expected: Money | null;
} | null> {
  requireFinance(ctx, "view");
  if (!UUID_RE.test(orderId)) return null;
  const [a] = await ctx.db.select().from(partnerAttributions).where(eq(partnerAttributions.orderId, orderId));
  const [name] = a?.partnerId ? await ctx.db.select({ displayName: partners.displayName }).from(partners).where(eq(partners.id, a.partnerId)) : [];
  const [code] = a?.codeId ? await ctx.db.select({ code: partnerCodes.code }).from(partnerCodes).where(eq(partnerCodes.id, a.codeId)) : [];
  const events = (await loadOrderEvents(ctx.db, orderId)).filter((e) => e.active);
  let commission: CommissionRowView | null = null;
  const current = a?.partnerId ?? events[events.length - 1]?.partnerId ?? null;
  if (current && events.some((e) => e.partnerId === current)) {
    const ledger = (await loadLedgers(ctx.db, [current], businessDate(ctx.now()))).get(current) ?? [];
    const [num] = await ctx.db.select({ orderNumber: orders.orderNumber }).from(orders).where(eq(orders.id, orderId));
    for (const l of ledger) {
      const o = l.orders.find((x) => x.orderId === orderId);
      if (o) {
        const { events: _n, ...view } = o;
        commission = { ...view, orderNumber: num?.orderNumber ?? "—" };
      }
    }
  }
  const [fc] = await ctx.db
    .select({ currency: orderFinanceForecasts.currency, amount: orderFinanceForecasts.amount })
    .from(orderFinanceForecasts)
    .where(and(eq(orderFinanceForecasts.orderId, orderId), eq(orderFinanceForecasts.component, "partner")));
  return {
    attribution: a
      ? {
          status: a.status,
          source: a.source,
          partnerId: a.partnerId,
          displayName: name?.displayName ?? null,
          code: code?.code ?? null,
          rateBp: a.rateBp,
          holdDays: a.holdDays,
          decidedAt: a.decidedAt ? a.decidedAt.toISOString() : null,
          manual: a.source === "owner",
        }
      : null,
    commission,
    expected: fc ? { amount: fromMinor(-toMinorForCurrency(fc.amount, fc.currency)), currency: fc.currency } : null,
  };
}
