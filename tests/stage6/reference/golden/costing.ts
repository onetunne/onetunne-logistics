/**
 * Золоті випадки етапу 6 (WP12a → WP12b): рушій собівартості (G5 — послідовності §6.8) і вартість запасів на дату й
 * собівартість моделі (G18). Валюта оцінки UAH; суми витрат — додатні величини, наслідки — зі знаком впливу.
 */
import type { CostMovement } from "../model/costing";

export const G5_BATCH_9_1: readonly CostMovement[] = [
  { kind: "receipt", id: "r1", date: "2026-09-01", good: 9, defect: 1, unitCost: "100.00" },
  ...Array.from({ length: 9 }, (_, i) => ({ kind: "outflow" as const, id: `s${i + 1}`, date: "2026-09-10", qty: 1, reason: "sale" as const, orderId: `o${i + 1}` })),
];
export const G5_BATCH_9_1_EXPECTED = { sales: ["111.11", "111.11", "111.11", "111.11", "111.11", "111.11", "111.11", "111.12", "111.11"], total: "1000.00", poolValue: "0.00" } as const;

export const G5_DEFECT_WRITEOFF: readonly CostMovement[] = [
  { kind: "receipt", id: "r1", date: "2026-09-01", good: 10, unitCost: "100.00" },
  { kind: "outflow", id: "dm", date: "2026-09-02", qty: 1, reason: "defect_mark" },
  { kind: "defect_writeoff", id: "dw", date: "2026-09-03", qty: 1 },
  { kind: "outflow", id: "s", date: "2026-09-04", qty: 9, reason: "sale", orderId: "o1" },
];
export const G5_DEFECT_REPAIR: readonly CostMovement[] = [
  { kind: "receipt", id: "r1", date: "2026-09-01", good: 10, unitCost: "100.00" },
  { kind: "outflow", id: "dm", date: "2026-09-02", qty: 1, reason: "defect_mark" },
  { kind: "defect_repair", id: "dr", date: "2026-09-03", qty: 1 },
  { kind: "outflow", id: "s", date: "2026-09-04", qty: 10, reason: "sale", orderId: "o1" },
];
export const G5_DEFECT_EXPECTED = { writeoff: { loss: "-100.00", sale: "900.00" }, repair: { loss: "-100.00", gain: "100.00", sale: "1000.00", n: "0.00" } } as const;

/** Завершення відкриття (= основа G18): відкриття 5 (01.09), продаж 3 (10.09), надходження 10 × 100 (15.09), продаж 4 (20.09), 90,00 від 01.09 «до вже проданих» (25.11). */
export const G5_OPENING_COMPLETION: readonly CostMovement[] = [
  { kind: "opening", id: "op", date: "2026-09-01", qty: 5 },
  { kind: "outflow", id: "s1", date: "2026-09-10", qty: 3, reason: "sale", orderId: "o1" },
  { kind: "receipt", id: "r1", date: "2026-09-15", good: 10, unitCost: "100.00" },
  { kind: "outflow", id: "s2", date: "2026-09-20", qty: 4, reason: "sale", orderId: "o2" },
  { kind: "completion", id: "c1", date: "2026-11-25", unitCost: "90.00", effectiveFrom: "2026-09-01", toStock: false, toSold: true },
];
export const G5_OPENING_EXPECTED = {
  sale2Known: "200.00",
  completions: [
    { date: "2026-09-10", orderId: "o1", amount: "-270.00" },
    { date: "2026-09-20", orderId: "o2", amount: "-180.00" },
  ],
  pool: { knownQty: 8, knownValue: "800.00" },
  /** 5 × 90 + 1 000 = 1 450 = 270 + 180 + 200 + 800. */
  conservation: "1450.00",
} as const;

/** Від'ємний залишок: продаж 2 (10.09) з порожнього пулу; надходження 10 × 100 (15.09). */
export const G5_DEFICIT: readonly CostMovement[] = [
  { kind: "outflow", id: "s1", date: "2026-09-10", qty: 2, reason: "sale", orderId: "o1" },
  { kind: "receipt", id: "r1", date: "2026-09-15", good: 10, unitCost: "100.00" },
];
export const G5_DEFICIT_EXPECTED = { completion: { date: "2026-09-10", amount: "-200.00" }, pool: { knownQty: 8, knownValue: "800.00" } } as const;

/** Коригування партії: 10 × 100 (01.10), продано 4, 05.11 повна собівартість 110,00. */
export const G5_REVALUE_BASIC: readonly CostMovement[] = [
  { kind: "receipt", id: "rA", date: "2026-10-01", good: 10, unitCost: "100.00" },
  { kind: "outflow", id: "s1", date: "2026-10-10", qty: 4, reason: "sale", orderId: "o1" },
  { kind: "revalue", id: "adj", date: "2026-11-05", receiptId: "rA", target: "1100.00" },
];
export const G5_REVALUE_BASIC_EXPECTED = { stock: "60.00", cogsAdjustment: "-40.00", pool: { knownQty: 6, knownValue: "660.00" } } as const;

/** (А) A 10 × 100, продано всі 10; B 10 × 120; A → 110. */
export const G5_REVALUE_A: readonly CostMovement[] = [
  { kind: "receipt", id: "rA", date: "2026-10-01", good: 10, unitCost: "100.00" },
  { kind: "outflow", id: "s1", date: "2026-10-10", qty: 10, reason: "sale", orderId: "o1" },
  { kind: "receipt", id: "rB", date: "2026-11-01", good: 10, unitCost: "120.00" },
  { kind: "revalue", id: "adj", date: "2026-11-05", receiptId: "rA", target: "1100.00" },
];
/** (Б) A 10 × 100, продано 4, B 10 × 120, продано 14 (пул 16 → 2); A → 110. */
export const G5_REVALUE_B: readonly CostMovement[] = [
  { kind: "receipt", id: "rA", date: "2026-10-01", good: 10, unitCost: "100.00" },
  { kind: "outflow", id: "s1", date: "2026-10-10", qty: 4, reason: "sale", orderId: "o1" },
  { kind: "receipt", id: "rB", date: "2026-11-01", good: 10, unitCost: "120.00" },
  { kind: "outflow", id: "s2", date: "2026-11-02", qty: 14, reason: "sale", orderId: "o2" },
  { kind: "revalue", id: "adj", date: "2026-11-05", receiptId: "rA", target: "1100.00" },
];
/** (В) у пулі 5 × 10; надходить A 10 × 100; продано 10; A → 0. */
export const G5_REVALUE_C: readonly CostMovement[] = [
  { kind: "receipt", id: "r0", date: "2026-09-01", good: 5, unitCost: "10.00" },
  { kind: "receipt", id: "rA", date: "2026-10-01", good: 10, unitCost: "100.00" },
  { kind: "outflow", id: "s1", date: "2026-10-10", qty: 10, reason: "sale", orderId: "o1" },
  { kind: "revalue", id: "adj", date: "2026-11-05", receiptId: "rA", target: "0.00" },
];
export const G5_REVALUE_ABC_EXPECTED = {
  A: { stock: "0.00", cogsAdjustment: "-100.00", pool: { knownQty: 10, knownValue: "1200.00" } },
  B: { stock: "7.50", cogsAdjustment: "-92.50" },
  C: { sale: "700.00", stock: "-333.33", cogsAdjustment: "666.67", pool: { knownQty: 5, knownValue: "16.67" } },
} as const;

/** Рядок партії з extra_cost у двох рядках (вигадані числа: остача extra 0,01 — до першого рядка). */
export const G5_BATCH_LINES = { lines: [{ unitCost: "100.00", produced: 7 }, { unitCost: "80.00", produced: 3 }], extraCost: "100.01", expectedTargets: ["770.01", "270.00"], producedTotal: "1040.01" } as const;

/** Повернення (а): варіант не відкритий, stdcogs 210,00; придатне повернення; повторний продаж. */
export const G5_RETURN_A: readonly CostMovement[] = [
  { kind: "customer_return", id: "ret", date: "2026-10-10", orderId: "o1", good: 1 },
  { kind: "outflow", id: "s2", date: "2026-10-12", qty: 1, reason: "sale", orderId: "o2" },
];
export const G5_RETURN_A_STANDARDS = { o1: "210.00" } as const;
export const G5_RETURN_A_EXPECTED = { stdcogs: "-210.00", cogsReturn: "210.00", resale: "-210.00", total: "-210.00" } as const;

/** Повернення (б): продаж 3 = 2 невідомі + 1 відома 100,00; повернення 1, потім ще 1; 90,00 «до вже проданих». */
export const G5_RETURN_B: readonly CostMovement[] = [
  { kind: "opening", id: "op", date: "2026-09-01", qty: 2 },
  { kind: "receipt", id: "r1", date: "2026-09-02", good: 1, unitCost: "100.00" },
  { kind: "outflow", id: "s1", date: "2026-09-10", qty: 3, reason: "sale", orderId: "o1" },
  { kind: "customer_return", id: "ret1", date: "2026-09-12", orderId: "o1", good: 1 },
  { kind: "customer_return", id: "ret2", date: "2026-09-13", orderId: "o1", good: 1 },
  { kind: "completion", id: "c1", date: "2026-09-20", unitCost: "90.00", effectiveFrom: "2026-09-01", toStock: false, toSold: true },
];
export const G5_RETURN_B_EXPECTED = { orderCogs: "-90.00", pool: { knownQty: 2, knownValue: "190.00" } } as const;

/** Повернення з пошкодженою одиницею — обидва записи етапу 5. */
export const G5_DAMAGED_SPLIT: readonly CostMovement[] = [
  { kind: "receipt", id: "r1", date: "2026-09-01", good: 2, unitCost: "100.00" },
  { kind: "outflow", id: "s1", date: "2026-09-10", qty: 2, reason: "sale", orderId: "o1" },
  { kind: "customer_return", id: "ret", date: "2026-09-12", orderId: "o1", good: 1, damaged: 1, record: "split" },
  { kind: "defect_mark_return", id: "ret:return_defect", date: "2026-09-12", qty: 1 },
];
export const G5_DAMAGED_PLAIN: readonly CostMovement[] = [
  { kind: "receipt", id: "r1", date: "2026-09-01", good: 2, unitCost: "100.00" },
  { kind: "outflow", id: "s1", date: "2026-09-10", qty: 2, reason: "sale", orderId: "o1" },
  { kind: "customer_return", id: "ret", date: "2026-09-12", orderId: "o1", good: 1, damaged: 1, record: "plain" },
];
export const G5_DAMAGED_EXPECTED = { orderCogs: "-100.00", cogsReturn: "100.00" } as const;

/** Вихід тестового замовлення → inventory_loss test_order. */
export const G5_TEST_ORDER: readonly CostMovement[] = [
  { kind: "receipt", id: "r1", date: "2026-09-01", good: 2, unitCost: "100.00" },
  { kind: "outflow", id: "t1", date: "2026-09-10", qty: 1, reason: "test_sale", orderId: "o-test" },
];
export const G5_TEST_ORDER_EXPECTED = { inventoryLoss: "-100.00", kind: "test_order" } as const;

/**
 * Скасована партія — «Списати невикористані витрати партії» (вигадані партія, номер і сума) → рядок витрат
 * inventory_loss з production_batch_id → запис inventory_loss (details.kind = production_cancelled, партія), R6.
 */
export const G5_CANCELLED_BATCH = {
  id: "wo-g5",
  productionBatchId: "pb-g5-cancelled",
  batchNumber: "PB-2026-0007",
  amount: "1500.00",
  currency: "UAH",
  date: "2026-11-20",
  enteredAt: "2026-11-20T10:00:00Z",
  expectedEntry: "-1500.00",
  expectedDetails: { kind: "production_cancelled", productionBatchId: "pb-g5-cancelled", batchNumber: "PB-2026-0007" },
} as const;

/** Позиція без списання: 2 од. × ручна 210,00 → −420,00 (owner_standard), стан «Факт (за ручною собівартістю)». */
export const G5_NO_WRITEOFF = { quantity: 2, unitCost: "210.00", expectedCogs: "-420.00", state: "actual", basis: "owner_standard", entryBasis: "owner_standard" } as const;

/** G18 — вартість запасів на дату (послідовність G5_OPENING_COMPLETION) і собівартість моделі M1. */
export const G18_EXPECTED = {
  at: {
    "2026-09-12": { knownValue: "0.00", unknownQty: 2 },
    "2026-09-16": { knownValue: "1000.00", unknownQty: 2 },
    "2026-09-21": { knownValue: "800.00", unknownQty: 0 },
    "2026-11-30": { knownValue: "800.00", unknownQty: 0 },
  },
  white: [{ kind: "receipt", id: "rw", date: "2026-09-05", good: 2, unitCost: "115.00" }] as readonly CostMovement[],
  model: { average: "103.00", black: "100.00", white: "115.00", manualBlack: "90.00" },
} as const;
