/**
 * Перевірка вхідних даних модуля «Упаковка» (zod). Приймає і значення форм (рядки), і типізовані значення API.
 * Повідомлення помилок — ключі i18n (packaging.error.*); решта показується як «Некоректне значення».
 */
import { z } from "zod";
import { KIT_PER, KIT_SCOPES, MATERIAL_KINDS, UNITS } from "./constants";

export const MAX_DIMENSION_MM = 3000;
export const MAX_BOX_WEIGHT_GRAMS = 100_000;
export const MAX_TARE_GRAMS = 30_000;
export const MAX_THRESHOLD = 100_000;
export const MAX_STOCK_QUANTITY = 1_000_000;
export const MAX_KIT_LINES = 50;
export const MAX_KIT_LINE_QUANTITY = 1000;
export const MAX_KIT_PRODUCTS = 2000;
export const MAX_STOCK_LINES = 500;
export const MATERIAL_CODE_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const trimmed = (v: unknown) => (typeof v === "string" ? v.trim() : v);

/** "" / null / undefined → null; інакше ціле в межах. */
const optionalInt = (min: number, max: number) =>
  z.preprocess(
    (v) => {
      const t = trimmed(v);
      return t === "" || t === undefined ? null : t;
    },
    z.union([z.null(), z.coerce.number({ message: "packaging.error.number" }).int("packaging.error.integer").min(min, "packaging.error.range").max(max, "packaging.error.range")]),
  );

/** UUID (нормалізується до нижнього регістру — як у базі й ключах ідемпотентності). */
export const uuidSchema = z.string().trim().regex(UUID_RE, "packaging.error.invalid").transform((v) => v.toLowerCase());

const moneySchema = z.preprocess(
  (v) => {
    const t = trimmed(v);
    if (t === "" || t === undefined || t === null) return null;
    return typeof t === "string" ? t.replace(",", ".") : String(t);
  },
  z.union([z.null(), z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, "packaging.error.money")]),
);

const currencySchema = z.preprocess(
  (v) => {
    const t = trimmed(v);
    return t === "" || t === undefined || t === null ? null : String(t).toUpperCase();
  },
  z.union([z.null(), z.string().regex(/^[A-Z]{3}$/, "packaging.error.currency")]),
);

/**
 * Матеріал — повна заміна полів (як форма): не передані габарити/вага/поріг → null. Виняток — собівартість:
 * не передано → не змінюється.
 */
export const materialInputSchema = z
  .object({
    code: z.preprocess(
      (v) => (typeof v === "string" ? v.trim().toLowerCase() : v),
      z.string().regex(MATERIAL_CODE_RE, "packaging.error.code"),
    ),
    name: z.preprocess(trimmed, z.string().min(1, "packaging.error.required").max(120, "packaging.error.tooLong")),
    kind: z.enum(MATERIAL_KINDS, { message: "packaging.error.invalid" }),
    unit: z.enum(UNITS, { message: "packaging.error.invalid" }).default("pcs"),
    innerLengthMm: optionalInt(1, MAX_DIMENSION_MM).default(null),
    innerWidthMm: optionalInt(1, MAX_DIMENSION_MM).default(null),
    innerHeightMm: optionalInt(1, MAX_DIMENSION_MM).default(null),
    maxWeightGrams: optionalInt(1, MAX_BOX_WEIGHT_GRAMS).default(null),
    tareWeightGrams: optionalInt(0, MAX_TARE_GRAMS).default(null),
    /** Собівартість одиниці — береться до уваги лише з finance.view. Не передано (undefined) — не змінюється; "" — очистити. */
    unitCost: moneySchema.optional(),
    costCurrency: currencySchema.optional(),
    active: z.boolean().default(true),
    lowStockThreshold: optionalInt(0, MAX_THRESHOLD).default(null),
  })
  .superRefine((v, ctx) => {
    const dims = [v.innerLengthMm, v.innerWidthMm, v.innerHeightMm];
    const set = dims.filter((d) => d !== null).length;
    if (set !== 0 && set !== 3) {
      for (const [i, field] of (["innerLengthMm", "innerWidthMm", "innerHeightMm"] as const).entries()) {
        if (dims[i] === null) ctx.addIssue({ code: "custom", path: [field], message: "packaging.error.dimsIncomplete" });
      }
    }
    if (v.unitCost != null && v.costCurrency == null) {
      ctx.addIssue({ code: "custom", path: ["costCurrency"], message: "packaging.error.currencyRequired" });
    }
  });

export type MaterialInput = z.input<typeof materialInputSchema>;
export type ParsedMaterialInput = z.output<typeof materialInputSchema>;

export const kitLineInputSchema = z.object({
  materialId: uuidSchema,
  quantity: z.preprocess(trimmed, z.coerce.number({ message: "packaging.error.number" }).int("packaging.error.integer").min(1, "packaging.error.range").max(MAX_KIT_LINE_QUANTITY, "packaging.error.range")),
  per: z.enum(KIT_PER, { message: "packaging.error.invalid" }),
});

export const kitTemplateInputSchema = z
  .object({
    name: z.preprocess(trimmed, z.string().min(1, "packaging.error.required").max(120, "packaging.error.tooLong")),
    appliesTo: z.enum(KIT_SCOPES, { message: "packaging.error.invalid" }),
    priority: z.preprocess(
      (v) => {
        const t = trimmed(v);
        return t === "" || t === undefined || t === null ? 0 : t;
      },
      z.coerce.number({ message: "packaging.error.number" }).int("packaging.error.integer").min(-1000, "packaging.error.range").max(1000, "packaging.error.range"),
    ).default(0),
    active: z.boolean().default(true),
    lines: z.array(kitLineInputSchema).max(MAX_KIT_LINES, "packaging.error.tooMany"),
    productIds: z.array(uuidSchema).max(MAX_KIT_PRODUCTS, "packaging.error.tooMany").default([]),
  })
  .superRefine((v, ctx) => {
    if (v.lines.length === 0) ctx.addIssue({ code: "custom", path: ["lines"], message: "packaging.error.kitNoLines" });
    const seen = new Set<string>();
    v.lines.forEach((l, i) => {
      const k = `${l.materialId.toLowerCase()}|${l.per}`;
      if (seen.has(k)) ctx.addIssue({ code: "custom", path: ["lines", i, "materialId"], message: "packaging.error.kitDuplicateLine" });
      seen.add(k);
    });
    if (v.appliesTo === "products" && v.productIds.length === 0) {
      ctx.addIssue({ code: "custom", path: ["productIds"], message: "packaging.error.kitNoProducts" });
    }
  });

export type KitTemplateInput = z.input<typeof kitTemplateInputSchema>;
export type ParsedKitTemplateInput = z.output<typeof kitTemplateInputSchema>;

export const MATERIAL_STOCK_OPERATIONS = ["receive", "writeoff", "adjust", "count"] as const;
export type MaterialStockOperation = (typeof MATERIAL_STOCK_OPERATIONS)[number];

/**
 * Зміна залишку для операції — одна формула для сервера (applyMaterialStock) і попереднього перегляду форми.
 * receive: +q (q > 0); writeoff: −q (q > 0); adjust: ±q (q ≠ 0); count: q − поточний (q ≥ 0). null — недопустима кількість.
 */
export function materialStockDelta(operation: MaterialStockOperation, quantity: number, onHand: number): number | null {
  if (!Number.isSafeInteger(quantity)) return null;
  switch (operation) {
    case "receive":
      return quantity > 0 ? quantity : null;
    case "writeoff":
      return quantity > 0 ? -quantity : null;
    case "adjust":
      return quantity !== 0 ? quantity : null;
    case "count":
      return quantity >= 0 ? quantity - onHand : null;
  }
}

export const materialStockInputSchema = z.object({
  /** uuid операції (генерується при відкритті форми) → ключі manual:<operationId>:<materialId>. */
  operationId: uuidSchema,
  operation: z.enum(MATERIAL_STOCK_OPERATIONS, { message: "packaging.error.invalid" }),
  lines: z
    .array(
      z.object({
        materialId: uuidSchema,
        quantity: z.preprocess(
          trimmed,
          z.coerce.number({ message: "packaging.error.number" }).int("packaging.error.integer").min(-MAX_STOCK_QUANTITY, "packaging.error.range").max(MAX_STOCK_QUANTITY, "packaging.error.range"),
        ),
      }),
    )
    .min(1, "packaging.error.stockNoLines")
    .max(MAX_STOCK_LINES, "packaging.error.tooMany"),
  note: z.preprocess((v) => (trimmed(v) === "" ? null : trimmed(v)), z.union([z.null(), z.string().max(500, "packaging.error.tooLong")])).optional(),
  /** Лише для receive і лише з finance.view. */
  unitCost: moneySchema.optional(),
  costCurrency: currencySchema.optional(),
});

export type MaterialStockInput = z.input<typeof materialStockInputSchema>;
