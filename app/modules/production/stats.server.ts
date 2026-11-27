/**
 * Статистика виробництва за період (сторінка «Виробництво»): отримано якісних і браку, частка браку за моделями й
 * кольорами, частка партій, отриманих вчасно (відносно планової дати готовності), прострочені зараз. Визначення —
 * stats.ts. Собівартість — ЛИШЕ з includeCosts (викликач передає can(actor, "finance.view")): без нього costs = null
 * і жодних сум у результаті немає.
 *
 * Собівартість отриманого — з рухів receipt_production надходжень періоду (unit_cost × (якісні + брак), як модуль
 * виробництва записує планову собівартість одиниці з додатковими витратами партії); гроші — BigInt (lib/money),
 * окремо за валютами. Без даних покупців — лише кількості, моделі й кольори.
 */
import { and, asc, count, eq, gte, inArray, lte } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import {
  inventoryMovements,
  productionBatchLines,
  productionBatches,
  productionReceiptLines,
  productionReceipts,
  productVariants,
} from "~/db/schema";
import { fromMinor, toMinor } from "~/lib/money";
import { inventoryKeys } from "~/modules/inventory/keys";
import { businessDate, businessDayEnd, businessDayStart } from "~/modules/warehouse/dates";
import { defectRatePercent, divideMinorHalfUp } from "./calc";
import { overdueCondition } from "./queries.server";
import {
  batchCompletionTime,
  groupDefects,
  statsPeriod,
  summarizeTimeliness,
  timelinessOf,
  type BatchLineOrdered,
  type DefectGroup,
  type LineReceiptPoint,
  type StatsPeriod,
  type StatsPeriodKey,
  type Timeliness,
  type TimelinessSummary,
} from "./stats";

/** Стани, у яких партія вважається завершеною (більше надходжень не чекаємо). */
const COMPLETED_STATUSES = ["received", "closed"] as const;
const KEY_CHUNK = 1000;

export interface ProductionStatsCostTotal {
  currency: string;
  /** Собівартість отриманих одиниць (якісні + брак) за збереженою собівартістю одиниці. */
  amount: string;
  goodUnits: number;
  /** amount / якісні (округлення до копійки); null — якісних немає. */
  perGoodUnit: string | null;
}

export interface ProductionStats {
  period: StatsPeriod;
  totals: {
    good: number;
    defective: number;
    produced: number;
    defectRate: number | null;
    /** Надходжень і партій із надходженнями в періоді. */
    receipts: number;
    batches: number;
  };
  byModel: DefectGroup[];
  byColor: DefectGroup[];
  timeliness: TimelinessSummary;
  /** Ще не отримано повністю, а планова дата вже минула (зараз, незалежно від періоду). */
  overdueOpen: number;
  /** Лише з includeCosts (finance.view); інакше null. */
  costs: { totals: ProductionStatsCostTotal[]; unitsWithoutCost: number } | null;
}

export async function loadProductionStats(
  db: DbOrTx,
  opts: { today: string; period: StatsPeriodKey; includeCosts?: boolean },
): Promise<ProductionStats> {
  const period = statsPeriod(opts.period, opts.today);
  const inPeriod = and(
    gte(productionReceipts.receivedAt, businessDayStart(period.from)),
    lte(productionReceipts.receivedAt, businessDayEnd(period.to)),
  );
  const [lines, [overdueRow]] = await Promise.all([
    db
      .select({
        receiptLineId: productionReceiptLines.id,
        receiptId: productionReceipts.id,
        batchId: productionReceipts.batchId,
        good: productionReceiptLines.goodQty,
        defective: productionReceiptLines.defectiveQty,
        model: productVariants.model,
        color: productVariants.color,
      })
      .from(productionReceiptLines)
      .innerJoin(productionReceipts, eq(productionReceipts.id, productionReceiptLines.receiptId))
      .innerJoin(productionBatchLines, eq(productionBatchLines.id, productionReceiptLines.batchLineId))
      .innerJoin(productVariants, eq(productVariants.id, productionBatchLines.variantId))
      .where(inPeriod),
    db.select({ c: count() }).from(productionBatches).where(overdueCondition(opts.today)),
  ]);

  const good = lines.reduce((s, l) => s + l.good, 0);
  const defective = lines.reduce((s, l) => s + l.defective, 0);
  const batchIds = [...new Set(lines.map((l) => l.batchId))];
  const [timeliness, costs] = await Promise.all([
    loadTimeliness(db, batchIds, period),
    opts.includeCosts ? loadReceiptCosts(db, lines) : Promise.resolve(null),
  ]);
  return {
    period,
    totals: {
      good,
      defective,
      produced: good + defective,
      defectRate: defectRatePercent(defective, good + defective),
      receipts: new Set(lines.map((l) => l.receiptId)).size,
      batches: batchIds.length,
    },
    byModel: groupDefects(lines.map((l) => ({ value: l.model, good: l.good, defective: l.defective }))),
    byColor: groupDefects(lines.map((l) => ({ value: l.color, good: l.good, defective: l.defective }))),
    timeliness,
    overdueOpen: Number(overdueRow?.c ?? 0),
    costs,
  };
}

/**
 * Вчасність партій, завершених у періоді. Завершитися в періоді може лише партія з надходженням у періоді (момент
 * завершення — одне з її надходжень), тож кандидати — партії з надходженнями періоду в стані «Отримано»/«Закрито».
 */
async function loadTimeliness(db: DbOrTx, candidateIds: readonly string[], period: StatsPeriod): Promise<TimelinessSummary> {
  if (candidateIds.length === 0) return summarizeTimeliness([]);
  const batches = await db
    .select({ id: productionBatches.id, plannedReadyDate: productionBatches.plannedReadyDate })
    .from(productionBatches)
    .where(and(inArray(productionBatches.id, [...candidateIds]), inArray(productionBatches.status, [...COMPLETED_STATUSES])));
  if (batches.length === 0) return summarizeTimeliness([]);
  const ids = batches.map((b) => b.id);
  const [lineRows, receiptRows] = await Promise.all([
    db
      .select({ batchId: productionBatchLines.batchId, lineId: productionBatchLines.id, ordered: productionBatchLines.quantityOrdered })
      .from(productionBatchLines)
      .where(inArray(productionBatchLines.batchId, ids)),
    db
      .select({
        batchId: productionReceipts.batchId,
        lineId: productionReceiptLines.batchLineId,
        receivedAt: productionReceipts.receivedAt,
        good: productionReceiptLines.goodQty,
        defective: productionReceiptLines.defectiveQty,
      })
      .from(productionReceipts)
      .innerJoin(productionReceiptLines, eq(productionReceiptLines.receiptId, productionReceipts.id))
      .where(inArray(productionReceipts.batchId, ids))
      .orderBy(asc(productionReceipts.receivedAt), asc(productionReceipts.id)),
  ]);
  // Завершення — за позиціями (як стан «Отримано»), а не за сумою партії: надлишок однієї позиції не закриває іншу.
  const linesByBatch = new Map<string, BatchLineOrdered[]>();
  for (const r of lineRows) {
    const lines = linesByBatch.get(r.batchId) ?? [];
    lines.push({ lineId: r.lineId, ordered: r.ordered });
    linesByBatch.set(r.batchId, lines);
  }
  const receiptsByBatch = new Map<string, LineReceiptPoint[]>();
  for (const r of receiptRows) {
    const points = receiptsByBatch.get(r.batchId) ?? [];
    points.push({ lineId: r.lineId, receivedAt: r.receivedAt, produced: r.good + r.defective });
    receiptsByBatch.set(r.batchId, points);
  }
  const values: Timeliness[] = [];
  for (const b of batches) {
    const completedAt = batchCompletionTime(linesByBatch.get(b.id) ?? [], receiptsByBatch.get(b.id) ?? []);
    if (!completedAt) continue;
    const completedOn = businessDate(completedAt);
    if (completedOn < period.from || completedOn > period.to) continue;
    values.push(timelinessOf(completedOn, b.plannedReadyDate));
  }
  return summarizeTimeliness(values);
}

/** Собівартість отриманого: рухи receipt_production рядків надходжень періоду (за ключем ідемпотентності). */
async function loadReceiptCosts(
  db: DbOrTx,
  lines: ReadonlyArray<{ receiptLineId: string; good: number; defective: number }>,
): Promise<{ totals: ProductionStatsCostTotal[]; unitsWithoutCost: number }> {
  const keys = lines.map((l) => inventoryKeys.productionReceipt(l.receiptLineId));
  const movements: Array<{ unitCost: string | null; currency: string | null; good: number; defective: number }> = [];
  for (let i = 0; i < keys.length; i += KEY_CHUNK) {
    movements.push(
      ...(await db
        .select({
          unitCost: inventoryMovements.unitCost,
          currency: inventoryMovements.costCurrency,
          good: inventoryMovements.onHandDelta,
          defective: inventoryMovements.defectiveDelta,
        })
        .from(inventoryMovements)
        .where(and(eq(inventoryMovements.type, "receipt_production"), inArray(inventoryMovements.idempotencyKey, keys.slice(i, i + KEY_CHUNK))))),
    );
  }
  const byCurrency = new Map<string, { minor: bigint; goodUnits: number }>();
  let unitsWithoutCost = 0;
  for (const m of movements) {
    const units = Math.max(0, m.good) + Math.max(0, m.defective);
    if (!m.unitCost || !m.currency) {
      unitsWithoutCost += units;
      continue;
    }
    const acc = byCurrency.get(m.currency) ?? { minor: 0n, goodUnits: 0 };
    acc.minor += toMinor(m.unitCost) * BigInt(units);
    acc.goodUnits += Math.max(0, m.good);
    byCurrency.set(m.currency, acc);
  }
  // Рядки надходжень без руху (не мало б бути) — без собівартості.
  const covered = movements.reduce((s, m) => s + Math.max(0, m.good) + Math.max(0, m.defective), 0);
  const all = lines.reduce((s, l) => s + l.good + l.defective, 0);
  unitsWithoutCost += Math.max(0, all - covered);
  return {
    totals: [...byCurrency]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, v]) => ({
        currency,
        amount: fromMinor(v.minor),
        goodUnits: v.goodUnits,
        perGoodUnit: v.goodUnits > 0 ? fromMinor(divideMinorHalfUp(v.minor, BigInt(v.goodUnits))) : null,
      })),
    unitsWithoutCost,
  };
}
