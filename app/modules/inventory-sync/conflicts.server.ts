/**
 * Розбіжності залишків із Shopify: дії власника (warehouse.adjust) і перелік для сторінки «Склад → Shopify».
 *
 * Обидві дії розв'язують лише НЕПОЯСНЕНУ частину різниці (unexplainedDiff = diff − expectedDiff): одиниці, які Shopify
 * закріпив під неоплачені/ще не синхронізовані замовлення, фізично на складі й зникнуть із різниці самі.
 * - «Прийняти Shopify»: рух shopify_external (on_hand += непояснене) через lockBalances + applyMovements,
 *   ключ shopify_external:<id розбіжності> — повтор/подвійне натискання не створює другого руху. Якщо баланс
 *   змінився після звірки (inventory_balances.version) або змінилася локація складу, спостереження застаріло → нова
 *   звірка позиції.
 *   Перед прийняттям значення Shopify перечитується (InventoryLevel.quantities у локації спостереження): якщо
 *   available/on_hand/committed уже інші (зміну в Shopify скасовано, нове замовлення…), спостереження застаріло → нова
 *   звірка. Поки результат «надіслати склад» для цього спостереження невідомий (тайм-аут, Shopify ще обробляє) —
 *   push_pending: інакше застосувалися б обидві протилежні корекції.
 * - «Надіслати значення складу»: inventoryAdjustQuantities (available, delta = −непояснене, changeFromQuantity =
 *   побачене значення Shopify — CAS; ключ ot-cf-<id>-<observationSeq>). CHANGE_FROM_QUANTITY_STALE → нова звірка.
 *   Явна дія власника: працює за наявності write_inventory незалежно від налаштування автоматичної передачі.
 *   Збільшення available зменшується (pure.ts pushPlan) на одиниці Shopify у станах reserved/damaged/safety_stock/
 *   quality_control (інакше Shopify on_hand зріс би понад фізичний залишок) і на оприбутковані повернення, які Shopify
 *   поповнить сам (returnsAwaiting; includeReturns — власник підтвердив, що Shopify їх не поповнить). Нічого не лишилося —
 *   other_states / awaiting_restock без запиту. Якщо повернення не надіслано, точка узгодження не записується (Shopify і
 *   склад ще різні на ці одиниці).
 *   Спроба (details.pushAttempt) знімається лише за остаточної відповіді (успіх / відмова Shopify), зокрема й після
 *   закриття розбіжності; невідома лишається й переноситься звіркою в нову розбіжність позиції (до 24 год).
 * - «Відхилити» (з приміткою): розбіжність закривається без змін залишку.
 * Демо (без Shopify) — дії відхиляються (inventorySync.demoUnavailable).
 */
import { and, count, desc, eq, ilike, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import type { DbOrTx, Tx } from "~/db/client.server";
import {
  INVENTORY_CONFLICT_STATUSES,
  inventoryConflicts,
  inventoryMovements,
  productVariants,
  products,
  stockItems,
  warehouses,
  type InventoryConflictStatus,
} from "~/db/schema";
import { requirePermission } from "~/domain/permissions";
import { DomainError, NotFoundError } from "~/lib/errors";
import { ShopifyApiError, type AdminGraphql } from "~/integrations/shopify/admin-client.server";
import {
  ADJUST_ERROR,
  INVENTORY_ADJUST_MUTATION,
  buildAdjustInput,
  type GqlInventoryAdjustResult,
  type ShopifyLevelQuantities,
} from "~/integrations/shopify/inventory-graphql";
import { writeAudit } from "~/modules/audit/audit.server";
import { lockBalances } from "~/modules/inventory/ledger.server";
import type { ServiceContext } from "~/server/types";
import { acceptInTx, settleFailedMovements, type ConflictRow } from "./accept.server";
import { loadSyncEnvironment } from "./environment.server";
import { conflictOrigin, parseObservation, parsePushAttempt, type ConflictObservation } from "./observation";
import {
  PUSH_ATTEMPT_TTL_MS,
  PUSH_SETTLE_MS,
  classifyAdjustErrors,
  conflictPushKey,
  conflictReferenceUri,
  pushBlockedByOtherStates,
  pushPlan,
  unexplainedDiff,
} from "./pure";
import { readShopifyLevels, reconcileStockItemNow, type ReconcileOutcome, type ShopifyRead } from "./reconcile.server";
import { recordAgreement } from "./unsent.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_BULK_CONFLICTS = 200;
export const MAX_DISMISS_NOTE = 500;

function assertShopifyMode(ctx: ServiceContext) {
  if (ctx.mode !== "production") throw new DomainError("inventorySync.demoUnavailable", 409);
}

async function conflictHead(db: DbOrTx, conflictId: string) {
  if (!UUID_RE.test(conflictId)) throw new NotFoundError("inventoryConflict");
  const [row] = await db
    .select({ id: inventoryConflicts.id, stockItemId: inventoryConflicts.stockItemId, warehouseId: inventoryConflicts.warehouseId })
    .from(inventoryConflicts)
    .where(eq(inventoryConflicts.id, conflictId));
  if (!row) throw new NotFoundError("inventoryConflict");
  return row;
}

type LockedCheck =
  | { status: "ok"; conflict: ConflictRow; obs: ConflictObservation }
  | { status: "already" | "stale" | "needs_reconcile" | "push_pending" };

/**
 * «Надіслати склад» для розбіжності з невідомим результатом: для того самого спостереження (його ключ) — завжди; після
 * свіжої звірки — ще PUSH_SETTLE_MS (запит міг оброблятися, коли звірка читала Shopify).
 */
function pushPending(conflict: ConflictRow, obs: ConflictObservation, now: Date): boolean {
  const attempt = parsePushAttempt((conflict.details as Record<string, unknown> | null)?.pushAttempt);
  if (!attempt) return false;
  const age = now.getTime() - Date.parse(attempt.at);
  if (age >= PUSH_ATTEMPT_TTL_MS) return false;
  const sameObservation = [conflictPushKey(conflict.id, obs.observationSeq), conflictPushKey(conflict.id, obs.observationSeq, true)];
  return sameObservation.includes(attempt.key) || age < PUSH_SETTLE_MS;
}

/**
 * Блокування (баланс → розбіжність) і перевірки, спільні для «прийняти» й «надіслати»: спостереження актуальне, якщо
 * баланс не змінився, у позиції немає неперенесених рухів і локація складу та сама, де Shopify прочитано.
 * «Прийняти» додатково недоступне, поки результат «надіслати склад» невідомий (push_pending).
 */
async function lockForResolution(
  tx: Tx,
  head: { id: string; stockItemId: string; warehouseId: string },
  doneStatus: InventoryConflictStatus,
  purpose: "accept" | "push",
  now: Date,
): Promise<LockedCheck> {
  const locked = await lockBalances(tx, [{ warehouseId: head.warehouseId, stockItemId: head.stockItemId }]);
  const balance = [...locked.values()][0]!;
  const [conflict] = await tx.select().from(inventoryConflicts).where(eq(inventoryConflicts.id, head.id)).for("update");
  if (!conflict) throw new NotFoundError("inventoryConflict");
  if (conflict.status === doneStatus) return { status: "already" };
  if (conflict.status !== "open") throw new DomainError("inventorySync.conflictResolved", 409);
  const obs = parseObservation(conflict.details);
  if (!obs) return { status: "needs_reconcile" };
  if (purpose === "accept" && pushPending(conflict, obs, now)) return { status: "push_pending" };
  if (balance.version !== obs.appVersion) return { status: "stale" };
  // Локацію складу змінено після звірки: різниця виміряна не там (і «надіслати склад» пішло б у стару локацію).
  const [warehouse] = await tx
    .select({ locationId: warehouses.shopifyLocationId })
    .from(warehouses)
    .where(eq(warehouses.id, head.warehouseId));
  if (!warehouse?.locationId || warehouse.locationId !== obs.locationId) return { status: "needs_reconcile" };
  if (unexplainedDiff(obs) === 0) return { status: "needs_reconcile" };
  const [pending] = await tx
    .select({ c: count() })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.warehouseId, head.warehouseId),
        eq(inventoryMovements.stockItemId, head.stockItemId),
        eq(inventoryMovements.shopifySyncState, "pending"),
      ),
    );
  if (Number(pending?.c ?? 0) > 0) return { status: "stale" };
  return { status: "ok", conflict, obs };
}

// ---------------------------------------------------------------------------
// Прийняти значення Shopify
// ---------------------------------------------------------------------------

export type AcceptResult =
  /** delta — фактична зміна on_hand (непояснена частина різниці). */
  | { status: "accepted"; movementId: string | null; delta: number }
  | { status: "already" }
  /** Результат «надіслати склад» ще невідомий: повторіть «надіслати склад» (той самий ключ) або звірте товар. */
  | { status: "push_pending" }
  | { status: "stale" | "needs_reconcile"; reconciled?: ReconcileOutcome | null };

/** Свіже значення Shopify для спостереження розбіжності (читається ДО транзакції прийняття). */
interface FreshRead {
  inventoryItemId: string;
  locationId: string;
  read: ShopifyRead;
}

const sameQuantities = (q: ShopifyLevelQuantities, obs: ConflictObservation) =>
  q.available === obs.shopifyAvailable && q.onHand === obs.shopifyOnHand && q.committed === obs.shopifyCommitted;

/** Перечитати Shopify для відкритих розбіжностей зі спостереженням (пакетами за локацією). */
async function readFresh(db: DbOrTx, admin: AdminGraphql, conflictIds: readonly string[]): Promise<Map<string, FreshRead>> {
  const out = new Map<string, FreshRead>();
  if (conflictIds.length === 0) return out;
  const rows = await db
    .select({ id: inventoryConflicts.id, details: inventoryConflicts.details, locationId: warehouses.shopifyLocationId })
    .from(inventoryConflicts)
    .innerJoin(warehouses, eq(warehouses.id, inventoryConflicts.warehouseId))
    .where(and(inArray(inventoryConflicts.id, [...conflictIds]), eq(inventoryConflicts.status, "open")));
  const byLocation = new Map<string, Array<{ id: string; inventoryItemId: string }>>();
  for (const r of rows) {
    const obs = parseObservation(r.details);
    // Без спостереження або зі спостереженням іншої (попередньої) локації — не читаємо: дія поверне needs_reconcile.
    if (!obs || obs.locationId !== r.locationId) continue;
    const list = byLocation.get(obs.locationId) ?? [];
    list.push({ id: r.id, inventoryItemId: obs.inventoryItemId });
    byLocation.set(obs.locationId, list);
  }
  for (const [locationId, list] of byLocation) {
    const reads = await readShopifyLevels(admin, list.map((l) => l.inventoryItemId), locationId);
    for (const l of list) {
      out.set(l.id, { inventoryItemId: l.inventoryItemId, locationId, read: reads.get(l.inventoryItemId) ?? { kind: "missing" } });
    }
  }
  return out;
}

async function acceptOne(
  ctx: ServiceContext,
  head: { id: string; stockItemId: string; warehouseId: string },
  fresh: FreshRead | undefined,
  admin: () => Promise<AdminGraphql>,
): Promise<AcceptResult> {
  const result = await ctx.db.transaction(async (tx): Promise<AcceptResult> => {
    const check = await lockForResolution(tx, head, "accepted_shopify", "accept", ctx.now());
    if (check.status !== "ok") return { status: check.status };
    // Спостереження змінилося після читання Shopify (паралельна звірка) або значення Shopify вже інше.
    if (!fresh || fresh.inventoryItemId !== check.obs.inventoryItemId || fresh.locationId !== check.obs.locationId) return { status: "stale" };
    if (fresh.read.kind !== "ok" || !sameQuantities(fresh.read.quantities, check.obs)) return { status: "stale" };
    const { movementId, delta } = await acceptInTx(tx, ctx.actor, check.conflict, check.obs, "manual", ctx.now());
    return { status: "accepted", movementId, delta };
  });
  if (result.status === "stale" || result.status === "needs_reconcile") {
    return { ...result, reconciled: await reconcileStockItemNow(ctx.db, await admin(), head.stockItemId) };
  }
  return result;
}

/**
 * «Прийняти значення Shopify». Значення Shopify перечитується перед прийняттям; застаріле спостереження (склад або
 * Shopify змінилися після звірки) → stale з новою звіркою позиції (результат у reconciled). Кидає
 * DomainError("inventory.insufficient"), якщо on_hand став би від'ємним, а це заборонено. admin обов'язковий: без
 * свіжого читання Shopify значення не приймається.
 */
export async function acceptShopifyValue(
  ctx: ServiceContext,
  conflictId: string,
  opts: { admin: () => Promise<AdminGraphql> },
): Promise<AcceptResult> {
  requirePermission(ctx.actor, "warehouse.adjust");
  assertShopifyMode(ctx);
  const head = await conflictHead(ctx.db, conflictId);
  const fresh = await readFresh(ctx.db, await opts.admin(), [head.id]);
  return acceptOne(ctx, head, fresh.get(head.id), opts.admin);
}

export interface BulkAcceptResult {
  accepted: number;
  already: number;
  stale: number;
  /** Очікують результату «надіслати склад» (не прийнято). */
  pending: number;
  failed: number;
  /** Сумарна зміна on_hand прийнятих. */
  units: number;
}

/**
 * Масове «прийняти Shopify» (кожна розбіжність — окрема транзакція). Значення Shopify перечитуються пакетами ДО
 * прийняття; застарілі пропускаються й одразу звіряються заново, щоб власник побачив свіжі значення.
 */
export async function acceptShopifyValues(
  ctx: ServiceContext,
  conflictIds: readonly string[],
  opts: { admin: () => Promise<AdminGraphql> },
): Promise<BulkAcceptResult> {
  requirePermission(ctx.actor, "warehouse.adjust");
  assertShopifyMode(ctx);
  const ids = [...new Set(conflictIds)].filter((id) => UUID_RE.test(id));
  if (ids.length === 0) throw new DomainError("inventorySync.nothingSelected", 400);
  if (ids.length > MAX_BULK_CONFLICTS) throw new DomainError("inventorySync.tooMany", 400, { max: MAX_BULK_CONFLICTS });
  const out: BulkAcceptResult = { accepted: 0, already: 0, stale: 0, pending: 0, failed: 0, units: 0 };
  const fresh = await readFresh(ctx.db, await opts.admin(), ids);
  for (const id of ids) {
    try {
      const r = await acceptOne(ctx, await conflictHead(ctx.db, id), fresh.get(id), opts.admin);
      if (r.status === "accepted") {
        out.accepted++;
        out.units += r.delta;
      } else if (r.status === "already") out.already++;
      else if (r.status === "push_pending") out.pending++;
      else out.stale++;
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      out.failed++;
    }
  }
  await writeAudit(ctx.db, ctx.actor, "inventory_sync.conflicts_bulk_accepted", { type: "inventory_conflict" }, { ...out });
  return out;
}

// ---------------------------------------------------------------------------
// Надіслати значення складу
// ---------------------------------------------------------------------------

export type PushAppResult =
  /** heldOtherStates / heldAwaiting — не надіслані одиниці збільшення (лише коли > 0), див. pure.ts pushPlan. */
  | { status: "pushed"; delta: number; heldOtherStates?: number; heldAwaiting?: number }
  | { status: "already" }
  | { status: "stale" | "needs_reconcile"; reconciled: ReconcileOutcome | null }
  /** Уся різниця — одиниці Shopify у станах reserved/damaged/safety_stock/quality_control: нічого не надіслано. */
  | { status: "other_states"; count: number }
  /** Решта різниці — повернення, які Shopify поповнить сам: нічого не надіслано (includeReturns — надіслати й їх). */
  | { status: "awaiting_restock"; count: number }
  /** Shopify застосував зміну, але розбіжність тим часом закрито іншою дією (напр. відхилено) — склад і Shopify звірено. */
  | { status: "resolved_concurrently"; delta: number }
  | { status: "in_progress" }
  | { status: "unknown" }
  | { status: "failed"; code: string };

/**
 * Зняти позначку спроби (лише ту саму — CAS за ключем) після остаточної відповіді Shopify — і в уже закритій
 * розбіжності (відхилено під час запиту): інакше звірка перенесла б невідому спробу в нову розбіжність.
 */
async function clearPushAttempt(db: DbOrTx, conflictId: string, key: string) {
  await db
    .update(inventoryConflicts)
    .set({ details: sql`${inventoryConflicts.details} - 'pushAttempt'` })
    .where(and(eq(inventoryConflicts.id, conflictId), sql`${inventoryConflicts.details} -> 'pushAttempt' ->> 'key' = ${key}`));
}

/**
 * «Надіслати значення складу» в Shopify: available −= непояснена різниця (Shopify стане «доступно» складу мінус
 * одиниці, які він закріпив під неоплачені замовлення) з CAS на побачене значення. Повтор із тим самим спостереженням —
 * той самий ключ (Shopify не застосує вдруге). Застаріле → нова звірка. Позначка спроби (pushAttempt) записується ДО
 * запиту в тій самій транзакції, що й перевірки (баланс і розбіжність заблоковано) — паралельне «прийняти» її побачить.
 */
export async function pushAppValue(
  ctx: ServiceContext,
  admin: AdminGraphql,
  conflictId: string,
  opts: { appUrl: string | null; includeReturns?: boolean },
): Promise<PushAppResult> {
  requirePermission(ctx.actor, "warehouse.adjust");
  assertShopifyMode(ctx);
  const env = await loadSyncEnvironment(ctx.db);
  if (!env.shop) throw new DomainError("shopify.notInstalled", 409);
  if (!env.canWrite) throw new DomainError("inventorySync.missingWriteScope", 409);
  const head = await conflictHead(ctx.db, conflictId);
  const now = ctx.now();
  const prepared = await ctx.db.transaction(async (tx) => {
    const check = await lockForResolution(tx, head, "pushed_app", "push", now);
    if (check.status !== "ok") return check;
    const plan = pushPlan(check.obs, { includeReturns: opts.includeReturns === true });
    if (plan.delta === 0) {
      return plan.heldAwaiting > 0
        ? { status: "awaiting_restock" as const, count: plan.heldAwaiting }
        : { status: "other_states" as const, count: check.obs.shopifyOtherStates };
    }
    // Позначка повернень змінює дельту лише тоді, коли без неї частину було б утримано (pushPlan) — тоді інший ключ.
    const withReturns = opts.includeReturns === true && pushPlan(check.obs).heldAwaiting > 0;
    const key = conflictPushKey(check.conflict.id, check.obs.observationSeq, withReturns);
    await tx
      .update(inventoryConflicts)
      .set({ details: { ...check.obs, pushAttempt: { key, seq: check.obs.observationSeq, at: now.toISOString(), by: ctx.actor.id } } })
      .where(eq(inventoryConflicts.id, check.conflict.id));
    return { ...check, key, plan };
  });
  if (prepared.status === "already") return { status: "already" };
  if (prepared.status === "other_states" || prepared.status === "awaiting_restock") return { status: prepared.status, count: prepared.count };
  if (prepared.status !== "ok") {
    return { status: prepared.status === "push_pending" ? "stale" : prepared.status, reconciled: await reconcileStockItemNow(ctx.db, admin, head.stockItemId) };
  }
  const { obs, key, conflict, plan } = prepared;
  const delta = plan.delta;
  const held = {
    ...(plan.heldOtherStates > 0 ? { heldOtherStates: plan.heldOtherStates } : {}),
    ...(plan.heldAwaiting > 0 ? { heldAwaiting: plan.heldAwaiting } : {}),
  };
  const input = buildAdjustInput({
    reason: "correction",
    referenceDocumentUri: conflictReferenceUri(opts.appUrl, conflict.id),
    inventoryItemId: obs.inventoryItemId,
    locationId: obs.locationId,
    delta,
    changeFromQuantity: obs.shopifyAvailable,
  });
  let data: GqlInventoryAdjustResult;
  try {
    data = await admin<GqlInventoryAdjustResult>(INVENTORY_ADJUST_MUTATION, { input, idempotencyKey: key });
  } catch (e) {
    if (!(e instanceof ShopifyApiError)) throw e;
    // Результат невідомий (тайм-аут/обмеження): повтор із тим самим ключем безпечний, позначка спроби лишається.
    if (e.retryable) return { status: "unknown" };
    await clearPushAttempt(ctx.db, conflict.id, key);
    return { status: "failed", code: (e.code ?? "API_ERROR").slice(0, 64) };
  }
  const payload = data.inventoryAdjustQuantities;
  if (!payload) return { status: "unknown" };
  const error = classifyAdjustErrors(payload.userErrors ?? []);
  if (error?.kind === "retry") return error.code === ADJUST_ERROR.concurrent ? { status: "in_progress" } : { status: "unknown" };
  if (error) {
    // Остаточна відмова Shopify: зміну не застосовано — «прийняти Shopify» знову доступне.
    await clearPushAttempt(ctx.db, conflict.id, key);
    if (error.code === ADJUST_ERROR.stale || error.code === ADJUST_ERROR.previousFailed) {
      await writeAudit(ctx.db, ctx.actor, "inventory_sync.conflict_push_stale", { type: "inventory_conflict", id: conflict.id }, { code: error.code });
      return { status: "stale", reconciled: await reconcileStockItemNow(ctx.db, admin, head.stockItemId) };
    }
    await writeAudit(ctx.db, ctx.actor, "inventory_sync.conflict_push_failed", { type: "inventory_conflict", id: conflict.id }, {
      code: error.code,
      field: error.field,
    });
    return { status: "failed", code: error.code.slice(0, 64) };
  }
  if (!payload.inventoryAdjustmentGroup) return { status: "unknown" };
  const closed = await ctx.db.transaction(async (tx) => {
    const locked = await lockBalances(tx, [{ warehouseId: conflict.warehouseId, stockItemId: conflict.stockItemId }]);
    const balance = [...locked.values()][0]!;
    const rows = await tx
      .update(inventoryConflicts)
      .set({
        status: "pushed_app",
        resolvedAt: now,
        resolvedBy: ctx.actor.id,
        details: { ...obs, pushAttempt: undefined, resolution: "pushed_app", pushKey: key },
      })
      .where(and(eq(inventoryConflicts.id, conflict.id), eq(inventoryConflicts.status, "open")))
      .returning({ id: inventoryConflicts.id });
    const settled = await settleFailedMovements(tx, obs.failedMovementIds, "pushed");
    // Shopify тепер має фактичний залишок складу на момент спостереження (одиниці в інших станах Shopify уже в його
    // on_hand); склад відтоді не змінився — точка узгодження. Крім випадку, коли повернення, які Shopify поповнить сам,
    // не надіслано: на них Shopify і склад ще різні (неотримані рухи лишаються, автоприйняття блокується).
    if (balance.version === obs.appVersion && plan.heldAwaiting === 0) {
      await recordAgreement(tx, ctx.actor, conflict.warehouseId, conflict.stockItemId, "pushed", now);
    }
    // Зміну в Shopify застосовано в будь-якому разі — вона має бути в журналі.
    await writeAudit(
      tx,
      ctx.actor,
      rows.length > 0 ? "inventory_sync.conflict_pushed" : "inventory_sync.conflict_pushed_after_resolution",
      { type: "inventory_conflict", id: conflict.id },
      { delta, settledFailed: settled, ...held, includeReturns: opts.includeReturns === true },
    );
    return rows.length > 0;
  });
  return closed ? { status: "pushed", delta, ...held } : { status: "resolved_concurrently", delta };
}

// ---------------------------------------------------------------------------
// Відхилити
// ---------------------------------------------------------------------------

export async function dismissConflict(ctx: ServiceContext, conflictId: string, note: string): Promise<{ status: "dismissed" | "already" }> {
  requirePermission(ctx.actor, "warehouse.adjust");
  assertShopifyMode(ctx);
  const text = note.trim();
  if (text.length === 0) throw new DomainError("inventorySync.noteRequired", 400);
  if (text.length > MAX_DISMISS_NOTE) throw new DomainError("inventorySync.noteTooLong", 400, { max: MAX_DISMISS_NOTE });
  const head = await conflictHead(ctx.db, conflictId);
  return ctx.db.transaction(async (tx) => {
    const [conflict] = await tx.select().from(inventoryConflicts).where(eq(inventoryConflicts.id, head.id)).for("update");
    if (!conflict) throw new NotFoundError("inventoryConflict");
    if (conflict.status === "dismissed") return { status: "already" as const };
    if (conflict.status !== "open") throw new DomainError("inventorySync.conflictResolved", 409);
    const obs = parseObservation(conflict.details);
    await tx
      .update(inventoryConflicts)
      .set({
        status: "dismissed",
        resolvedAt: ctx.now(),
        resolvedBy: ctx.actor.id,
        details: { ...(conflict.details ?? {}), resolution: "dismissed", dismissNote: text },
      })
      .where(eq(inventoryConflicts.id, conflict.id));
    const settled = obs ? await settleFailedMovements(tx, obs.failedMovementIds, "skipped") : 0;
    // Невідома спроба «надіслати склад» лишається в details: звірка перенесе її в нову розбіжність (push_pending).
    const pushAttemptKept = obs?.pushAttempt !== undefined;
    // Примітку власника в журнал не пишемо (вільний текст) — вона в самій розбіжності.
    await writeAudit(tx, ctx.actor, "inventory_sync.conflict_dismissed", { type: "inventory_conflict", id: conflict.id }, {
      settledFailed: settled,
      pushAttemptKept,
    });
    return { status: "dismissed" as const };
  });
}

// ---------------------------------------------------------------------------
// Перелік
// ---------------------------------------------------------------------------

export const CONFLICT_STATUS_FILTERS = ["open", "resolved", "all", ...INVENTORY_CONFLICT_STATUSES.filter((s) => s !== "open")] as const;
export type ConflictStatusFilter = (typeof CONFLICT_STATUS_FILTERS)[number];

export function isConflictStatusFilter(v: unknown): v is ConflictStatusFilter {
  return typeof v === "string" && (CONFLICT_STATUS_FILTERS as readonly string[]).includes(v);
}

export interface ConflictFilters {
  status?: ConflictStatusFilter;
  /** Одна розбіжність за id (посилання з історії залишків Shopify); статус тоді не фільтрується. */
  conflictId?: string;
  models?: string[];
  colors?: string[];
  search?: string;
}

export interface ConflictView {
  id: string;
  status: InventoryConflictStatus;
  createdAt: Date;
  resolvedAt: Date | null;
  stockItemId: string;
  variantId: string | null;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  model: string | null;
  color: string | null;
  imageUrl: string | null;
  /** null — розбіжність без спостереження звірки (спершу «Звірити»). */
  appAvailable: number | null;
  shopifyAvailable: number | null;
  appOnHand: number;
  shopifyOnHand: number;
  diff: number | null;
  /** Непояснена частина різниці (diff − expectedDiff) — її змінюють «прийняти Shopify» / «надіслати склад». */
  unexplained: number | null;
  expectedDiff: number;
  committedNotReserved: number;
  inFlight: number;
  shopifyOtherStates: number;
  failedPushes: number;
  failedDelta: number;
  /** Застосунок резервує більше, ніж закріпив Shopify (зміну/скасування/виконання замовлення ще не застосовано). */
  reservationExcess: number;
  /** Внутрішні зміни on_hand, яких Shopify не отримав від останнього узгодження («прийняти Shopify» їх скасує). */
  unsentCount: number;
  unsentDelta: number;
  /** Повернені після відправлення одиниці, яких склад ще не оприбуткував. */
  returnsPending: number;
  /** Оприбутковані складом повернення, які Shopify ще має поповнити сам. */
  returnsAwaiting: number;
  uncertain: boolean;
  /** Час спроби «надіслати склад» із невідомим результатом (null — немає). */
  pushAttemptAt: string | null;
  /** Причини, з яких автоприйняття не виконано (режим apply). */
  autoApplyBlockers: string[];
  /** «Надіслати склад» недоступне: уся різниця — одиниці Shopify в інших станах (pure.ts pushPlan). */
  pushBlockedOtherStates: boolean;
  /** Що надішле «Надіслати склад» без позначки повернень (null — без спостереження). */
  pushDelta: number | null;
  /** Не надсилається: одиниці в інших станах Shopify / повернення, які Shopify поповнить сам. */
  pushHeldOtherStates: number;
  pushHeldAwaiting: number;
  observedAt: string | null;
  origin: string | null;
  resolution: string | null;
  autoApplyBlocked: string | null;
  /** Можна прийняти/надіслати (є спостереження звірки). */
  resolvable: boolean;
}

function statusCondition(status: ConflictStatusFilter): SQL | undefined {
  if (status === "all") return undefined;
  if (status === "resolved") return sql`${inventoryConflicts.status} <> 'open'`;
  return eq(inventoryConflicts.status, status);
}

const likePattern = (search: string) => `%${search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function filterConditions(filters: ConflictFilters): SQL | undefined {
  const search = filters.search?.trim() ? likePattern(filters.search) : null;
  if (filters.conflictId !== undefined) {
    return UUID_RE.test(filters.conflictId) ? eq(inventoryConflicts.id, filters.conflictId) : sql`false`;
  }
  return and(
    statusCondition(filters.status ?? "open"),
    filters.models?.length ? inArray(productVariants.model, filters.models) : undefined,
    filters.colors?.length ? inArray(productVariants.color, filters.colors) : undefined,
    search
      ? or(ilike(products.title, search), ilike(productVariants.title, search), ilike(productVariants.sku, search), ilike(productVariants.barcode, search))
      : undefined,
  );
}

type ListRow = {
  c: ConflictRow;
  variantId: string | null;
  title: string | null;
  variantTitle: string | null;
  sku: string | null;
  model: string | null;
  color: string | null;
  variantImage: string | null;
  productImage: string | null;
};

export async function listConflicts(
  db: DbOrTx,
  filters: ConflictFilters = {},
  page: { limit?: number; offset?: number } = {},
): Promise<{ rows: ConflictView[]; total: number }> {
  const limit = Math.min(Math.max(Math.trunc(page.limit ?? 50), 1), 200);
  const offset = Math.max(Math.trunc(page.offset ?? 0), 0);
  const where = filterConditions(filters);
  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        c: inventoryConflicts,
        variantId: productVariants.id,
        title: products.title,
        variantTitle: productVariants.title,
        sku: productVariants.sku,
        model: productVariants.model,
        color: productVariants.color,
        variantImage: productVariants.imageUrl,
        productImage: products.imageUrl,
      })
      .from(inventoryConflicts)
      .innerJoin(stockItems, eq(stockItems.id, inventoryConflicts.stockItemId))
      .leftJoin(productVariants, eq(productVariants.id, stockItems.variantId))
      .leftJoin(products, eq(products.id, productVariants.productId))
      .where(where)
      .orderBy(desc(inventoryConflicts.createdAt), desc(inventoryConflicts.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ c: count() })
      .from(inventoryConflicts)
      .innerJoin(stockItems, eq(stockItems.id, inventoryConflicts.stockItemId))
      .leftJoin(productVariants, eq(productVariants.id, stockItems.variantId))
      .leftJoin(products, eq(products.id, productVariants.productId))
      .where(where),
  ]);
  return { total: Number(totalRow?.c ?? 0), rows: rows.map(toView) };
}

function toView(r: ListRow): ConflictView {
  const obs = parseObservation(r.c.details);
  const plan = obs ? pushPlan(obs) : null;
  const d = (r.c.details ?? {}) as Record<string, unknown>;
  return {
    id: r.c.id,
    status: r.c.status,
    createdAt: r.c.createdAt,
    resolvedAt: r.c.resolvedAt,
    stockItemId: r.c.stockItemId,
    variantId: r.variantId,
    title: r.title ?? "—",
    variantTitle: r.variantTitle,
    sku: r.sku,
    model: r.model,
    color: r.color,
    imageUrl: r.variantImage ?? r.productImage,
    appAvailable: obs?.appAvailable ?? null,
    shopifyAvailable: obs?.shopifyAvailable ?? r.c.shopifyAvailable,
    appOnHand: r.c.appOnHand,
    shopifyOnHand: r.c.shopifyOnHand,
    diff: obs ? obs.diff : null,
    unexplained: obs ? unexplainedDiff(obs) : null,
    expectedDiff: obs?.expectedDiff ?? r.c.expectedDiff,
    committedNotReserved: obs?.committedNotReserved ?? 0,
    inFlight: obs?.inFlight ?? 0,
    shopifyOtherStates: obs?.shopifyOtherStates ?? 0,
    failedPushes: obs?.failedMovementIds.length ?? 0,
    failedDelta: obs?.failedDelta ?? 0,
    reservationExcess: obs?.reservationExcess ?? 0,
    unsentCount: obs?.unsentCount ?? 0,
    unsentDelta: obs?.unsentDelta ?? 0,
    returnsPending: obs?.returnsPending ?? 0,
    returnsAwaiting: obs?.returnsAwaiting ?? 0,
    uncertain: obs?.uncertain ?? false,
    pushAttemptAt: r.c.status === "open" ? (obs?.pushAttempt?.at ?? null) : null,
    autoApplyBlockers: r.c.status === "open" && Array.isArray(d.autoApplyBlockers) ? d.autoApplyBlockers.filter((x): x is string => typeof x === "string") : [],
    pushBlockedOtherStates: obs ? pushBlockedByOtherStates(obs) : false,
    pushDelta: plan ? plan.delta : null,
    pushHeldOtherStates: plan?.heldOtherStates ?? 0,
    pushHeldAwaiting: plan?.heldAwaiting ?? 0,
    observedAt: obs?.observedAt ?? null,
    origin: obs?.origin ?? conflictOrigin(r.c.details),
    resolution: typeof d.resolution === "string" ? d.resolution : null,
    autoApplyBlocked: typeof d.autoApplyBlocked === "string" ? d.autoApplyBlocked : null,
    resolvable: r.c.status === "open" && obs !== null,
  };
}

/** Значення фільтрів (моделі/кольори товарів, що мають розбіжності) і лічильники за станом. */
export async function conflictFacets(db: DbOrTx): Promise<{ models: string[]; colors: string[]; counts: Record<InventoryConflictStatus, number> }> {
  const facet = (column: typeof productVariants.model | typeof productVariants.color) =>
    db
      .selectDistinct({ v: column })
      .from(inventoryConflicts)
      .innerJoin(stockItems, eq(stockItems.id, inventoryConflicts.stockItemId))
      .innerJoin(productVariants, eq(productVariants.id, stockItems.variantId))
      .where(isNotNull(column))
      .orderBy(column);
  const [models, colors, counts] = await Promise.all([
    facet(productVariants.model),
    facet(productVariants.color),
    db.select({ status: inventoryConflicts.status, c: count() }).from(inventoryConflicts).groupBy(inventoryConflicts.status),
  ]);
  const byStatus = Object.fromEntries(INVENTORY_CONFLICT_STATUSES.map((s) => [s, 0])) as Record<InventoryConflictStatus, number>;
  for (const r of counts) byStatus[r.status] = Number(r.c);
  return {
    models: models.map((m) => m.v).filter((v): v is string => Boolean(v)),
    colors: colors.map((c) => c.v).filter((v): v is string => Boolean(v)),
    counts: byStatus,
  };
}
