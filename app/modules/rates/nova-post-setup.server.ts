/**
 * Підготовка Nova Post до використання вартості доставки (власник):
 * - перевірка підключення API без створення накладних (connection-check.server.ts);
 * - підтвердження валюти сум і договірних тарифів (novaPost.tariffConfirmation);
 * - умова використання тарифів у Checkout: один тариф (варіант B) + дійсне підтвердження.
 */
import { requirePermission } from "~/domain/permissions";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { writeAudit } from "~/modules/audit/audit.server";
import { isTariffConfirmed, type AllSettings } from "~/modules/settings/schema";
import { loadSettings, updateSetting } from "~/modules/settings/settings.server";
import { checkNovaPostConnection, type NovaPostConnectionCheck } from "~/integrations/carriers/nova-post/connection-check.server";
import { NOVA_POST_ENDPOINTS } from "~/integrations/carriers/nova-post/client.server";
import type { FetchLike } from "~/integrations/carriers/nova-post/client.server";
import { NOVA_POST_CODE } from "~/integrations/carriers/nova-post/mapping";
import type { ServiceContext } from "~/server/types";

export type ConnectionCheckOutcome =
  | { ok: true; check: NovaPostConnectionCheck }
  | { ok: false; reason: "not_configured" };

/** Перевірка підключення Nova Post (лише читання). У демо або без ключа — not_configured. */
export async function runNovaPostConnectionCheck(
  ctx: ServiceContext,
  deps: { apiKey?: string; baseUrl?: string; fetch?: FetchLike } = {},
): Promise<ConnectionCheckOutcome> {
  requirePermission(ctx.actor, "settings.manage");
  const env = ctx.mode === "production" ? getEnv() : null;
  const apiKey = deps.apiKey ?? env?.NOVA_POSHTA_API_KEY;
  if (!apiKey) return { ok: false, reason: "not_configured" };
  const { values } = await loadSettings(ctx.db);
  const s = values.shipper;
  const check = await checkNovaPostConnection({
    apiKey,
    baseUrl: deps.baseUrl ?? env?.NOVA_POSHTA_API_BASE ?? NOVA_POST_ENDPOINTS.ua,
    fetch: deps.fetch,
    now: ctx.now,
    sender: {
      countryCode: s.countryCode,
      city: s.city,
      postalCode: s.postalCode,
      divisionNumber: s.carrierBranch,
      companyTin: s.taxId,
      companyName: s.companyName,
    },
    payerType: values.novaPost.payerType,
    payerContractNumber: values.novaPost.payerContractNumber,
  });
  logger.info("nova_post.connection_check", {
    authorized: check.authorized,
    calculations: check.calculations.map((c) => `${c.label}:${c.ok ? "ok" : (c.status ?? "error")}`).join(","),
    currencyFields: check.calculations.flatMap((c) => Object.keys(c.currencyFields)).join(","),
    shipmentsCurrencies: check.shipments.currencyCodes.join(","),
  });
  await writeAudit(ctx.db, ctx.actor, "nova_post.connection_check", { type: "carrier", id: NOVA_POST_CODE }, { authorized: check.authorized });
  return { ok: true, check };
}

/** Власник підтверджує валюту й договірні тарифи для поточних налаштувань Nova Post. */
export async function confirmNovaPostTariffs(ctx: ServiceContext, expectedVersion: number) {
  requirePermission(ctx.actor, "settings.manage");
  const { values } = await loadSettings(ctx.db);
  const np = values.novaPost;
  return updateSetting(
    ctx.db,
    ctx.actor,
    "novaPost",
    {
      ...np,
      tariffConfirmation: {
        confirmedAt: ctx.now().toISOString(),
        confirmedBy: ctx.actor.id,
        tariffCurrency: np.tariffCurrency,
        payerContractNumber: np.payerContractNumber,
        deliveryType: np.deliveryType,
      },
    },
    expectedVersion,
  );
}

export async function revokeNovaPostTariffs(ctx: ServiceContext, expectedVersion: number) {
  requirePermission(ctx.actor, "settings.manage");
  const { values } = await loadSettings(ctx.db);
  return updateSetting(ctx.db, ctx.actor, "novaPost", { ...values.novaPost, tariffConfirmation: null }, expectedVersion);
}

export type CheckoutReadiness = { ready: true } | { ready: false; reason: "tariff_not_fixed" | "tariff_not_confirmed" };

/**
 * Чи можна використовувати вартість перевізника в Checkout. Для Nova Post (рішення власника, варіант B):
 * обраний один тариф і дійсне підтвердження валюти/договірних тарифів.
 */
export function checkoutReadiness(carrierCode: string | null | undefined, settings: Pick<AllSettings, "novaPost">): CheckoutReadiness {
  if (carrierCode !== NOVA_POST_CODE) return { ready: true };
  if (!settings.novaPost.deliveryType) return { ready: false, reason: "tariff_not_fixed" };
  if (!isTariffConfirmed(settings.novaPost)) return { ready: false, reason: "tariff_not_confirmed" };
  return { ready: true };
}
