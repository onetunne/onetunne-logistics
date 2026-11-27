/**
 * Митні дані, вага й габарити товару, змінені в застосунку (етап 3).
 *
 * - Зберігаються в product_variants.customs_overrides і мають пріоритет над даними Shopify.
 * - Синхронізація Shopify їх не перезаписує (колонка не входить у дані синхронізації).
 * - Порожнє поле у формі = «використовувати значення з Shopify» (перевизначення видаляється).
 * - Чистий модуль: без БД.
 */
import { z } from "zod";
import { normalizeHsCode } from "~/modules/validation";

export const OVERRIDE_FIELDS = [
  "hsCode",
  "countryOfOrigin",
  "customsDescription",
  "customsDescriptionLocal",
  "material",
  "weightGrams",
  "lengthMm",
  "widthMm",
  "heightMm",
] as const;
export type OverrideField = (typeof OVERRIDE_FIELDS)[number];

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? undefined : v))
    .optional();
const size = (max: number) =>
  z
    .union([z.literal(""), z.coerce.number().int().min(1).max(max)])
    .transform((v) => (v === "" ? undefined : v))
    .optional();

/** Вхідні дані форми (рядки). Порожньо → поле не перевизначене. */
export const customsOverridesInputSchema = z.object({
  hsCode: z
    .string()
    .trim()
    .optional()
    .transform((v, ctx) => {
      if (!v) return undefined;
      const normalized = normalizeHsCode(v);
      if (!normalized) {
        ctx.addIssue({ code: "custom", message: "hsCode" });
        return z.NEVER;
      }
      return normalized;
    }),
  countryOfOrigin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^([A-Z]{2})?$/, "countryOfOrigin")
    .transform((v) => (v === "" ? undefined : v))
    .optional(),
  customsDescription: text(200),
  customsDescriptionLocal: text(200),
  material: text(50),
  weightGrams: size(100_000),
  lengthMm: size(3_000),
  widthMm: size(3_000),
  heightMm: size(3_000),
});

export type CustomsOverrides = {
  hsCode?: string;
  countryOfOrigin?: string;
  customsDescription?: string;
  customsDescriptionLocal?: string;
  material?: string;
  weightGrams?: number;
  lengthMm?: number;
  widthMm?: number;
  heightMm?: number;
};

/** Збережене значення з БД → перевірені перевизначення (некоректне ігнорується). */
export function readOverrides(value: unknown): CustomsOverrides {
  if (!value || typeof value !== "object") return {};
  const v = value as Record<string, unknown>;
  const out: CustomsOverrides = {};
  for (const k of ["hsCode", "countryOfOrigin", "customsDescription", "customsDescriptionLocal", "material"] as const) {
    if (typeof v[k] === "string" && v[k]) out[k] = v[k] as string;
  }
  for (const k of ["weightGrams", "lengthMm", "widthMm", "heightMm"] as const) {
    if (typeof v[k] === "number" && Number.isInteger(v[k]) && (v[k] as number) > 0) out[k] = v[k] as number;
  }
  return out;
}

export interface VariantCustomsFields {
  hsCode: string | null;
  countryOfOrigin: string | null;
  customsDescription: string | null;
  customsDescriptionLocal: string | null;
  material: string | null;
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  customsOverrides?: unknown;
}

/** Ефективні значення: перевизначення застосунку → інакше дані Shopify. */
export function effectiveVariant<T extends VariantCustomsFields>(variant: T): T & { overriddenFields: OverrideField[] } {
  const o = readOverrides(variant.customsOverrides);
  const overriddenFields = OVERRIDE_FIELDS.filter((f) => o[f] !== undefined);
  return { ...variant, ...o, overriddenFields };
}
