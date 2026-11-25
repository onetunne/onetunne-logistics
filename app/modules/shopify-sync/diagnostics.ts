/**
 * Безпечний опис запитів/відповідей Shopify для журналів: без персональних даних, токенів і ключів.
 * Значення адреси замінюються «формою»: '#' — цифра, 'A' — літера; для телефону — лише формат і довжина.
 * Без змін показуються лише некомунікативні коди: countryCode, provinceCode.
 */
export function valueShape(value: string): string {
  return value.replace(/\p{L}/gu, "A").replace(/\d/g, "#").slice(0, 24);
}

export function phoneFormat(value: string): string {
  const e164 = /^\+[1-9]\d{6,14}$/.test(value);
  return `${e164 ? "E164" : "nonE164"}(${value.length})`;
}

const CODE_FIELDS = new Set(["countryCode", "provinceCode", "country", "province"]);

/** Стан кожного поля: absent / null / empty / set(довжина) / форма / код країни/регіону. */
export function describeFields(obj: Record<string, unknown> | null | undefined, prefix = ""): string[] {
  if (!obj) return [`${prefix || "root"}:absent`];
  return Object.entries(obj).map(([k, v]) => {
    const key = `${prefix}${k}`;
    if (v === undefined) return `${key}:undefined`;
    if (v === null) return `${key}:null`;
    if (typeof v !== "string") return `${key}:${typeof v}`;
    if (v === "") return `${key}:empty`;
    if (CODE_FIELDS.has(k)) return `${key}=${v.slice(0, 8)}`;
    if (k === "phone") return `${key}:${phoneFormat(v)}`;
    if (k === "zip") return `${key}:shape(${valueShape(v)})`;
    if (k === "id") return `${key}:gid`;
    return `${key}:set(${v.length})`;
  });
}

export interface OrderUpdateInputLike {
  id?: string | null;
  email?: string | null;
  phone?: string | null;
  shippingAddress?: Record<string, unknown>;
}

export function describeOrderUpdateInput(input: OrderUpdateInputLike): string[] {
  const { shippingAddress, ...top } = input;
  return [...describeFields(top as Record<string, unknown>), ...describeFields(shippingAddress, "shippingAddress.")];
}

/** Варіанти запиту для покрокової діагностики (лише коректні поля схеми 2026-10, без обходу валідації). */
export type DiagnosticVariant = "as_sent" | "omit_nulls" | "omit_nulls_no_phones" | "address_only";

export const DIAGNOSTIC_VARIANTS: DiagnosticVariant[] = ["as_sent", "omit_nulls", "omit_nulls_no_phones", "address_only"];

function omitNulls(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== ""));
}

export function inputVariant(input: OrderUpdateInputLike, variant: DiagnosticVariant): OrderUpdateInputLike {
  const address = input.shippingAddress ?? {};
  switch (variant) {
    case "as_sent":
      return input;
    case "omit_nulls":
      return { ...omitNulls({ id: input.id, email: input.email, phone: input.phone }), shippingAddress: omitNulls(address) };
    case "omit_nulls_no_phones": {
      const { phone: _p, ...rest } = omitNulls(address);
      return { ...omitNulls({ id: input.id, email: input.email }), shippingAddress: rest };
    }
    case "address_only": {
      const { phone: _p, ...rest } = omitNulls(address);
      return { id: input.id, shippingAddress: rest };
    }
  }
}
