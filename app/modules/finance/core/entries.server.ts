/**
 * Етап 6: проведення фінансового журналу (docs/stage6-design.md F2, §3.3, §3.4, §14.5). ВНУТРІШНІ функції проведення
 * (contracts.ts INTERNAL_POSTING_FUNCTIONS): актора не перевіряють (їх запускають потоки працівників), пишуть лише
 * posted_by і НЕ повертають грошей (лише кількості). Імпорт у pages/routes/команди/ШІ заборонено (тест-сканер).
 *
 * Гарантії:
 * - (store_id, idempotency_key) унікальний: INSERT … ON CONFLICT DO NOTHING — повтор не створює другого запису (I3);
 * - сума ≠ 0 (CHECK), валюта ISO 4217 з 0 або 2 знаками, сума валюти з 0 знаками — без сотих;
 * - запис, що належить ЗАКРИТОМУ місяцю: recognized_on = дата проведення (Київ), original_on = справжня дата,
 *   fx_on = справжня дата курсу, is_late = true (перевірка під спільним FINANCE_PERIOD_LOCK);
 * - сторно (reverseEntry): та сама категорія й виміри, сума з протилежним знаком, original_on і fx_on — ЗАВЖДИ з
 *   оригіналу (оригінал + сторно = 0 у будь-якій валюті звітності, I14); recognized_on = оригіналу, якщо його місяць
 *   відкритий, інакше дата проведення з is_late = true; ключ `<ключ>:rev`, reverses_entry_id унікальний.
 * Виправлення суми — сторно + новий запис; UPDATE суми НІКОЛИ (DELETE — лише скидання демо).
 * - факт, що знову став чинним після сторно (тестове замовлення при перемиканні includeTestOrders, excluded →
 *   recognized), проводиться НОВИМ поколінням ключа (`repostEntries`, keys.ts withGeneration) — не губиться в skipped;
 *   postEntries окремо рахує skippedReversed (ключ є, але його запис сторновано — факт НЕ діє);
 * - рядки вставляються в порядку (store_id, idempotency_key): паралельні виклики з перетином ключів беруть блокування
 *   унікального індексу в одному порядку — без взаємоблокувань (§17.8, §20.3).
 */
import { and, eq, exists, inArray, isNull, like, notExists, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DbOrTx, Tx } from "~/db/client.server";
import { financeEntries } from "~/db/schema";
import { isFinanceCategory, type FinanceCategory, type FinanceSourceType, FINANCE_SOURCE_TYPES } from "~/domain/finance";
import { DomainError } from "~/lib/errors";
import { fromMinor, toMinorForCurrency, UnsupportedCurrencyError } from "~/lib/decimal";
import { businessDate, parseIsoDate } from "~/lib/periods";
import { closedMonthsAmong, monthOf } from "./closed-month.server";
import type { PostingActor } from "./contracts";
import { assertFinanceDetails, type FinanceDetailsInput } from "./details";
import { assertFinanceKey, financeKeys, generationOf, isBaseFactKey, MAX_FINANCE_KEY_LENGTH, withGeneration } from "./keys";
import { lockFinancePeriodShared } from "./locks.server";
import { DEFAULT_STORE_ID } from "./store.server";

/** Записи-сторно (самоз'єднання журналу: «чи сторновано запис»). */
const reversals = alias(financeEntries, "fe_rev");

/** Хто проводить (posted_by). Потоки працівників передають свого актора; завдання — SYSTEM_ACTOR. */
export type { PostingActor };

export interface EntryInput {
  /** Ключ із financeKeys (≤ 196 символів — лишається місце для `:rev`). */
  idempotencyKey: string;
  category: FinanceCategory;
  /** Дата періоду (Київ), до якої належить факт; закритий місяць → перенесення (див. вгорі). */
  recognizedOn: string;
  /** Дата курсу (§3.3). */
  fxOn: string;
  /** Економічна дата, якщо відрізняється від recognizedOn (типово — recognizedOn). */
  originalOn?: string;
  /** Перше фактичне значення складника, що був missing/forecast (R3). */
  isLateCompletion?: boolean;
  /** Десятковий рядок, ≠ 0; знак — за впливом на прибуток (§0 п. 2). */
  amount: string;
  currency: string;
  presentmentAmount?: string | null;
  presentmentCurrency?: string | null;
  orderId?: string | null;
  orderLineItemId?: string | null;
  variantId?: string | null;
  stockItemId?: string | null;
  quantity?: number | null;
  shipmentId?: string | null;
  partnerId?: string | null;
  carrierCode?: string | null;
  countryCode?: string | null;
  sourceType: FinanceSourceType;
  sourceId: string;
  details?: FinanceDetailsInput;
  storeId?: string;
}

export interface PostEntriesOptions {
  /** Момент проведення (дата проведення для пізніх записів). */
  now?: Date;
}

/** Результат — лише кількості (F8). */
export interface PostEntriesResult {
  inserted: number;
  /** Повтори (ключ уже був). */
  skipped: number;
  /**
   * Частина skipped: ключ уже був, але його запис СТОРНОВАНО — факт зараз не діє. Це не помилка (повтор старої версії
   * після виправлення), але факт, що знову став чинним, проводиться через repostEntries.
   */
  skippedReversed: number;
  /** Скільки вставлених записів перенесено із закритого місяця (is_late). */
  late: number;
}

/** Результат repostEntries — лише кількості. */
export interface RepostEntriesResult extends PostEntriesResult {
  /** Скільки фактів проведено новим поколінням ключа (`:g<n>`, n ≥ 2) — знову чинні після сторно. */
  reposted: number;
}

const MAX_ORIGINAL_KEY = MAX_FINANCE_KEY_LENGTH - ":rev".length;
const REASON_CODE_RE = /^[a-z0-9_.-]{1,64}$/;
const CHUNK = 400;

function invalid(field: string, key: string): never {
  throw new DomainError("finance.error.invalidEntry", 400, { field, key: key.slice(0, 80) });
}

function isoOrThrow(value: string | undefined, field: string, key: string): string {
  const iso = parseIsoDate(value ?? "");
  if (!iso) invalid(field, key);
  return iso;
}

type Row = typeof financeEntries.$inferInsert;

function normalizeEntry(e: EntryInput, actor: PostingActor): Row & { idempotencyKey: string; recognizedOn: string; storeId: string } {
  const key = e.idempotencyKey;
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_ORIGINAL_KEY) invalid("idempotencyKey", String(key));
  if (!isFinanceCategory(e.category)) invalid("category", key);
  if (!(FINANCE_SOURCE_TYPES as readonly string[]).includes(e.sourceType)) invalid("sourceType", key);
  if (typeof e.sourceId !== "string" || e.sourceId.length === 0 || e.sourceId.length > 200) invalid("sourceId", key);
  const recognizedOn = isoOrThrow(e.recognizedOn, "recognizedOn", key);
  const fxOn = isoOrThrow(e.fxOn, "fxOn", key);
  const originalOn = e.originalOn === undefined ? recognizedOn : isoOrThrow(e.originalOn, "originalOn", key);
  let minor: bigint;
  try {
    minor = toMinorForCurrency(e.amount, e.currency);
  } catch (err) {
    if (err instanceof UnsupportedCurrencyError) throw new DomainError("finance.error.unsupportedCurrency", 400, { currency: e.currency });
    invalid("amount", key);
  }
  if (minor === 0n) invalid("amount", key);
  const hasP = e.presentmentAmount != null || e.presentmentCurrency != null;
  let presentmentAmount: string | null = null;
  if (hasP) {
    if (e.presentmentAmount == null || e.presentmentCurrency == null) invalid("presentment", key);
    try {
      presentmentAmount = fromMinor(toMinorForCurrency(e.presentmentAmount, e.presentmentCurrency));
    } catch {
      invalid("presentment", key);
    }
  }
  if (e.quantity != null && !Number.isSafeInteger(e.quantity)) invalid("quantity", key);
  if (e.countryCode != null && !/^[A-Z]{2}$/.test(e.countryCode)) invalid("countryCode", key);
  return {
    storeId: e.storeId ?? DEFAULT_STORE_ID,
    idempotencyKey: key,
    category: e.category,
    recognizedOn,
    originalOn,
    fxOn,
    isLate: false,
    isLateCompletion: e.isLateCompletion ?? false,
    amount: fromMinor(minor),
    currency: e.currency,
    presentmentAmount,
    presentmentCurrency: hasP ? e.presentmentCurrency! : null,
    orderId: e.orderId ?? null,
    orderLineItemId: e.orderLineItemId ?? null,
    variantId: e.variantId ?? null,
    stockItemId: e.stockItemId ?? null,
    quantity: e.quantity ?? null,
    shipmentId: e.shipmentId ?? null,
    partnerId: e.partnerId ?? null,
    carrierCode: e.carrierCode ?? null,
    countryCode: e.countryCode ?? null,
    sourceType: e.sourceType,
    sourceId: e.sourceId,
    details: assertFinanceDetails(e.details ?? {}),
    postedBy: actor.id,
  };
}

/** Блокує місяці (спільно, у порядку) і повертає закриті серед них. */
async function lockMonths(tx: Tx, storeId: string, dates: readonly string[]): Promise<Set<string>> {
  const months = [...new Set(dates.map(monthOf))].sort();
  for (const m of months) await lockFinancePeriodShared(tx, storeId, m);
  return closedMonthsAmong(tx, months, storeId);
}

/** Порядок блокувань унікального індексу: (store_id, idempotency_key), порівняння за кодовими одиницями (не локаль). */
function compareRowKeys(a: { storeId: string; idempotencyKey: string }, b: { storeId: string; idempotencyKey: string }): number {
  if (a.storeId !== b.storeId) return a.storeId < b.storeId ? -1 : 1;
  if (a.idempotencyKey === b.idempotencyKey) return 0;
  return a.idempotencyKey < b.idempotencyKey ? -1 : 1;
}

const storeKey = (storeId: string, key: string) => `${storeId}|${key}`;

/** Ключі серед `keys` магазину, чий запис уже сторновано. */
async function reversedKeysAmong(tx: Tx, storeId: string, keys: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < keys.length; i += CHUNK) {
    const found = await tx
      .select({ key: financeEntries.idempotencyKey })
      .from(financeEntries)
      .where(
        and(
          eq(financeEntries.storeId, storeId),
          inArray(financeEntries.idempotencyKey, keys.slice(i, i + CHUNK)),
          exists(tx.select({ one: sql`1` }).from(reversals).where(eq(reversals.reversesEntryId, financeEntries.id))),
        ),
      );
    for (const f of found) out.add(f.key);
  }
  return out;
}

/** Перевірка, перенесення із закритих місяців і вставка (спільне для postEntries / repostEntries). */
async function insertEntries(
  tx: Tx,
  actor: PostingActor,
  entries: readonly EntryInput[],
  opts: PostEntriesOptions,
): Promise<PostEntriesResult & { insertedKeys: Set<string> }> {
  const insertedKeys = new Set<string>();
  if (entries.length === 0) return { inserted: 0, skipped: 0, skippedReversed: 0, late: 0, insertedKeys };
  const rows = entries.map((e) => normalizeEntry(e, actor));
  const seen = new Set<string>();
  for (const r of rows) {
    const k = storeKey(r.storeId, r.idempotencyKey);
    if (seen.has(k)) invalid("duplicateKey", r.idempotencyKey);
    seen.add(k);
  }
  // Детермінований порядок вставки → однаковий порядок блокувань унікального індексу в усіх викликачів.
  rows.sort(compareRowKeys);
  const postingDate = businessDate(opts.now ?? new Date());
  const byStore = new Map<string, typeof rows>();
  for (const r of rows) byStore.set(r.storeId, [...(byStore.get(r.storeId) ?? []), r]);
  for (const [storeId, list] of [...byStore].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const closed = await lockMonths(tx, storeId, list.map((r) => r.recognizedOn));
    for (const r of list) {
      if (closed.has(monthOf(r.recognizedOn))) {
        r.recognizedOn = postingDate;
        r.isLate = true;
      }
    }
  }
  let late = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const out = await tx
      .insert(financeEntries)
      .values(rows.slice(i, i + CHUNK))
      .onConflictDoNothing({ target: [financeEntries.storeId, financeEntries.idempotencyKey] })
      .returning({ storeId: financeEntries.storeId, key: financeEntries.idempotencyKey, isLate: financeEntries.isLate });
    for (const r of out) {
      insertedKeys.add(storeKey(r.storeId, r.key));
      if (r.isLate) late++;
    }
  }
  let skippedReversed = 0;
  for (const [storeId, list] of byStore) {
    const skippedKeys = list.filter((r) => !insertedKeys.has(storeKey(storeId, r.idempotencyKey))).map((r) => r.idempotencyKey);
    if (skippedKeys.length) skippedReversed += (await reversedKeysAmong(tx, storeId, skippedKeys)).size;
  }
  return { inserted: insertedKeys.size, skipped: rows.length - insertedKeys.size, skippedReversed, late, insertedKeys };
}

/**
 * Проводить записи (ідемпотентно; див. гарантії вгорі файла). Викликати в транзакції викликача.
 */
export async function postEntries(
  tx: Tx,
  actor: PostingActor,
  entries: readonly EntryInput[],
  opts: PostEntriesOptions = {},
): Promise<PostEntriesResult> {
  const r = await insertEntries(tx, actor, entries, opts);
  return { inserted: r.inserted, skipped: r.skipped, skippedReversed: r.skippedReversed, late: r.late };
}

/**
 * Проведення фактів, що можуть бути сторновані й ЗНОВУ стати чинними (F2; §2.5 перемикання includeTestOrders,
 * excluded → recognized). Кожен запис має БАЗОВИЙ ключ (financeKeys без покоління). Для кожного:
 * - діє будь-яке покоління (`<базовий>` або `<базовий>:g<n>`, не сторноване) → пропуск (ідемпотентно, skipped);
 * - інакше — проведення поколінням 1 + найбільше наявне (немає жодного → сам базовий ключ).
 * Викликач тримає блокування факту (FINANCE_ORDER_LOCK замовлення, F10) — інакше одночасне сторно розминулося б із
 * перевіркою. Одночасне повторне проведення того самого покоління безпечне: унікальний ключ → один запис.
 */
export async function repostEntries(
  tx: Tx,
  actor: PostingActor,
  entries: readonly EntryInput[],
  opts: PostEntriesOptions = {},
): Promise<RepostEntriesResult> {
  if (entries.length === 0) return { inserted: 0, skipped: 0, skippedReversed: 0, late: 0, reposted: 0 };
  for (const e of entries) {
    if (typeof e.idempotencyKey !== "string" || !isBaseFactKey(e.idempotencyKey)) invalid("idempotencyKey", String(e.idempotencyKey));
  }
  const byStore = new Map<string, string[]>();
  for (const e of entries) {
    const storeId = e.storeId ?? DEFAULT_STORE_ID;
    byStore.set(storeId, [...(byStore.get(storeId) ?? []), e.idempotencyKey]);
  }
  /** (магазин|базовий) → { active, maxGeneration }. */
  const state = new Map<string, { active: boolean; max: number }>();
  for (const [storeId, bases] of byStore) {
    const unique = [...new Set(bases)].sort();
    for (let i = 0; i < unique.length; i += 100) {
      const chunk = unique.slice(i, i + 100);
      const escaped = (b: string) => `${b.replace(/[\\%_]/g, (c) => `\\${c}`)}:g%`;
      const found = await tx
        .select({
          key: financeEntries.idempotencyKey,
          reversed: sql<boolean>`exists (${tx.select({ one: sql`1` }).from(reversals).where(eq(reversals.reversesEntryId, financeEntries.id))})`,
        })
        .from(financeEntries)
        .where(
          and(
            eq(financeEntries.storeId, storeId),
            isNull(financeEntries.reversesEntryId),
            or(inArray(financeEntries.idempotencyKey, chunk), ...chunk.map((b) => like(financeEntries.idempotencyKey, escaped(b)))),
          ),
        );
      for (const base of chunk) {
        let active = false;
        let max = 0;
        for (const f of found) {
          const g = generationOf(f.key, base);
          if (g === null) continue;
          max = Math.max(max, g);
          if (!f.reversed) active = true;
        }
        state.set(storeKey(storeId, base), { active, max });
      }
    }
  }
  const toPost: EntryInput[] = [];
  let alreadyActive = 0;
  const repostedKeys = new Set<string>();
  for (const e of entries) {
    const storeId = e.storeId ?? DEFAULT_STORE_ID;
    const st = state.get(storeKey(storeId, e.idempotencyKey)) ?? { active: false, max: 0 };
    if (st.active) {
      alreadyActive++;
      continue;
    }
    const generation = st.max + 1;
    const key = withGeneration(e.idempotencyKey, generation);
    if (generation > 1) repostedKeys.add(storeKey(storeId, key));
    toPost.push({ ...e, idempotencyKey: key });
  }
  const r = await insertEntries(tx, actor, toPost, opts);
  const reposted = [...repostedKeys].filter((k) => r.insertedKeys.has(k)).length;
  return {
    inserted: r.inserted,
    skipped: r.skipped + alreadyActive,
    skippedReversed: r.skippedReversed,
    late: r.late,
    reposted,
  };
}

export interface ReverseOptions {
  /** Код причини (не вільний текст): `[a-z0-9_.-]{1,64}` → details.reversalReason. */
  reasonCode?: string;
  now?: Date;
}

/**
 * Сторно одного запису (див. гарантії вгорі файла). Повтор — без нового запису. Сторно сторно — помилка.
 * Повертає лише кількість (0 | 1).
 */
export async function reverseEntry(tx: Tx, actor: PostingActor, entryId: string, opts: ReverseOptions = {}): Promise<{ reversed: number }> {
  if (opts.reasonCode !== undefined && !REASON_CODE_RE.test(opts.reasonCode)) invalid("reasonCode", entryId);
  const [original] = await tx.select().from(financeEntries).where(eq(financeEntries.id, entryId)).for("update");
  if (!original) throw new DomainError("finance.error.entryNotFound", 404);
  if (original.reversesEntryId) throw new DomainError("finance.error.reverseReversal", 409);
  const closed = await lockMonths(tx, original.storeId, [original.recognizedOn]);
  const isClosed = closed.has(monthOf(original.recognizedOn));
  const key = assertFinanceKey(financeKeys.reversal(original.idempotencyKey));
  const details: FinanceDetailsInput = {
    ...(original.details as FinanceDetailsInput),
    reversal: true,
    ...(opts.reasonCode ? { reversalReason: opts.reasonCode } : {}),
  };
  const negate = (v: string | null) => (v === null ? null : v.startsWith("-") ? v.slice(1) : `-${v}`);
  const out = await tx
    .insert(financeEntries)
    .values({
      storeId: original.storeId,
      idempotencyKey: key,
      category: original.category,
      recognizedOn: isClosed ? businessDate(opts.now ?? new Date()) : original.recognizedOn,
      originalOn: original.originalOn,
      fxOn: original.fxOn,
      isLate: isClosed,
      isLateCompletion: false,
      amount: negate(original.amount)!,
      currency: original.currency,
      presentmentAmount: negate(original.presentmentAmount),
      presentmentCurrency: original.presentmentCurrency,
      orderId: original.orderId,
      orderLineItemId: original.orderLineItemId,
      variantId: original.variantId,
      stockItemId: original.stockItemId,
      quantity: original.quantity,
      shipmentId: original.shipmentId,
      partnerId: original.partnerId,
      carrierCode: original.carrierCode,
      countryCode: original.countryCode,
      sourceType: original.sourceType,
      sourceId: original.sourceId,
      reversesEntryId: original.id,
      details: assertFinanceDetails(details),
      postedBy: actor.id,
    })
    .onConflictDoNothing()
    .returning({ id: financeEntries.id });
  return { reversed: out.length };
}

/** Сторно кількох записів (у порядку id — стабільний порядок блокувань). Повертає кількість нових сторно. */
export async function reverseEntries(tx: Tx, actor: PostingActor, entryIds: readonly string[], opts: ReverseOptions = {}): Promise<{ reversed: number }> {
  let reversed = 0;
  for (const id of [...new Set(entryIds)].sort()) reversed += (await reverseEntry(tx, actor, id, opts)).reversed;
  return { reversed };
}

export interface ActiveEntryFilter {
  storeId?: string;
  orderId?: string;
  sourceType?: FinanceSourceType;
  sourceId?: string;
  /** Префікс ключа (напр. `exp:<expenseId>:`). */
  keyPrefix?: string;
  categories?: readonly FinanceCategory[];
}

export interface ActiveEntryRef {
  id: string;
  idempotencyKey: string;
  category: FinanceCategory;
}

/**
 * Діючі записи (не сторно і ще не сторновані) за фільтром — для заміни/сторно у внутрішніх потоках. Лише посилання
 * (id, ключ, категорія), без сум.
 */
export async function activeEntryRefs(db: DbOrTx, filter: ActiveEntryFilter): Promise<ActiveEntryRef[]> {
  const conds: SQL[] = [eq(financeEntries.storeId, filter.storeId ?? DEFAULT_STORE_ID), isNull(financeEntries.reversesEntryId)];
  if (filter.orderId) conds.push(eq(financeEntries.orderId, filter.orderId));
  if (filter.sourceType) conds.push(eq(financeEntries.sourceType, filter.sourceType));
  if (filter.sourceId) conds.push(eq(financeEntries.sourceId, filter.sourceId));
  if (filter.keyPrefix) conds.push(like(financeEntries.idempotencyKey, `${filter.keyPrefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
  if (filter.categories?.length) conds.push(inArray(financeEntries.category, [...filter.categories]));
  const rows = await db
    .select({ id: financeEntries.id, idempotencyKey: financeEntries.idempotencyKey, category: financeEntries.category })
    .from(financeEntries)
    .where(
      and(
        ...conds,
        notExists(db.select({ one: sql`1` }).from(reversals).where(eq(reversals.reversesEntryId, financeEntries.id))),
      ),
    )
    .orderBy(financeEntries.seq);
  return rows.map((r) => ({ ...r, category: r.category as FinanceCategory }));
}

