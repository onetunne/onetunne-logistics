/**
 * ВИГАДАНА історія складу для демо (етап 5): завершені виробничі партії з надходженнями за останні 90 днів і витрата
 * пакувальних матеріалів за останні 30 днів — щоб статистика виробництва («Виробництво», період 90 днів) і «Витрачено
 * за 30 днів» / «Вистачить на» матеріалів у новому демо не були порожніми.
 *
 * Виробництво — справжніми сервісами (createBatch → startProduction → receiveProduction → closeBatch, брак — списання
 * writeOffDefective «повернуто виробнику»): позиції, надходження, рядки надходжень, рухи журналу, собівартість і версії
 * узгоджені так само, як після дій власника. Сервіси працюють у ТІЙ САМІЙ транзакції (ctx.db = tx, власні транзакції
 * сервісів — точки збереження) з ctx.now() = момент події в минулому: дати створення/оновлення партій і
 * production_receipts.received_at — історичні. Рухи журналу отримують created_at від бази (початок транзакції), тож
 * у цій самій транзакції їм ставиться момент події (запуск, надходження, списання браку). Так само — записам журналу
 * дій (audit_log), які сервіс додав (production.batch_created/_started/_closed, production.received,
 * inventory.defect_written_off): з них, зокрема, береться дата закриття партії в CSV «Партії виробництва». Запис
 * demo.production_history_seeded лишається з реальним часом заповнення.
 *
 * Чому кінцеві залишки не змінюються (і чому так — коректно):
 * - Історія сталася ДО знімка «Shopify», з якого відкрито облік товарів: знімок уже містить отримані тоді якісні
 *   одиниці. Тому рух opening кожного товару з історією зменшується на отримане історією (opening = знімок + відкриті
 *   замовлення − надходження історії), а баланс — на ту саму величину: on_hand/reserved/available дорівнюють демо-знімку,
 *   як і без історії, а сума рухів дорівнює балансу. Розбіжність opened_with_internal_history не створюється (на
 *   відміну від справжніх рухів до відкриття, initializeInventory): ці одиниці вже є в знімку. Тому й стан передачі
 *   надходжень історії — "none" (Shopify їх уже має; не «Не надсилалося» і не пояснення різниці у звірці).
 *   initializeInventory не змінюється: для робочого режиму формула знімка лишається тією самою.
 * - Брак історії списано (повернуто виробнику) — defective як без історії; «У виробництві» — 0 (партії завершені).
 * - Попередження товарів: надходження історії тимчасово (до поглинання opening) піднімають залишок і можуть закрити
 *   відкрите попередження («мало»/«немає»), а кінцева оцінка відкриває таке саме знову. Тому попередження, відкриті до
 *   історії, лишаються ТИМИ САМИМИ рядками (id і «з якого часу»), а рядки, відкриті й закриті лише в межах заповнення,
 *   видаляються (keepAlertsAsBefore): для власника попередження ті самі, що й без історії.
 * - Собівартість: надходження історії мають ціну одиниці (з часткою додаткових витрат партії), тож у власника в
 *   аналітиці «Вартість запасу» й собівартість одиниці з'являються для товарів історії (решта — «без собівартості»);
 *   працівник собівартості не бачить (finance.view).
 * - Матеріали: рух opening (demo_seed) переноситься на день до першої витрати й збільшується на витрачене історією;
 *   витрата (material_consume) повертає залишок до DEMO_MATERIALS.stock. Попередження «мало» (коробки L, болти M5)
 *   лишаються як були: кінцевий баланс той самий, а оцінка попереджень бачить лише його.
 * Історія не потрапляє в чергу пакування (немає пакувань і замовлень), не створює резервів і завдань передачі в Shopify
 * (демо: передачу вимкнено; ніяких рухів зі станом pending).
 *
 * Номери партій видає createBatch (PB-<рік за Києвом дати створення>-NNNN, max + 1 під блокуванням номерів року): у
 * новому демо — після PB-<рік>-0001 (демо-партія «у виробництві»), тож номери не збігаються з хронологією створення;
 * партії, які власник створить пізніше, отримують наступні номери.
 *
 * Ідемпотентно й «один раз» для старих демо-баз: виробництво — якщо партій історії (примітка DEMO_HISTORY_NOTE) ще
 * немає; матеріали — якщо немає жодного руху з ключем demo_history:. Стара демо-база (склад заповнено до появи історії)
 * отримує історію один раз під час запуску (дати — від цього моменту); повторний запуск і скидання демо — без дублів.
 * Позиції, яких немає в каталозі, або товари, рух opening яких менший за отримане історією, пропускаються.
 */
import { createHash } from "node:crypto";
import { and, asc, count, eq, gt, inArray, like, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "~/db/client.server";
import {
  auditLog,
  inventoryBalances,
  inventoryMovements,
  packagingMaterials,
  productionBatchLines,
  productionBatches,
  productionReceiptLines,
  productVariants,
  stockAlerts,
} from "~/db/schema";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { writeAudit } from "~/modules/audit/audit.server";
import { DEMO_HISTORY_KEY_PREFIX, inventoryKeys } from "~/modules/inventory/keys";
import {
  applyMovements,
  ensureStockItemForMaterial,
  ensureStockItemsForVariants,
  evaluateStockAlerts,
  lockBalances,
  type MovementInput,
} from "~/modules/inventory/ledger.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { closeBatch, createBatch, receiveProduction, startProduction } from "~/modules/production/batches.server";
import { getSetting } from "~/modules/settings/settings.server";
import { writeOffDefective } from "~/modules/warehouse/operations.server";
import { businessDate } from "~/modules/warehouse/dates";
import type { ServiceContext } from "~/server/types";

const DAY_MS = 86_400_000;
const COST_CURRENCY = "UAH";
/** Примітка партій історії — і ознака «історію виробництва вже створено». */
export const DEMO_HISTORY_NOTE = "DEMO · історія виробництва";
export const DEMO_HISTORY_MANUFACTURER = "Демо-виробник";
const DEMO_NOTE = "DEMO";

export interface DemoReceiptLineSeed {
  sku: string;
  good: number;
  defective?: number;
  /** Причина браку (без персональних даних). */
  reason?: string;
}

export interface DemoBatchHistorySeed {
  key: string;
  title: string;
  createdDaysAgo: number;
  startedDaysAgo: number;
  /** Планова дата готовності: дата (за Києвом) цього дня в минулому. */
  readyDaysAgo: number;
  extraCost: string;
  lines: Array<{ sku: string; quantity: number; unitCost: string }>;
  receipts: Array<{ daysAgo: number; lines: DemoReceiptLineSeed[] }>;
  /** Через скільки днів після надходження брак повернуто виробнику (списання браку). */
  writeOffAfterDays: number;
  /** null — партія лишається «Отримано» (не закрита). */
  closeDaysAgo: number | null;
}

/**
 * Дві завершені партії: «Грипси й тримачі» — отримано ВЧАСНО (останнє надходження за 2 дні до планової дати) і
 * закрито; «Крила Model X і покришки» — отримано ІЗ ЗАПІЗНЕННЯМ (через 5 днів після планової дати), стан «Отримано».
 * Брак — на різних позиціях (сірі грипси, чорний тримач, крило Model X). Моделі: Model X, 10x2.5, без моделі;
 * кольори: Чорний, Сірий, без кольору. Кількості менші за початкові залишки цих товарів (див. «Чому кінцеві залишки не
 * змінюються»), товари не пов'язані з аналітикою ризику (OT-BG-BLK, OT-PH-WHT не беруть участі).
 */
export const DEMO_PRODUCTION_HISTORY: readonly DemoBatchHistorySeed[] = [
  {
    key: "grips-holders",
    title: "Грипси й тримачі чорні",
    createdDaysAgo: 84,
    startedDaysAgo: 82,
    readyDaysAgo: 55,
    extraCost: "1200.00",
    lines: [
      { sku: "OT-GR-BLK", quantity: 40, unitCost: "95.00" },
      { sku: "OT-GR-GRY", quantity: 25, unitCost: "95.00" },
      { sku: "OT-PH-BLK", quantity: 30, unitCost: "210.00" },
    ],
    receipts: [
      {
        daysAgo: 62,
        lines: [
          { sku: "OT-GR-BLK", good: 40 },
          { sku: "OT-GR-GRY", good: 23, defective: 2, reason: "Потертості на поверхні" },
          { sku: "OT-PH-BLK", good: 20 },
        ],
      },
      { daysAgo: 57, lines: [{ sku: "OT-PH-BLK", good: 9, defective: 1, reason: "Тріщина кріплення" }] },
    ],
    writeOffAfterDays: 2,
    closeDaysAgo: 56,
  },
  {
    key: "fenders-tires",
    title: "Крила Model X і покришки",
    createdDaysAgo: 50,
    startedDaysAgo: 48,
    readyDaysAgo: 24,
    extraCost: "600.00",
    lines: [
      { sku: "OT-FK-X", quantity: 15, unitCost: "300.00" },
      { sku: "OT-TR-1025", quantity: 8, unitCost: "240.00" },
    ],
    receipts: [
      {
        daysAgo: 19,
        lines: [
          { sku: "OT-FK-X", good: 14, defective: 1, reason: "Деформація кронштейна" },
          { sku: "OT-TR-1025", good: 8 },
        ],
      },
    ],
    writeOffAfterDays: 2,
    closeDaysAgo: null,
  },
];

/**
 * Вигадані дні пакування за останні 30 днів (витрата матеріалів DEMO_MATERIALS, за кодом): коробки/пакети, наклейка й
 * візитка на кожне відправлення, болти й інструкція — на кожне крило, скотч — для покришок і кронштейнів.
 */
export const DEMO_MATERIAL_HISTORY: ReadonlyArray<{ daysAgo: number; use: Readonly<Record<string, number>> }> = [
  { daysAgo: 2, use: { mailer_m: 1, sticker_logo: 1, card_thanks: 1 } },
  { daysAgo: 6, use: { box_m: 1, sticker_logo: 1, card_thanks: 1, tape: 1 } },
  { daysAgo: 9, use: { box_m: 1, sticker_logo: 1, card_thanks: 1, tape: 1 } },
  { daysAgo: 11, use: { box_l: 1, sticker_logo: 1, card_thanks: 1, bolts_m5: 2, instruction_fender: 2, tape: 1 } },
  { daysAgo: 13, use: { box_m: 1, sticker_logo: 1, card_thanks: 1, tape: 1 } },
  { daysAgo: 16, use: { box_s: 1, sticker_logo: 1, card_thanks: 1, tape: 1 } },
  { daysAgo: 19, use: { box_l: 1, sticker_logo: 1, card_thanks: 1, bolts_m5: 2, instruction_fender: 2, tape: 3 } },
  { daysAgo: 22, use: { box_m: 1, sticker_logo: 1, card_thanks: 1, tape: 1 } },
  { daysAgo: 25, use: { box_l: 1, sticker_logo: 1, card_thanks: 1, bolts_m5: 2, instruction_fender: 2, tape: 2 } },
  { daysAgo: 27, use: { mailer_m: 1, sticker_logo: 1, card_thanks: 1 } },
];

/** Рух opening матеріалу переноситься на стільки днів назад (до першої витрати історії). */
const MATERIAL_OPENING_DAYS_AGO = Math.max(...DEMO_MATERIAL_HISTORY.map((d) => d.daysAgo)) + 3;

/** Детермінований uuid (для ключів форм надходження/списання): той самий запис плану → той самий ключ. */
export function demoUuid(name: string): string {
  const h = createHash("sha256").update(`onetunne-demo-history:${name}`).digest("hex");
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface DemoHistoryResult {
  batches: number;
  receipts: number;
  materialMovements: number;
}

/** Партії історії виробництва вже є (за приміткою). */
export async function isDemoProductionHistorySeeded(db: DbOrTx): Promise<boolean> {
  const [row] = await db.select({ c: count() }).from(productionBatches).where(eq(productionBatches.notes, DEMO_HISTORY_NOTE));
  return Number(row?.c ?? 0) > 0;
}

/** Вигадана витрата матеріалів уже є (за префіксом ключа). */
export async function isDemoMaterialHistorySeeded(db: DbOrTx): Promise<boolean> {
  const [row] = await db
    .select({ c: count() })
    .from(inventoryMovements)
    .where(like(inventoryMovements.idempotencyKey, `${DEMO_HISTORY_KEY_PREFIX}%`));
  return Number(row?.c ?? 0) > 0;
}

/**
 * Створює історію виробництва й витрати матеріалів (див. заголовок файлу). Потребує заповненого демо-складу
 * (seedDemoWarehouse: відкритий облік товарів і матеріали з рухом opening). Повертає, що створено.
 */
export async function seedDemoWarehouseHistory(ctx: ServiceContext): Promise<DemoHistoryResult> {
  const [productionDone, materialsDone] = await Promise.all([isDemoProductionHistorySeeded(ctx.db), isDemoMaterialHistorySeeded(ctx.db)]);
  if (productionDone && materialsDone) return { batches: 0, receipts: 0, materialMovements: 0 };
  const now = ctx.now();
  const result = await ctx.db.transaction(async (tx) => {
    const warehouse = await getDefaultWarehouse(tx);
    const production = productionDone ? { batches: 0, receipts: 0, good: 0, defective: 0 } : await seedProductionHistory(tx, ctx, warehouse.id, now);
    const materialMovements = materialsDone ? 0 : await seedMaterialHistory(tx, warehouse.id, now);
    const out = { batches: production.batches, receipts: production.receipts, materialMovements };
    if (out.batches > 0 || out.materialMovements > 0) {
      await writeAudit(tx, SYSTEM_ACTOR, "demo.production_history_seeded", { type: "system" }, {
        ...out,
        goodUnits: production.good,
        defectiveUnits: production.defective,
      });
    }
    return out;
  });
  return result;
}

const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS);

/** Рух opening позиції на складі (рядок і поточна дельта) або null. */
async function openingMovement(tx: Tx, warehouseId: string, stockItemId: string): Promise<{ id: string; onHandDelta: number } | null> {
  const [row] = await tx
    .select({ id: inventoryMovements.id, onHandDelta: inventoryMovements.onHandDelta })
    .from(inventoryMovements)
    .where(and(eq(inventoryMovements.idempotencyKey, inventoryKeys.opening(warehouseId, stockItemId)), eq(inventoryMovements.type, "opening")));
  return row ?? null;
}

/**
 * Рух opening поглинає історію: дельта opening і баланс on_hand змінюються на `delta` разом (сума рухів = баланс).
 * Викликати під lockBalances позиції. createdBefore — перенести opening не пізніше цього моменту.
 */
async function absorbIntoOpening(tx: Tx, warehouseId: string, stockItemId: string, delta: number, createdBefore?: Date): Promise<void> {
  if (delta === 0 && !createdBefore) return;
  await tx
    .update(inventoryMovements)
    .set({
      onHandDelta: sql`${inventoryMovements.onHandDelta} + ${delta}`,
      ...(createdBefore ? { createdAt: sql`least(${inventoryMovements.createdAt}, ${createdBefore.toISOString()}::timestamptz)` } : {}),
    })
    .where(and(eq(inventoryMovements.idempotencyKey, inventoryKeys.opening(warehouseId, stockItemId)), eq(inventoryMovements.type, "opening")));
  if (delta === 0) return;
  await tx
    .update(inventoryBalances)
    .set({ onHand: sql`${inventoryBalances.onHand} + ${delta}`, version: sql`${inventoryBalances.version} + 1`, updatedAt: new Date() })
    .where(and(eq(inventoryBalances.warehouseId, warehouseId), eq(inventoryBalances.stockItemId, stockItemId)));
}

async function setMovementTime(tx: Tx, keys: readonly string[], at: Date, extra: { shopifySyncState?: "none" } = {}): Promise<void> {
  if (keys.length === 0) return;
  await tx
    .update(inventoryMovements)
    .set({ createdAt: at, ...extra })
    .where(inArray(inventoryMovements.idempotencyKey, [...keys]));
}

/** Останній id журналу дій (межа «що додав наступний виклик сервісу»). */
async function lastAuditId(tx: Tx): Promise<number> {
  const [row] = await tx.select({ id: sql<number>`coalesce(max(${auditLog.id}), 0)`.mapWith(Number) }).from(auditLog);
  return row?.id ?? 0;
}

/**
 * Записи журналу дій, які ЦЯ транзакція додала від імені системи після межі `sinceId` (created_at = now() — початок
 * транзакції; чужі транзакції мають інший час і невидимі до фіксації), отримують момент події.
 */
async function setAuditTime(tx: Tx, sinceId: number, at: Date): Promise<void> {
  await tx
    .update(auditLog)
    .set({ createdAt: at })
    .where(
      and(
        gt(auditLog.id, sinceId),
        eq(auditLog.actorType, SYSTEM_ACTOR.kind),
        eq(auditLog.actorId, SYSTEM_ACTOR.id),
        sql`${auditLog.createdAt} = now()`,
      ),
    );
}

type AlertRow = { id: string; stockItemId: string; warehouseId: string; kind: string; status: string; details: Record<string, number | string | null> };

async function alertRowsOf(tx: Tx, stockItemIds: readonly string[]): Promise<AlertRow[]> {
  if (stockItemIds.length === 0) return [];
  return tx
    .select({
      id: stockAlerts.id,
      stockItemId: stockAlerts.stockItemId,
      warehouseId: stockAlerts.warehouseId,
      kind: stockAlerts.kind,
      status: stockAlerts.status,
      details: stockAlerts.details,
    })
    .from(stockAlerts)
    .where(inArray(stockAlerts.stockItemId, [...stockItemIds]))
    .orderBy(asc(stockAlerts.id));
}

/**
 * Після кінцевої оцінки попереджень: попередження, відкрите ДО історії й закрите проміжним станом (надходження до
 * поглинання opening), знову відкрите тим самим рядком (id, «з якого часу») замість щойно відкритого дубля; рядки,
 * які з'явилися й закрилися в межах заповнення (проміжний вид, напр. «мало» між «немає» і «немає»), видаляються.
 * Викликати під lockBalances цих позицій (паралельна оцінка тих самих позицій неможлива).
 */
async function keepAlertsAsBefore(tx: Tx, before: readonly AlertRow[], stockItemIds: readonly string[]): Promise<void> {
  const known = new Set(before.map((a) => a.id));
  const after = await alertRowsOf(tx, stockItemIds);
  const added = after.filter((a) => !known.has(a.id));
  const key = (a: AlertRow) => `${a.warehouseId}|${a.stockItemId}|${a.kind}`;
  const addedOpen = new Map(added.filter((a) => a.status === "open").map((a) => [key(a), a]));
  const current = new Map(after.map((a) => [a.id, a]));
  for (const a of before) {
    if (a.status !== "open" || current.get(a.id)?.status !== "resolved") continue;
    const dup = addedOpen.get(key(a));
    // Кінцевий стан попередження не потребує — закриття справедливе (на практиці не буває: кінцевий баланс той самий).
    if (!dup) continue;
    await tx.delete(stockAlerts).where(eq(stockAlerts.id, dup.id));
    await tx.update(stockAlerts).set({ status: "open", resolvedAt: null, details: dup.details }).where(eq(stockAlerts.id, a.id));
  }
  const transient = added.filter((a) => a.status === "resolved").map((a) => a.id);
  if (transient.length > 0) await tx.delete(stockAlerts).where(inArray(stockAlerts.id, transient));
}

async function seedProductionHistory(
  tx: Tx,
  ctx: ServiceContext,
  warehouseId: string,
  now: Date,
): Promise<{ batches: number; receipts: number; good: number; defective: number }> {
  // Сервіси — у цій транзакції, від імені системи, у демо-режимі (передачу в Shopify вимкнено), «зараз» = момент події;
  // записи журналу дій, які додав сервіс, теж отримують момент події.
  const at = (moment: Date): ServiceContext => ({ ...ctx, mode: "demo", db: tx, actor: SYSTEM_ACTOR, now: () => moment });
  const run = async <T>(moment: Date, service: (c: ServiceContext) => Promise<T>): Promise<T> => {
    const mark = await lastAuditId(tx);
    const out = await service(at(moment));
    await setAuditTime(tx, mark, moment);
    return out;
  };
  const skus = [...new Set(DEMO_PRODUCTION_HISTORY.flatMap((b) => b.lines.map((l) => l.sku)))];
  const variants = await tx.select({ id: productVariants.id, sku: productVariants.sku }).from(productVariants).where(inArray(productVariants.sku, skus));
  const variantBySku = new Map(variants.map((v) => [v.sku!, v.id]));
  const stockByVariant = await ensureStockItemsForVariants(tx, variants.map((v) => v.id));

  // Отримані історією якісні одиниці за SKU: opening товару має їх містити (знімок уже включає надходження історії).
  const goodBySku = new Map<string, number>();
  for (const b of DEMO_PRODUCTION_HISTORY) {
    for (const r of b.receipts) for (const l of r.lines) goodBySku.set(l.sku, (goodBySku.get(l.sku) ?? 0) + l.good);
  }
  const viable = new Set<string>();
  for (const sku of skus) {
    const variantId = variantBySku.get(sku);
    const stockItemId = variantId ? stockByVariant.get(variantId) : undefined;
    if (!stockItemId) continue;
    const [balance] = await tx
      .select({ openedAt: inventoryBalances.openedAt })
      .from(inventoryBalances)
      .where(and(eq(inventoryBalances.warehouseId, warehouseId), eq(inventoryBalances.stockItemId, stockItemId)));
    const opening = await openingMovement(tx, warehouseId, stockItemId);
    if (balance?.openedAt && opening && opening.onHandDelta >= (goodBySku.get(sku) ?? 0)) viable.add(sku);
  }
  const touched = [...viable].map((sku) => stockByVariant.get(variantBySku.get(sku)!)!).sort();
  // Попередження цих товарів до історії (див. keepAlertsAsBefore).
  const alertsBefore = await alertRowsOf(tx, touched);

  let batches = 0;
  let receipts = 0;
  let good = 0;
  let defective = 0;
  const absorbed = new Map<string, number>();
  for (const plan of DEMO_PRODUCTION_HISTORY) {
    const lines = plan.lines.filter((l) => viable.has(l.sku));
    if (lines.length === 0) continue;
    const created = await run(daysAgo(now, plan.createdDaysAgo), (c) => createBatch(c, {
      title: plan.title,
      plannedReadyDate: businessDate(daysAgo(now, plan.readyDaysAgo)),
      manufacturer: DEMO_HISTORY_MANUFACTURER,
      notes: DEMO_HISTORY_NOTE,
      extraCost: plan.extraCost,
      costCurrency: COST_CURRENCY,
      lines: lines.map((l) => ({ variantId: variantBySku.get(l.sku)!, quantity: l.quantity, unitCost: l.unitCost })),
    }));
    const batchId = created.batchId;
    const startedAt = daysAgo(now, plan.startedDaysAgo);
    await run(startedAt, (c) => startProduction(c, batchId, 1));
    await setMovementTime(
      tx,
      (await tx.select({ key: inventoryMovements.idempotencyKey }).from(inventoryMovements).where(and(eq(inventoryMovements.productionBatchId, batchId), eq(inventoryMovements.type, "production_start")))).map((r) => r.key),
      startedAt,
    );
    const lineRows = await tx.select().from(productionBatchLines).where(eq(productionBatchLines.batchId, batchId));
    const lineBySku = new Map(lines.map((l) => [l.sku, lineRows.find((r) => r.variantId === variantBySku.get(l.sku))!]));

    for (const [index, receipt] of plan.receipts.entries()) {
      const receiptLines = receipt.lines.filter((l) => lineBySku.has(l.sku));
      if (receiptLines.length === 0) continue;
      const receivedAt = daysAgo(now, receipt.daysAgo);
      const res = await run(receivedAt, (c) =>
        receiveProduction(c, batchId, {
          idempotencyKey: demoUuid(`receipt:${batchId}:${index}`),
          lines: receiptLines.map((l) => ({ batchLineId: lineBySku.get(l.sku)!.id, good: l.good, defective: l.defective ?? 0, defectReason: l.reason ?? null })),
          note: DEMO_NOTE,
        }),
      );
      receipts += 1;
      const rows = await tx.select().from(productionReceiptLines).where(eq(productionReceiptLines.receiptId, res.receiptId));
      // Надходження історії вже є в знімку Shopify (opening їх поглинає) — стан передачі "none".
      await setMovementTime(tx, rows.map((r) => inventoryKeys.productionReceipt(r.id)), receivedAt, { shopifySyncState: "none" });
      // Брак повернуто виробнику через writeOffAfterDays днів (списання браку тим самим сервісом, що й форма картки).
      const writeOffAt = new Date(receivedAt.getTime() + plan.writeOffAfterDays * DAY_MS);
      for (const l of receiptLines) {
        const variantId = variantBySku.get(l.sku)!;
        good += l.good;
        absorbed.set(stockByVariant.get(variantId)!, (absorbed.get(stockByVariant.get(variantId)!) ?? 0) + l.good);
        if (!l.defective) continue;
        defective += l.defective;
        const row = rows.find((r) => r.batchLineId === lineBySku.get(l.sku)!.id)!;
        const operationId = demoUuid(`defect-writeoff:${row.id}`);
        await run(writeOffAt, (c) =>
          writeOffDefective(c, {
            operationId,
            stockItemId: stockByVariant.get(variantId)!,
            quantity: l.defective!,
            reason: "returned_to_manufacturer",
            note: DEMO_NOTE,
          }),
        );
        await setMovementTime(tx, [inventoryKeys.manual(operationId)], writeOffAt);
      }
    }
    if (plan.closeDaysAgo !== null) {
      const [row] = await tx.select({ version: productionBatches.version }).from(productionBatches).where(eq(productionBatches.id, batchId));
      await run(daysAgo(now, plan.closeDaysAgo), (c) => closeBatch(c, batchId, row!.version));
    }
    batches += 1;
  }

  // Opening поглинає отримане історією (у порядку блокувань журналу); попередження — за кінцевим балансом, а відкриті до
  // історії лишаються тими самими рядками.
  const items = [...absorbed.keys()].sort();
  if (items.length > 0) {
    await lockBalances(tx, items.map((stockItemId) => ({ warehouseId, stockItemId })));
    for (const stockItemId of items) await absorbIntoOpening(tx, warehouseId, stockItemId, -absorbed.get(stockItemId)!);
    const threshold = (await getSetting(tx, "warehouse")).lowStockThreshold;
    await evaluateStockAlerts(tx, items, { defaultThreshold: threshold });
    await keepAlertsAsBefore(tx, alertsBefore, touched);
  }
  return { batches, receipts, good, defective };
}

async function seedMaterialHistory(tx: Tx, warehouseId: string, now: Date): Promise<number> {
  const codes = [...new Set(DEMO_MATERIAL_HISTORY.flatMap((d) => Object.keys(d.use)))];
  const materials = await tx
    .select({ id: packagingMaterials.id, code: packagingMaterials.code })
    .from(packagingMaterials)
    .where(inArray(packagingMaterials.code, codes))
    .orderBy(asc(packagingMaterials.code));
  const stockByCode = new Map<string, { materialId: string; stockItemId: string }>();
  for (const m of materials) {
    const stockItemId = await ensureStockItemForMaterial(tx, m.id);
    // Без руху opening (матеріал створено вручну без початкового залишку) — історії для нього немає.
    if (await openingMovement(tx, warehouseId, stockItemId)) stockByCode.set(m.code, { materialId: m.id, stockItemId });
  }
  const movements: Array<MovementInput & { at: Date }> = [];
  const total = new Map<string, number>();
  for (const [index, day] of DEMO_MATERIAL_HISTORY.entries()) {
    for (const [code, qty] of Object.entries(day.use)) {
      const m = stockByCode.get(code);
      if (!m || qty <= 0) continue;
      movements.push({
        warehouseId,
        stockItemId: m.stockItemId,
        type: "material_consume",
        idempotencyKey: inventoryKeys.demoMaterialHistory(index, m.materialId),
        onHandDelta: -qty,
        reason: "demo_history",
        note: DEMO_NOTE,
        at: daysAgo(now, day.daysAgo),
      });
      total.set(m.stockItemId, (total.get(m.stockItemId) ?? 0) + qty);
    }
  }
  if (movements.length === 0) return 0;
  const items = [...total.keys()].sort();
  await lockBalances(tx, items.map((stockItemId) => ({ warehouseId, stockItemId })));
  // Opening — до першої витрати й більший на витрачене: після витрати залишок той самий, що й без історії.
  const openingAt = daysAgo(now, MATERIAL_OPENING_DAYS_AGO);
  for (const stockItemId of items) await absorbIntoOpening(tx, warehouseId, stockItemId, total.get(stockItemId)!, openingAt);
  // Кінцевий баланс дорівнює попередньому → попередження не переоцінюються (жодного «закрито й знову відкрито»).
  const res = await applyMovements(
    tx,
    SYSTEM_ACTOR,
    movements.map(({ at: _at, ...m }) => m),
    { evaluateAlerts: false, shopifyPush: "off" },
  );
  const keysByTime = new Map<number, string[]>();
  for (const m of movements) keysByTime.set(m.at.getTime(), [...(keysByTime.get(m.at.getTime()) ?? []), m.idempotencyKey]);
  for (const [time, keys] of keysByTime) await setMovementTime(tx, keys, new Date(time));
  return res.applied.length;
}
