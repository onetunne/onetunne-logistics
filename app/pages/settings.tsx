import {
  checkoutReadiness,
  confirmNovaPostTariffs,
  revokeNovaPostTariffs,
  runNovaPostConnectionCheck,
} from "~/modules/rates/nova-post-setup.server";
import type { NovaPostConnectionCheck } from "~/integrations/carriers/nova-post/connection-check.server";
import { isTariffConfirmed, WAREHOUSE_EXTERNAL_CHANGE_MODES, WAREHOUSE_SHOPIFY_PUSH_MODES } from "~/modules/settings/schema";
import { Suspense, useRef, useState, type ReactNode } from "react";
import type { ZodType } from "zod";
import {
  Await,
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import { ActionBanner, type ActionResult } from "~/components/action-banner";
import { TestBadge } from "~/components/status-badge";
import { resetDemoData } from "~/db/seed/seed.server";
import { can, requirePermission } from "~/domain/permissions";
import { EXPORT_REASONS, INCOTERMS, type CarrierCapabilities } from "~/integrations/carriers/types";
import { NOVA_GLOBAL_CODE } from "~/integrations/carriers/nova-global";
import { NOVA_POST_ENDPOINTS } from "~/integrations/carriers/nova-post/client.server";
import { NOVA_POST_CODE, NOVA_POST_DELIVERY_TYPES } from "~/integrations/carriers/nova-post/mapping";
import { hasKey, useLocale, useT, type TFunction } from "~/i18n";
import { getEnv } from "~/lib/env.server";
import { formatDate, formatMoney, formatWeight } from "~/lib/format";
import { logger } from "~/lib/logger.server";
import {
  DEFAULT_CARRIER_SERVICE_NAME,
  disableCarrierService,
  enableCarrierService,
  getCarrierServiceStatus,
  type CarrierServiceUnavailable,
} from "~/modules/rates/carrier-service.server";
import { previewCheckoutRates, type CheckoutRatesPreview } from "~/modules/rates/checkout-rates.server";
import {
  AUTOMATION_MODES,
  checkoutRatesSchema,
  customsSchema,
  NOVA_POST_PAYER_TYPES,
  novaPostSchema,
  REQUIRED_SHIPPER_FIELDS,
  ROUNDING_MODES,
  shipperSchema,
  TEST_CARRIER_SIMULATIONS,
  type SettingsKey,
  type SettingsValue,
} from "~/modules/settings/schema";
import { loadSettings, updateSetting, type UpdateSettingResult } from "~/modules/settings/settings.server";
import { saveWarehouseSettings } from "~/modules/warehouse/settings.server";
import { currentShop } from "~/modules/shopify-sync/sync.server";
import { getRequestContext } from "~/server/context.server";
import { formString, toActionError } from "~/server/http.server";
import type { RequestContext } from "~/server/types";
import {
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  ConfirmSubmitButton,
  DataTable,
  Divider,
  FormLayout,
  Grid,
  InlineCode,
  KeyValueList,
  Page,
  Select,
  Stack,
  Text,
  TextField,
  type TextFieldType,
} from "~/ui";

/**
 * Налаштування (лише власник за замовчуванням — дозвіл settings.view).
 * Кожен розділ — окрема форма з оптимістичним блокуванням (expectedVersion = версія з loader).
 * Права перевіряються ще й у сервісі updateSetting; інтерфейс лише приховує недоступні дії.
 */

type Shipper = SettingsValue<"shipper">;
type ShipperField = keyof Shipper;
type Package = SettingsValue<"packaging">["packages"][number];
type FxRate = SettingsValue<"checkoutRates">["fxRates"][number];

const INTENTS = [
  "saveAutomation",
  "saveShipper",
  "saveCustoms",
  "savePackaging",
  "saveNovaPost",
  "saveCheckoutRates",
  "checkNovaPost",
  "confirmTariffs",
  "revokeTariffs",
  "previewRates",
  "enableCheckout",
  "disableCheckout",
  "saveTracking",
  "saveWarehouse",
  "saveTestCarrier",
  "resetDemo",
] as const;
type Intent = (typeof INTENTS)[number];

/** Максимум рядків у таблиці курсів (як у checkoutRatesSchema). */
const MAX_FX_RATES = 20;
const INVOICE_TYPES = customsSchema.shape.invoiceType.options;
const REGISTRATION_ADDRESS_MODES = customsSchema.shape.recipientRegistrationAddress.unwrap().options;
/**
 * Скільки чекаємо на стан CarrierService із Shopify. Стан завантажується окремо від сторінки (React Router
 * передає його потоком), тож повільна відповідь Shopify не затримує налаштування; ліміт — менший за
 * streamTimeout (5 с) в entry.server, щоб замість обірваного потоку показати зрозумілий стан «помилка».
 */
const CHECKOUT_STATUS_TIMEOUT_MS = 4000;
/** Скільки рядків курсів повертається формі після помилки (для показу без JavaScript). */
const MAX_ECHOED_FX_ROWS = 50;

/** Результат тестового розрахунку для сторінки (те саме, що бачить Shopify, плюс пояснення). */
export type CheckoutPreviewView = Pick<CheckoutRatesPreview, "enabled" | "carrier" | "parcel" | "reason" | "errorKind" | "quotes"> & {
  rateCount: number;
};

/** Рядок таблиці курсів так, як його ввели (для показу помилок у тих самих рядках після перевірки). */
export interface SubmittedFxRow {
  currency: string;
  rate: string;
}

/** Результат дії з позначкою форми, якій він належить (банер показується лише в ній). */
export type SettingsActionResult = ActionResult & { intent: string; preview?: CheckoutPreviewView; fxRows?: SubmittedFxRow[] };

type CapabilityFlags = Pick<CarrierCapabilities, "rates" | "documents" | "tracking" | "createShipment" | "cancelShipment">;

/** Стан підключення до Checkout (CarrierService) для сторінки. Жодних адрес callback і токенів. */
export type CheckoutConnectionState =
  | { kind: "demo" }
  | { kind: "ownerOnly" }
  | { kind: "unavailable"; reason: CarrierServiceUnavailable["reason"]; scope: string | null; shop: string | null }
  | { kind: "error"; shop: string | null }
  | {
      kind: "status";
      registered: boolean;
      active: boolean;
      callbackUrlCurrent: boolean;
      shop: string | null;
      /** Доставка за ринками (market-driven shipping); null — невідомо. */
      marketDrivenShipping: boolean | null;
    };

// ---------------------------------------------------------------- loader

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  try {
    requirePermission(ctx.actor, "settings.view");
  } catch {
    throw new Response("Forbidden", { status: 403 });
  }
  // Етап 6 (docs/stage6-design.md §5.2, §14.3 п. 2): фіксований перелік розділів нижче НІКОЛИ не містить ключа finance —
  // settings.view делегується працівникам; фінансові налаштування — лише /finance/settings (власник). Тест:
  // tests/stage6/core/settings-routes.test.ts.
  const { values, versions } = await loadSettings(ctx.db);
  const isDemo = ctx.mode === "demo";
  const defaultCarrierCode = ctx.carriers.getDefault()?.code ?? null;
  const canManage = can(ctx.actor, "settings.manage");
  const novaPostAdapter = ctx.carriers.get(NOVA_POST_CODE);
  // Розділ Nova Post: завжди в робочій версії; у демо — лише якщо такий перевізник зареєстрований.
  const showNovaPost = ctx.mode === "production" || novaPostAdapter !== undefined;

  return {
    mode: ctx.mode,
    can: {
      automation: can(ctx.actor, "automation.manage"),
      manage: canManage,
      demoReset: isDemo && can(ctx.actor, "demo.reset"),
    },
    options: {
      modes: [...AUTOMATION_MODES],
      simulations: [...TEST_CARRIER_SIMULATIONS],
      requiredShipperFields: [...REQUIRED_SHIPPER_FIELDS] as ShipperField[],
      incoterms: [...INCOTERMS],
      exportReasons: [...EXPORT_REASONS],
      invoiceTypes: [...INVOICE_TYPES],
      registrationAddressModes: [...REGISTRATION_ADDRESS_MODES],
      payerTypes: [...NOVA_POST_PAYER_TYPES],
      // "" — автоматично (тариф визначає перевізник).
      deliveryTypes: ["", ...NOVA_POST_DELIVERY_TYPES],
      roundingModes: [...ROUNDING_MODES],
      maxFxRates: MAX_FX_RATES,
    },
    automation: { value: values.automation, version: versions.automation },
    shipper: {
      value: values.shipper,
      version: versions.shipper,
      missing: REQUIRED_SHIPPER_FIELDS.filter((f) => !String(values.shipper[f] ?? "").trim()) as ShipperField[],
    },
    customs: { value: values.customs, version: versions.customs },
    packaging: { value: values.packaging, version: versions.packaging },
    novaPost: showNovaPost
      ? {
          value: values.novaPost,
          version: versions.novaPost,
          registered: novaPostAdapter !== undefined,
          shipmentsEnabled: novaPostAdapter?.capabilities.createShipment === true,
        }
      : null,
    checkoutRates: {
      value: values.checkoutRates,
      version: versions.checkoutRates,
      /** Базова валюта таблиці курсів — валюта тарифів Nova Post (як у checkout-rates.server). */
      baseCurrency: values.novaPost.tariffCurrency,
      /** Чи можна використовувати вартість перевізника (Nova Post: один тариф + підтвердження валюти/тарифів). */
      readiness: checkoutReadiness(ctx.carriers.getDefault()?.code, values),
    },
    /** Значення одразу (демо, лише власник) або проміс — сторінка показує стан через <Await>, не чекаючи Shopify. */
    checkoutConnection: checkoutConnectionState(ctx, canManage),
    /** Назва сервісу розрахунку доставки в Shopify (для інструкції «додайте тариф у зону доставки»). */
    checkoutServiceName: DEFAULT_CARRIER_SERVICE_NAME,
    tracking: { value: values.tracking, version: versions.tracking },
    warehouse: { value: values.warehouse, version: versions.warehouse },
    testCarrier: isDemo ? { value: values.testCarrier, version: versions.testCarrier } : null,
    integrations: {
      // Лише булеві ознаки та публічні назви — жодних значень змінних середовища.
      shopifyConnected: ctx.mode === "production",
      carriers: ctx.carriers
        .list()
        .filter((c) => c.code !== NOVA_POST_CODE)
        .map((c) => ({
          code: c.code,
          displayName: c.displayName,
          mode: c.mode,
          isDefault: c.code === defaultCarrierCode,
          capabilities: { ...c.capabilities },
        })),
      novaGlobalRegistered: ctx.carriers.get(NOVA_GLOBAL_CODE) !== undefined,
      novaPost: novaPostIntegration(ctx, defaultCarrierCode),
    },
  };
}

/** Стан Nova Post для розділу «Інтеграції»: лише ознаки (ключ задано/ні) і хост API, без значень. */
function novaPostIntegration(ctx: RequestContext, defaultCarrierCode: string | null) {
  const adapter = ctx.carriers.get(NOVA_POST_CODE);
  let apiKeyConfigured: boolean | null = null;
  let apiHost: string | null = null;
  // У демо змінні середовища Nova Post не читаються: демо ніколи не звертається до перевізника.
  if (ctx.mode === "production") {
    const env = getEnv();
    apiKeyConfigured = Boolean(env.NOVA_POSHTA_API_KEY);
    apiHost = urlHost(env.NOVA_POSHTA_API_BASE ?? NOVA_POST_ENDPOINTS.ua);
  }
  const capabilities: CapabilityFlags | null = adapter
    ? {
        rates: adapter.capabilities.rates,
        documents: adapter.capabilities.documents,
        tracking: adapter.capabilities.tracking,
        createShipment: adapter.capabilities.createShipment,
        cancelShipment: adapter.capabilities.cancelShipment,
      }
    : null;
  return {
    registered: adapter !== undefined,
    isDefault: adapter !== undefined && adapter.code === defaultCarrierCode,
    apiKeyConfigured,
    apiHost,
    capabilities,
  };
}

function urlHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Стан підключення до Checkout. Демо й «лише власник» — одразу; інакше проміс, який завжди виконується успішно
 * (помилка або тайм-аут Shopify → kind "error"): сторінка не чекає на Admin API ні під час завантаження,
 * ні після кожного збереження розділу (повторне завантаження даних).
 */
function checkoutConnectionState(
  ctx: RequestContext,
  canManage: boolean,
): CheckoutConnectionState | Promise<CheckoutConnectionState> {
  if (ctx.mode !== "production") return { kind: "demo" };
  if (!canManage) return { kind: "ownerOnly" };
  let shop: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const status = (async (): Promise<CheckoutConnectionState> => {
    try {
      shop = (await currentShop(ctx.db))?.shop ?? null;
      const r = await getCarrierServiceStatus(ctx);
      if (!r.ok) return { kind: "unavailable", reason: r.reason, scope: r.reason === "missing_scope" ? r.scope : null, shop };
      const { registered, active, callbackUrlCurrent, marketDrivenShipping } = r.value;
      return { kind: "status", registered, active, callbackUrlCurrent, shop, marketDrivenShipping };
    } catch (error) {
      // Стан необов'язковий для сторінки: помилка Shopify не блокує налаштування.
      logger.warn("settings.carrier_service_status_failed", { error });
      return { kind: "error", shop };
    }
  })();
  const timeout = new Promise<CheckoutConnectionState>((resolve) => {
    timer = setTimeout(() => {
      logger.warn("settings.carrier_service_status_timeout", { timeoutMs: CHECKOUT_STATUS_TIMEOUT_MS });
      resolve({ kind: "error", shop });
    }, CHECKOUT_STATUS_TIMEOUT_MS);
  });
  return Promise.race([status, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------- action

export async function action({ request }: ActionFunctionArgs): Promise<SettingsActionResult> {
  const ctx = await getRequestContext(request);
  const form = await request.formData();
  const intent = formString(form, "intent");
  try {
    if (!isIntent(intent)) return { ok: false, error: "error.generic", intent };
    return { ...(await runIntent(ctx, intent, form)), intent };
  } catch (e) {
    return { ...toActionError(e), intent };
  }
}

function isIntent(value: string): value is Intent {
  return (INTENTS as readonly string[]).includes(value);
}

type IntentResult = ActionResult & {
  preview?: CheckoutPreviewView;
  fxRows?: SubmittedFxRow[];
  connectionCheck?: NovaPostConnectionCheck;
};

async function runIntent(ctx: RequestContext, intent: Intent, form: FormData): Promise<IntentResult> {
  switch (intent) {
    case "saveAutomation": {
      requirePermission(ctx.actor, "automation.manage");
      const version = expectedVersion(form);
      if (version === null) return { ok: false, error: "error.generic" };
      const input = { mode: formString(form, "mode"), globalPause: form.has("globalPause") };
      return saved(await updateSetting(ctx.db, ctx.actor, "automation", await withStored(ctx, "automation", input), version));
    }
    case "saveShipper": {
      requirePermission(ctx.actor, "settings.manage");
      const version = expectedVersion(form);
      if (version === null) return { ok: false, error: "error.generic" };
      const fields = Object.keys(shipperSchema.shape) as ShipperField[];
      const input = Object.fromEntries(fields.map((f) => [f, formString(form, f)]));
      return saved(await updateSetting(ctx.db, ctx.actor, "shipper", input, version));
    }
    case "saveCustoms": {
      requirePermission(ctx.actor, "settings.manage");
      const version = expectedVersion(form);
      if (version === null) return { ok: false, error: "error.generic" };
      // Усі поля розділу — списки вибору: поле, якого немає у формі (сторінка, відкрита до оновлення), зберігає
      // поточне значення, а не скидається до значення за замовчуванням.
      const input: Record<string, unknown> = presentFields(
        form,
        Object.keys(customsSchema.shape).filter((k) => k !== "recipientRegistrationAddressConfirmed"),
      );
      // Підтвердження (прапорець) надсилається лише формою з полем вибору адреси реєстрації.
      if (form.has("recipientRegistrationAddress")) {
        const confirmed = form.has("recipientRegistrationAddressConfirmed");
        if (input.recipientRegistrationAddress === "shipping" && !confirmed) {
          return invalid({ recipientRegistrationAddressConfirmed: "settings.customs.registrationConfirmRequired" });
        }
        input.recipientRegistrationAddressConfirmed = input.recipientRegistrationAddress === "shipping" && confirmed;
      }
      return saved(await updateSetting(ctx.db, ctx.actor, "customs", await withStored(ctx, "customs", input), version));
    }
    case "savePackaging": {
      requirePermission(ctx.actor, "settings.manage");
      const version = expectedVersion(form);
      if (version === null) return { ok: false, error: "error.generic" };
      // Перелік упаковок поки не редагується — беремо поточний; зміни між завантаженням і збереженням
      // відсікає перевірка версії.
      const { values } = await loadSettings(ctx.db);
      const divisor = formString(form, "volumetricDivisor").trim();
      const input = {
        ...values.packaging,
        defaultPackageCode: formString(form, "defaultPackageCode"),
        volumetricDivisor: divisor === "" ? Number.NaN : Number(divisor),
      };
      return saved(await updateSetting(ctx.db, ctx.actor, "packaging", input, version));
    }
    case "saveNovaPost": {
      requirePermission(ctx.actor, "settings.manage");
      const version = expectedVersion(form);
      if (version === null) return { ok: false, error: "error.generic" };
      const input = await withStored(ctx, "novaPost", {
        payerType: formString(form, "payerType"),
        payerContractNumber: formString(form, "payerContractNumber"),
        deliveryType: formString(form, "deliveryType"),
        tariffCurrency: formString(form, "tariffCurrency"),
      });
      const extra = novaPostFieldErrors(input);
      if (Object.keys(extra).length > 0) return invalid({ ...schemaFieldErrors(novaPostSchema, input), ...extra });
      return saved(await updateSetting(ctx.db, ctx.actor, "novaPost", input, version));
    }
    case "saveCheckoutRates": {
      requirePermission(ctx.actor, "settings.manage");
      const version = expectedVersion(form);
      if (version === null) return { ok: false, error: "error.generic" };
      const { values } = await loadSettings(ctx.db);
      const fx = parseFxRateRows(form, values.novaPost.tariffCurrency);
      const input = {
        ...values.checkoutRates,
        enabled: form.has("enabled"),
        markupPercent: decimalNumber(formString(form, "markupPercent")),
        markupFixed: decimalString(formString(form, "markupFixed")),
        rounding: formString(form, "rounding"),
        fxRates: fx.rows,
        serviceName: formString(form, "serviceName"),
      };
      // Після помилки форма показує рядки так, як їх ввели (і без JavaScript), — помилки в тих самих рядках.
      if (Object.keys(fx.errors).length > 0) {
        const errors = { ...remapFxErrors(schemaFieldErrors(checkoutRatesSchema, input), fx.index), ...fx.errors };
        return { ...invalid(errors), fxRows: fx.submitted };
      }
      // Nova Post (варіант B): увімкнути Checkout можна лише з одним тарифом і підтвердженими валютою/договірними тарифами.
      if (input.enabled) {
        const readiness = checkoutReadiness(ctx.carriers.getDefault()?.code, values);
        if (!readiness.ready) return { ...invalid({ enabled: `settings.checkoutRates.notReady.${readiness.reason}` }), fxRows: fx.submitted };
      }
      const result = await updateSetting(ctx.db, ctx.actor, "checkoutRates", input, version);
      return result.ok ? saved(result) : { ...invalid(remapFxErrors(result.fieldErrors, fx.index)), fxRows: fx.submitted };
    }
    case "checkNovaPost": {
      const outcome = await runNovaPostConnectionCheck(ctx);
      if (!outcome.ok) return { ok: false, error: "settings.novaPost.check.notConfigured" };
      return {
        ok: outcome.check.authorized,
        ...(outcome.check.authorized ? { message: "settings.novaPost.check.done" } : { error: "settings.novaPost.check.authFailed" }),
        connectionCheck: outcome.check,
      } as IntentResult;
    }
    case "confirmTariffs":
    case "revokeTariffs": {
      const version = expectedVersion(form);
      if (version === null) return { ok: false, error: "error.generic" };
      const fn = intent === "confirmTariffs" ? confirmNovaPostTariffs : revokeNovaPostTariffs;
      const result = await fn(ctx, version);
      return result.ok
        ? { ok: true, message: intent === "confirmTariffs" ? "settings.novaPost.tariff.confirmedOk" : "settings.novaPost.tariff.revokedOk" }
        : invalid(result.fieldErrors);
    }
    case "previewRates": {
      requirePermission(ctx.actor, "settings.manage");
      const preview = await previewCheckoutRates(ctx, {
        countryCode: formString(form, "countryCode"),
        postalCode: formString(form, "postalCode"),
        city: formString(form, "city"),
        province: formString(form, "province"),
        weightGrams: integerNumber(formString(form, "weightGrams")),
        value: decimalString(formString(form, "value")),
        currency: formString(form, "currency"),
      });
      return {
        ok: true,
        message: "settings.checkoutRates.preview.ok",
        params: { count: preview.rates.length },
        preview: {
          enabled: preview.enabled,
          carrier: preview.carrier,
          parcel: preview.parcel,
          reason: preview.reason,
          errorKind: preview.errorKind,
          quotes: preview.quotes,
          rateCount: preview.rates.length,
        },
      };
    }
    case "enableCheckout": {
      requirePermission(ctx.actor, "settings.manage");
      const r = await enableCarrierService(ctx);
      if (!r.ok) return connectionUnavailable(r);
      return {
        ok: true,
        message: `settings.checkoutConnection.enable.${r.value.result}`,
        tone: r.value.result === "unchanged" ? "info" : "success",
      };
    }
    case "disableCheckout": {
      requirePermission(ctx.actor, "settings.manage");
      const r = await disableCarrierService(ctx);
      if (!r.ok) return connectionUnavailable(r);
      return {
        ok: true,
        message: `settings.checkoutConnection.disable.${r.value.result}`,
        tone: r.value.result === "deactivated" || r.value.result === "deleted" ? "success" : "info",
      };
    }
    case "saveTracking": {
      requirePermission(ctx.actor, "settings.manage");
      const version = expectedVersion(form);
      if (version === null) return { ok: false, error: "error.generic" };
      const input = {
        enabled: form.has("enabled"),
        intervalMinutes: integerNumber(formString(form, "intervalMinutes")),
        pushToShopify: form.has("pushToShopify"),
        notifyCustomer: form.has("notifyCustomer"),
        trackingUrlTemplate: formString(form, "trackingUrlTemplate"),
      };
      return saved(await updateSetting(ctx.db, ctx.actor, "tracking", await withStored(ctx, "tracking", input), version));
    }
    case "saveWarehouse": {
      requirePermission(ctx.actor, "settings.manage");
      const version = expectedVersion(form);
      if (version === null) return { ok: false, error: "error.generic" };
      const input = {
        lowStockThreshold: integerNumber(formString(form, "lowStockThreshold")),
        productionLeadDays: integerNumber(formString(form, "productionLeadDays")),
        targetCoverDays: integerNumber(formString(form, "targetCoverDays")),
        batchRounding: integerNumber(formString(form, "batchRounding")),
        ...presentFields(form, ["shopifyPush", "externalShopifyChanges"]),
        allowNegativeOnHand: form.has("allowNegativeOnHand"),
      };
      const { result, alerts } = await saveWarehouseSettings(ctx, input, version);
      if (!result.ok) return invalid(result.fieldErrors);
      return alerts
        ? { ok: true, message: "settings.warehouse.savedWithAlerts", params: { opened: alerts.opened, resolved: alerts.resolved } }
        : { ok: true, message: "result.settings.saved" };
    }
    case "saveTestCarrier": {
      if (ctx.mode !== "demo") throw new Response("Not Found", { status: 404 });
      requirePermission(ctx.actor, "settings.manage");
      const version = expectedVersion(form);
      if (version === null) return { ok: false, error: "error.generic" };
      const input = { simulation: formString(form, "simulation") };
      return saved(await updateSetting(ctx.db, ctx.actor, "testCarrier", await withStored(ctx, "testCarrier", input), version));
    }
    case "resetDemo": {
      if (ctx.mode !== "demo") throw new Response("Not Found", { status: 404 });
      requirePermission(ctx.actor, "demo.reset");
      await resetDemoData(ctx);
      return { ok: true, message: "result.demo.reset" };
    }
  }
}

/** Версія, яку бачив користувач (для оптимістичного блокування). null — форма пошкоджена. */
function expectedVersion(form: FormData): number | null {
  const raw = formString(form, "expectedVersion");
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

/**
 * Значення форми поверх збереженого значення розділу. Сторінка надсилає лише поля, які показує; поле схеми,
 * якого форма не знає (напр. нове поле з .default()), зберігає поточне значення, а не скидається до
 * значення за замовчуванням. Конкурентні зміни відсікає перевірка версії в updateSetting.
 */
async function withStored<K extends SettingsKey>(
  ctx: RequestContext,
  key: K,
  input: Record<string, unknown>,
): Promise<SettingsValue<K> & Record<string, unknown>> {
  const { values } = await loadSettings(ctx.db);
  return { ...values[key], ...input };
}

/** Лише ті поля, які є у формі (для розділів, де всі поля — списки вибору). */
function presentFields(form: FormData, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.filter((n) => form.has(n)).map((n) => [n, formString(form, n)]));
}

function saved<K extends SettingsKey>(result: UpdateSettingResult<K>): ActionResult {
  return result.ok ? { ok: true, message: "result.settings.saved" } : invalid(result.fieldErrors);
}

function invalid(fieldErrors: Record<string, string>): ActionResult {
  return { ok: false, error: "error.validation", fieldErrors };
}

function connectionUnavailable(r: CarrierServiceUnavailable): ActionResult {
  return {
    ok: false,
    error: `settings.checkoutConnection.reason.${r.reason}`,
    params: r.reason === "missing_scope" ? { scope: r.scope } : undefined,
  };
}

/** Помилки zod за полями (як у updateSetting) — коли збереження зупиняє перевірка сторінки. */
function schemaFieldErrors(schema: ZodType, input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const parsed = schema.safeParse(input);
  if (parsed.success) return out;
  for (const issue of parsed.error.issues) out[issue.path.map(String).join(".") || "_"] ??= issue.message;
  return out;
}

/**
 * Додаткові правила Nova Post, яких немає в схемі: договір обов'язковий для ThirdPerson; довжина договору 2–20
 * (обмеження API у mapping.ts — інакше накладну відхилить уже перевізник).
 */
function novaPostFieldErrors(input: { payerType: string; payerContractNumber: string }): Record<string, string> {
  const errors: Record<string, string> = {};
  const contract = input.payerContractNumber.trim();
  if (input.payerType === "ThirdPerson" && contract === "") errors.payerContractNumber = "required";
  else if (contract !== "" && (contract.length < 2 || contract.length > 20)) errors.payerContractNumber = "length";
  return errors;
}

/** Десятковий рядок: кома як роздільник теж приймається (45,50 → 45.50). */
function decimalString(raw: string): string {
  return raw.trim().replace(",", ".");
}

/** Число з десятковою частиною; некоректний ввід → NaN (схема поверне помилку поля). */
function decimalNumber(raw: string): number {
  const v = decimalString(raw);
  return /^\d{1,6}(\.\d{1,4})?$/.test(v) ? Number(v) : Number.NaN;
}

function integerNumber(raw: string): number {
  const v = raw.trim();
  return /^\d{1,9}$/.test(v) ? Number(v) : Number.NaN;
}

interface ParsedFxRates {
  rows: FxRate[];
  /** Усі рядки форми так, як їх ввели (з порожніми), — для показу після помилки. */
  submitted: SubmittedFxRow[];
  /** Індекс рядка у формі для кожного збереженого рядка (порожні рядки пропускаються). */
  index: number[];
  /** Помилки сторінки за шляхом fxRates.{рядок форми}.{поле}: duplicate | base | zero. */
  errors: Record<string, string>;
}

/**
 * Таблиця курсів із форми: пари полів fxCurrency/fxRate (у порядку рядків). Повністю порожні рядки пропускаються,
 * код валюти — у верхньому регістрі, кома в курсі → крапка. Дублікати, валюта тарифів і нульовий курс — помилки рядка.
 */
function parseFxRateRows(form: FormData, baseCurrency: string): ParsedFxRates {
  const text = (v: FormDataEntryValue | undefined) => (typeof v === "string" ? v : "");
  const currencies = form.getAll("fxCurrency");
  const rates = form.getAll("fxRate");
  const rows: FxRate[] = [];
  const submitted: SubmittedFxRow[] = [];
  const index: number[] = [];
  const errors: Record<string, string> = {};
  const seen = new Set<string>();
  const base = baseCurrency.trim().toUpperCase();
  const count = Math.max(currencies.length, rates.length);
  for (let i = 0; i < count; i++) {
    if (i < MAX_ECHOED_FX_ROWS) submitted.push({ currency: text(currencies[i]).slice(0, 20), rate: text(rates[i]).slice(0, 20) });
    const currency = text(currencies[i]).trim().toUpperCase();
    const rate = decimalString(text(rates[i]));
    if (currency === "" && rate === "") continue;
    if (currency !== "" && seen.has(currency)) errors[`fxRates.${i}.currency`] = "duplicate";
    else if (currency !== "" && currency === base) errors[`fxRates.${i}.currency`] = "base";
    if (currency !== "") seen.add(currency);
    if (/^0+(\.0+)?$/.test(rate)) errors[`fxRates.${i}.rate`] = "zero";
    rows.push({ currency, rate });
    index.push(i);
  }
  return { rows, submitted, index, errors };
}

/** Шляхи помилок схеми fxRates.{n}.* (n — індекс у збереженому масиві) → індекс рядка у формі. */
function remapFxErrors(errors: Record<string, string>, index: number[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, message] of Object.entries(errors)) {
    const m = /^fxRates\.(\d+)(\..+)?$/.exec(path);
    const formRow = m ? index[Number(m[1])] : undefined;
    out[m && formRow !== undefined ? `fxRates.${formRow}${m[2] ?? ""}` : path] = message;
  }
  return out;
}

// ---------------------------------------------------------------- page

type LoaderData = Awaited<ReturnType<typeof loader>>;
type CarrierInfo = LoaderData["integrations"]["carriers"][number];
type FieldErrorFn = (name: string) => string | null;

/**
 * Повідомлення сервера (zod) не показуємо як є — перекладаємо за назвою поля.
 * Ключ «поле:код» — для помилок сторінки з конкретною причиною (напр. payerContractNumber:required).
 */
const FIELD_ERROR_KEYS: Readonly<Record<string, string>> = {
  email: "settings.error.email",
  countryCode: "settings.error.countryCode",
  defaultPackageCode: "settings.error.defaultPackage",
  volumetricDivisor: "settings.error.volumetricDivisor",
  taxId: "settings.error.taxId",
  eori: "settings.error.eori",
  ioss: "settings.error.ioss",
  payerContractNumber: "settings.novaPost.error.contractLength",
  "payerContractNumber:required": "settings.novaPost.error.contractRequired",
  "payerContractNumber:length": "settings.novaPost.error.contractLength",
  deliveryType: "settings.novaPost.error.deliveryType",
  tariffCurrency: "settings.error.currency",
  currency: "settings.error.currency",
  markupPercent: "settings.checkoutRates.error.markupPercent",
  markupFixed: "settings.checkoutRates.error.markupFixed",
  weightGrams: "settings.checkoutRates.error.weight",
  value: "settings.checkoutRates.error.value",
  intervalMinutes: "settings.tracking.error.interval",
  lowStockThreshold: "settings.warehouse.error.lowStockThreshold",
  productionLeadDays: "settings.warehouse.error.productionLeadDays",
  targetCoverDays: "settings.warehouse.error.targetCoverDays",
  batchRounding: "settings.warehouse.error.batchRounding",
  trackingUrlTemplate: "settings.tracking.error.template",
  recipientRegistrationAddressConfirmed: "settings.customs.registrationConfirmRequired",
  "enabled:settings.checkoutRates.notReady.tariff_not_fixed": "settings.checkoutRates.notReady.tariff_not_fixed",
  "enabled:settings.checkoutRates.notReady.tariff_not_confirmed": "settings.checkoutRates.notReady.tariff_not_confirmed",
};

interface ShipperFieldConfig {
  type?: TextFieldType;
  autoComplete: string;
  maxLength: number;
  help?: string;
  autoCapitalize?: string;
  inputMode?: "numeric" | "text";
  /** На всю ширину у двоколонковій розкладці. */
  full?: boolean;
  /** Митні реквізити — окремий підрозділ. */
  customs?: boolean;
}

/** Порядок і параметри полів відправника (maxLength — як у shipperSchema). */
const SHIPPER_FIELDS: Record<ShipperField, ShipperFieldConfig> = {
  companyName: { autoComplete: "organization", maxLength: 120 },
  contactName: { autoComplete: "name", maxLength: 120 },
  phone: { type: "tel", autoComplete: "tel", maxLength: 32, help: "settings.shipper.help.phone" },
  email: { type: "email", autoComplete: "email", maxLength: 160 },
  countryCode: {
    autoComplete: "country",
    maxLength: 2,
    help: "settings.shipper.help.countryCode",
    autoCapitalize: "characters",
  },
  city: { autoComplete: "address-level2", maxLength: 120 },
  postalCode: { autoComplete: "postal-code", maxLength: 20 },
  address1: { autoComplete: "address-line1", maxLength: 200, full: true },
  address2: { autoComplete: "address-line2", maxLength: 200, full: true },
  warehouseName: { autoComplete: "off", maxLength: 120 },
  carrierBranch: { autoComplete: "off", maxLength: 120, help: "settings.shipper.help.carrierBranch" },
  taxId: { autoComplete: "off", maxLength: 10, inputMode: "numeric", help: "settings.shipper.help.taxId", customs: true },
  eori: { autoComplete: "off", maxLength: 17, autoCapitalize: "characters", help: "settings.shipper.help.eori", customs: true },
  ioss: { autoComplete: "off", maxLength: 12, autoCapitalize: "characters", help: "settings.shipper.help.ioss", customs: true },
};
const SHIPPER_FIELD_ORDER = Object.keys(SHIPPER_FIELDS) as ShipperField[];

const CAPABILITY_KEYS = [
  "createShipment",
  "cancelShipment",
  "findByReference",
  "updateShipment",
  "rates",
  "availability",
  "documents",
  "tracking",
  "returns",
] as const satisfies readonly (keyof CarrierCapabilities)[];

/** Можливості Nova Post у розділі «Інтеграції» (розрахунок, документи, відстеження, створення, скасування). */
const NOVA_POST_CAPABILITY_KEYS = ["rates", "documents", "tracking", "createShipment", "cancelShipment"] as const satisfies readonly (keyof CapabilityFlags)[];

export default function SettingsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const t = useT();
  const navigation = useNavigation();
  const pendingIntent = navigation.state !== "idle" ? navigation.formData?.get("intent") : null;

  /** Результат дії лише для форми з цим intent. */
  const resultFor = (intent: Intent): SettingsActionResult | undefined =>
    actionData?.intent === intent ? actionData : undefined;
  const sectionProps = (intent: Intent) => {
    const result = resultFor(intent);
    return { result, pending: pendingIntent === intent, fieldError: fieldErrorFn(t, result) };
  };

  return (
    <Page
      title={t("nav.settings")}
      subtitle={t("settings.subtitle")}
      titleMeta={data.mode === "demo" ? <Badge tone="outline">{t("common.demo")}</Badge> : undefined}
    >
      <Stack gap={5}>
        <AutomationSection data={data} {...sectionProps("saveAutomation")} />
        <ShipperSection data={data} {...sectionProps("saveShipper")} />
        <CustomsSection data={data} {...sectionProps("saveCustoms")} />
        <PackagingSection data={data} {...sectionProps("savePackaging")} />
        {data.novaPost ? <NovaPostSection data={data} {...sectionProps("saveNovaPost")} /> : null}
        {data.novaPost ? (
          <NovaPostCheckSection
            data={data}
            check={sectionProps("checkNovaPost")}
            confirm={sectionProps("confirmTariffs")}
            revoke={sectionProps("revokeTariffs")}
          />
        ) : null}
        <CheckoutRatesSection
          data={data}
          {...sectionProps("saveCheckoutRates")}
          preview={sectionProps("previewRates")}
          connection={{
            result: resultFor("enableCheckout") ?? resultFor("disableCheckout"),
            pendingEnable: pendingIntent === "enableCheckout",
            pendingDisable: pendingIntent === "disableCheckout",
          }}
        />
        <TrackingSection data={data} {...sectionProps("saveTracking")} />
        <WarehouseSection data={data} {...sectionProps("saveWarehouse")} />
        {data.testCarrier ? <TestCarrierSection data={data} {...sectionProps("saveTestCarrier")} /> : null}
        <IntegrationsSection data={data} />
        <Grid columns={{ xs: 1, lg: data.can.demoReset ? 2 : 1 }} gap={4}>
          <Card title={t("settings.personal.title")}>
            <Text>{t("settings.personal.body")}</Text>
          </Card>
          {data.can.demoReset ? (
            <DemoDataSection result={resultFor("resetDemo")} pending={pendingIntent === "resetDemo"} />
          ) : null}
        </Grid>
      </Stack>
    </Page>
  );
}

function fieldErrorFn(t: TFunction, result: SettingsActionResult | undefined): FieldErrorFn {
  const errors = result && !result.ok ? result.fieldErrors : undefined;
  return (name) => {
    const message = errors?.[name];
    if (!message) return null;
    return t(FIELD_ERROR_KEYS[`${name}:${message}`] ?? FIELD_ERROR_KEYS[name] ?? "settings.error.invalid");
  };
}

interface SectionProps {
  data: LoaderData;
  result: SettingsActionResult | undefined;
  pending: boolean;
  fieldError: FieldErrorFn;
}

/** Підвал форми: кнопка збереження (або примітка «лише власник») і номер версії. */
function SaveRow({ canSave, pending, version }: { canSave: boolean; pending: boolean; version: number }) {
  const t = useT();
  return (
    <Stack direction="horizontal" gap={3} align="center" justify="between">
      {canSave ? (
        <Button type="submit" variant="primary" loading={pending}>
          {t("common.save")}
        </Button>
      ) : (
        <Text variant="body-sm" tone="subdued">
          {t("settings.ownerOnly")}
        </Text>
      )}
      {version > 0 ? (
        <Text variant="caption" tone="subdued">
          {t("settings.version", { version })}
        </Text>
      ) : null}
    </Stack>
  );
}

function Hidden({ intent, version }: { intent: Intent; version: number }) {
  return (
    <>
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="expectedVersion" value={version} />
    </>
  );
}

// ---------------------------------------------------------------- 1. Автоматизація

function AutomationSection({ data, result, pending, fieldError }: SectionProps) {
  const t = useT();
  const { value, version } = data.automation;
  return (
    <Card title={t("settings.automation.title")} description={t("settings.automation.description")}>
      {/* key: після збереження форма перемальовується з новими значеннями з сервера */}
      <AutomationForm
        key={version}
        data={data}
        result={result}
        pending={pending}
        fieldError={fieldError}
        initialMode={value.mode}
      />
    </Card>
  );
}

function AutomationForm({ data, result, pending, fieldError, initialMode }: SectionProps & { initialMode: string }) {
  const t = useT();
  const { value, version } = data.automation;
  const editable = data.can.automation;
  const [mode, setMode] = useState(initialMode);
  return (
    <Form method="post">
      <Hidden intent="saveAutomation" version={version} />
      <Stack gap={4}>
        <ActionBanner data={result} />
        {value.globalPause ? <Banner tone="warning">{t("settings.automation.pausedBanner")}</Banner> : null}
        <FormLayout>
          <Select
            label={t("settings.automation.mode")}
            name="mode"
            value={mode}
            onChange={(e) => setMode(e.currentTarget.value)}
            options={data.options.modes.map((m) => ({ value: m, label: t(`settings.automation.mode.${m}`) }))}
            helpText={t(`settings.automation.modeHelp.${mode}`)}
            error={fieldError("mode")}
            disabled={!editable}
          />
          <Checkbox
            label={t("settings.automation.globalPause")}
            name="globalPause"
            defaultChecked={value.globalPause}
            helpText={t("settings.automation.globalPauseHelp")}
            error={fieldError("globalPause")}
            disabled={!editable}
          />
        </FormLayout>
        <Stack gap={2}>
          <Text as="h3" variant="heading-sm">
            {t("settings.automation.modesTitle")}
          </Text>
          <KeyValueList
            items={data.options.modes.map((m) => ({
              key: m,
              label: t(`settings.automation.mode.${m}`),
              value: t(`settings.automation.modeHelp.${m}`),
            }))}
          />
          <Text variant="body-sm" tone="subdued">
            {t("settings.automation.autoNote")}
          </Text>
        </Stack>
        <SaveRow canSave={editable} pending={pending} version={version} />
      </Stack>
    </Form>
  );
}

// ---------------------------------------------------------------- 2. Відправник

function ShipperSection({ data, result, pending, fieldError }: SectionProps) {
  const t = useT();
  const { value, version, missing } = data.shipper;
  const editable = data.can.manage;
  const required = new Set<ShipperField>(data.options.requiredShipperFields);
  const fieldLabel = (f: ShipperField) => t(`settings.shipper.field.${f}`);

  const renderField = (f: ShipperField) => {
    const cfg = SHIPPER_FIELDS[f];
    const help = [required.has(f) ? t("settings.shipper.requiredForWaybill") : null, cfg.help ? t(cfg.help) : null]
      .filter(Boolean)
      .join(" ");
    const field = (
      <TextField
        key={f}
        label={fieldLabel(f)}
        name={f}
        type={cfg.type}
        defaultValue={value[f]}
        autoComplete={cfg.autoComplete}
        autoCapitalize={cfg.autoCapitalize}
        inputMode={cfg.inputMode}
        maxLength={cfg.maxLength}
        helpText={help || undefined}
        error={fieldError(f)}
        disabled={!editable}
        spellCheck={false}
      />
    );
    return cfg.full ? (
      <div key={f} className="ot-form-layout__full">
        {field}
      </div>
    ) : (
      field
    );
  };

  return (
    <Card title={t("settings.shipper.title")} description={t("settings.shipper.description")}>
      <Form method="post" key={version}>
        <Hidden intent="saveShipper" version={version} />
        <Stack gap={4}>
          <ActionBanner data={result} />
          {missing.length > 0 ? (
            <Banner tone="warning" title={t("settings.shipper.missing.title")}>
              {t("settings.shipper.missing.body", { fields: missing.map(fieldLabel).join(", ") })}
            </Banner>
          ) : (
            <Text variant="body-sm" tone="success">
              {t("settings.shipper.complete")}
            </Text>
          )}
          <Text variant="body-sm" tone="subdued">
            {t("settings.shipper.requiredNote")}
          </Text>
          <FormLayout columns={2}>{SHIPPER_FIELD_ORDER.filter((f) => !SHIPPER_FIELDS[f].customs).map(renderField)}</FormLayout>
          <Stack gap={2}>
            <Text as="h3" variant="heading-sm">
              {t("settings.shipper.customsTitle")}
            </Text>
            <Text variant="body-sm" tone="subdued">
              {t("settings.shipper.customsNote")}
            </Text>
          </Stack>
          <FormLayout columns={2}>{SHIPPER_FIELD_ORDER.filter((f) => SHIPPER_FIELDS[f].customs).map(renderField)}</FormLayout>
          <SaveRow canSave={editable} pending={pending} version={version} />
        </Stack>
      </Form>
    </Card>
  );
}

// ---------------------------------------------------------------- 3. Митні документи

function CustomsSection({ data, result, pending, fieldError }: SectionProps) {
  const t = useT();
  const { value, version } = data.customs;
  const editable = data.can.manage;
  return (
    <Card title={t("settings.customs.title")} description={t("settings.customs.description")}>
      <Form method="post" key={version}>
        <Hidden intent="saveCustoms" version={version} />
        <Stack gap={4}>
          <ActionBanner data={result} />
          <FormLayout columns={2}>
            <div className="ot-form-layout__full">
              <Select
                label={t("settings.customs.incoterm")}
                name="incoterm"
                defaultValue={value.incoterm}
                options={data.options.incoterms.map((v) => ({ value: v, label: t(`settings.customs.incoterm.${v}`) }))}
                helpText={t("settings.customs.incotermHelp")}
                error={fieldError("incoterm")}
                disabled={!editable}
              />
            </div>
            <Select
              label={t("settings.customs.exportReason")}
              name="exportReason"
              defaultValue={value.exportReason}
              options={data.options.exportReasons.map((v) => ({ value: v, label: t(`settings.customs.exportReason.${v}`) }))}
              error={fieldError("exportReason")}
              disabled={!editable}
            />
            <Select
              label={t("settings.customs.invoiceType")}
              name="invoiceType"
              defaultValue={value.invoiceType}
              options={data.options.invoiceTypes.map((v) => ({ value: v, label: t(`settings.customs.invoiceType.${v}`) }))}
              error={fieldError("invoiceType")}
              disabled={!editable}
            />
            <div className="ot-form-layout__full">
              <Select
                label={t("settings.customs.registrationAddress")}
                name="recipientRegistrationAddress"
                defaultValue={value.recipientRegistrationAddress}
                options={data.options.registrationAddressModes.map((v) => ({
                  value: v,
                  label: t(`settings.customs.registrationAddress.${v}`),
                }))}
                helpText={t("settings.customs.registrationAddressHelp")}
                error={fieldError("recipientRegistrationAddress")}
                disabled={!editable}
              />
            </div>
            <div className="ot-form-layout__full">
              <Checkbox
                label={t("settings.customs.registrationConfirm")}
                name="recipientRegistrationAddressConfirmed"
                defaultChecked={value.recipientRegistrationAddressConfirmed}
                helpText={t("settings.customs.registrationConfirmHelp")}
                error={fieldError("recipientRegistrationAddressConfirmed")}
                disabled={!editable}
              />
            </div>
          </FormLayout>
          <Banner tone="info" title={t("settings.customs.hsTitle")}>
            {t("settings.customs.hsNote")}
          </Banner>
          <SaveRow canSave={editable} pending={pending} version={version} />
        </Stack>
      </Form>
    </Card>
  );
}

// ---------------------------------------------------------------- 4. Упаковка

function PackagingSection({ data, result, pending, fieldError }: SectionProps) {
  const t = useT();
  const locale = useLocale();
  const { value, version } = data.packaging;
  const editable = data.can.manage;
  const packagesError = result && !result.ok && Object.keys(result.fieldErrors ?? {}).some((k) => k.startsWith("packages"));

  return (
    <Card title={t("settings.packaging.title")} description={t("settings.packaging.description")}>
      <Form method="post" key={version}>
        <Hidden intent="savePackaging" version={version} />
        <Stack gap={4}>
          <ActionBanner data={result} />
          <FormLayout columns={2}>
            <Select
              label={t("settings.packaging.defaultPackage")}
              name="defaultPackageCode"
              defaultValue={value.defaultPackageCode}
              options={value.packages.map((p) => ({ value: p.code, label: p.name }))}
              helpText={t("settings.packaging.defaultPackageHelp")}
              error={fieldError("defaultPackageCode")}
              disabled={!editable}
            />
            <TextField
              label={t("settings.packaging.volumetricDivisor")}
              name="volumetricDivisor"
              type="number"
              inputMode="numeric"
              min={1000}
              max={10000}
              step={1}
              defaultValue={value.volumetricDivisor}
              suffix={t("settings.packaging.divisorUnit")}
              helpText={t("settings.packaging.volumetricDivisorHelp")}
              error={fieldError("volumetricDivisor")}
              disabled={!editable}
            />
          </FormLayout>
          {packagesError ? <Banner tone="critical">{t("settings.error.packages")}</Banner> : null}
          <Stack gap={2}>
            <Text as="h3" variant="heading-sm">
              {t("settings.packaging.packagesTitle")}
            </Text>
            <Text variant="body-sm" tone="subdued">
              {t("settings.packaging.packagesReadOnly")}
            </Text>
            <DataTable<Package>
              caption={t("settings.packaging.packagesTitle")}
              rows={value.packages}
              rowKey={(p) => p.code}
              columns={[
                {
                  key: "name",
                  header: t("settings.packaging.col.name"),
                  primary: true,
                  render: (p) => (
                    <Stack gap={2} direction="horizontal" align="center">
                      <span>{p.name}</span>
                      <InlineCode>{p.code}</InlineCode>
                      {p.code === value.defaultPackageCode ? (
                        <Badge tone="strong" size="sm">
                          {t("settings.packaging.isDefault")}
                        </Badge>
                      ) : null}
                    </Stack>
                  ),
                },
                {
                  key: "dimensions",
                  header: t("settings.packaging.col.dimensions"),
                  render: (p) =>
                    t("settings.packaging.dimensionsValue", { length: p.lengthCm, width: p.widthCm, height: p.heightCm }),
                },
                {
                  key: "tare",
                  header: t("settings.packaging.col.tare"),
                  align: "end",
                  render: (p) => formatWeight(p.tareWeightGrams, locale),
                },
              ]}
            />
          </Stack>
          <SaveRow canSave={editable} pending={pending} version={version} />
        </Stack>
      </Form>
    </Card>
  );
}

// ---------------------------------------------------------------- 5. Nova Post

function NovaPostSection({ data, result, pending, fieldError }: SectionProps) {
  const t = useT();
  if (!data.novaPost) return null;
  return (
    <Card title={t("settings.novaPost.title")} description={t("settings.novaPost.description")}>
      <NovaPostForm
        key={data.novaPost.version}
        data={data}
        result={result}
        pending={pending}
        fieldError={fieldError}
        initialPayer={data.novaPost.value.payerType}
      />
    </Card>
  );
}

function NovaPostForm({ data, result, pending, fieldError, initialPayer }: SectionProps & { initialPayer: string }) {
  const t = useT();
  const [payer, setPayer] = useState(initialPayer);
  if (!data.novaPost) return null;
  const { value, version, registered, shipmentsEnabled } = data.novaPost;
  const editable = data.can.manage;
  const deliveryLabel = (v: string) =>
    v === "" ? t("settings.novaPost.deliveryType.auto") : hasKey(`settings.novaPost.deliveryType.${v}`) ? t(`settings.novaPost.deliveryType.${v}`) : v;
  return (
    <Form method="post">
      <Hidden intent="saveNovaPost" version={version} />
      <Stack gap={4}>
        <ActionBanner data={result} />
        {!registered ? <Banner tone="warning">{t("settings.novaPost.notRegistered")}</Banner> : null}
        <FormLayout columns={2}>
          <Select
            label={t("settings.novaPost.payerType")}
            name="payerType"
            value={payer}
            onChange={(e) => setPayer(e.currentTarget.value)}
            options={data.options.payerTypes.map((v) => ({ value: v, label: t(`settings.novaPost.payerType.${v}`) }))}
            error={fieldError("payerType")}
            disabled={!editable}
          />
          <TextField
            label={t("settings.novaPost.payerContractNumber")}
            name="payerContractNumber"
            defaultValue={value.payerContractNumber}
            maxLength={20}
            autoComplete="off"
            spellCheck={false}
            required={payer === "ThirdPerson"}
            helpText={t("settings.novaPost.payerContractNumberHelp")}
            error={fieldError("payerContractNumber")}
            disabled={!editable}
          />
          <Select
            label={t("settings.novaPost.deliveryType")}
            name="deliveryType"
            defaultValue={value.deliveryType}
            options={data.options.deliveryTypes.map((v) => ({ value: v, label: deliveryLabel(v) }))}
            helpText={t("settings.novaPost.deliveryTypeHelp")}
            error={fieldError("deliveryType")}
            disabled={!editable}
          />
          <TextField
            label={t("settings.novaPost.tariffCurrency")}
            name="tariffCurrency"
            defaultValue={value.tariffCurrency}
            maxLength={3}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            helpText={t("settings.novaPost.tariffCurrencyHelp")}
            error={fieldError("tariffCurrency")}
            disabled={!editable}
          />
        </FormLayout>
        <Stack gap={2}>
          <Stack direction="horizontal" gap={2} align="center">
            <Text as="h3" variant="heading-sm">
              {t("settings.novaPost.creation.title")}
            </Text>
            <Badge tone={shipmentsEnabled ? "success" : "outline"}>
              {shipmentsEnabled ? t("settings.novaPost.creation.enabled") : t("settings.novaPost.creation.disabled")}
            </Badge>
          </Stack>
          <Text variant="body-sm" tone="subdued">
            {shipmentsEnabled ? t("settings.novaPost.creation.enabledHelp") : t("settings.novaPost.creation.disabledHelp")}
          </Text>
        </Stack>
        <SaveRow canSave={editable} pending={pending} version={version} />
      </Stack>
    </Form>
  );
}

// ---------------------------------------------------------------- 5a. Перевірка підключення й підтвердження тарифів

function NovaPostCheckSection({
  data,
  check,
  confirm,
  revoke,
}: {
  data: LoaderData;
  check: Pick<SectionProps, "result" | "pending">;
  confirm: Pick<SectionProps, "result" | "pending">;
  revoke: Pick<SectionProps, "result" | "pending">;
}) {
  const t = useT();
  if (!data.novaPost) return null;
  const { value, version } = data.novaPost;
  const editable = data.can.manage;
  const confirmed = isTariffConfirmed(value);
  const c = (check.result as { connectionCheck?: NovaPostConnectionCheck } | undefined)?.connectionCheck;
  const money = (v: number | null) => (v === null ? "—" : String(v));
  return (
    <Card title={t("settings.novaPost.check.title")} description={t("settings.novaPost.check.description")}>
      <Stack gap={4}>
        <ActionBanner data={check.result} />
        {editable ? (
          <Form method="post">
            <input type="hidden" name="intent" value="checkNovaPost" />
            <Button type="submit" loading={check.pending}>
              {t("settings.novaPost.check.run")}
            </Button>
          </Form>
        ) : (
          <Text tone="subdued">{t("settings.ownerOnly")}</Text>
        )}
        {c ? (
          <Stack gap={3}>
            <KeyValueList
              items={[
                { key: "host", label: t("settings.novaPost.check.host"), value: c.endpointHost },
                {
                  key: "auth",
                  label: t("settings.novaPost.check.auth"),
                  value: c.authorized ? t("settings.novaPost.check.ok") : `${t("settings.novaPost.check.failed")}: ${c.authError ?? "—"}`,
                },
                {
                  key: "shipments",
                  label: t("settings.novaPost.check.shipments"),
                  value: c.shipments.ok
                    ? t("settings.novaPost.check.shipmentsValue", {
                        total: c.shipments.total ?? "—",
                        currencies: c.shipments.currencyCodes.join(", ") || "—",
                      })
                    : `${t("settings.novaPost.check.failed")}: ${c.shipments.error ?? c.shipments.status ?? "—"}`,
                },
              ]}
            />
            {c.calculations.map((calc) => (
              <Stack gap={2} key={calc.label}>
                <Text as="h3" variant="heading-sm">
                  {t(`settings.novaPost.check.calc.${calc.label}`)}
                </Text>
                {calc.ok ? (
                  <>
                    <DataTable<CheckServiceRowView>
                      caption={t(`settings.novaPost.check.calc.${calc.label}`)}
                      rows={calc.services.map((r, i) => ({ ...r, key: String(i) }))}
                      rowKey={(r) => r.key}
                      columns={[
                        { key: "type", header: t("settings.novaPost.check.col.type"), primary: true, render: (r) => r.deliveryType ?? r.name ?? "—" },
                        { key: "price", header: t("settings.novaPost.check.col.price"), render: (r) => money(r.price) },
                        { key: "discount", header: t("settings.novaPost.check.col.discount"), render: (r) => money(r.discount) },
                        { key: "cost", header: t("settings.novaPost.check.col.cost"), render: (r) => money(r.cost) },
                      ]}
                    />
                    <Text variant="body-sm" tone="subdued">
                      {Object.keys(calc.currencyFields).length > 0
                        ? t("settings.novaPost.check.currencyFound", {
                            fields: Object.entries(calc.currencyFields)
                              .map(([k, v]) => `${k}=${v}`)
                              .join(", "),
                          })
                        : t("settings.novaPost.check.currencyMissing")}
                    </Text>
                  </>
                ) : (
                  <Banner tone="critical">{`HTTP ${calc.status ?? "—"}: ${calc.error ?? "—"}`}</Banner>
                )}
              </Stack>
            ))}
            <Text variant="body-sm" tone="subdued">
              {t("settings.novaPost.check.compareHelp")}
            </Text>
          </Stack>
        ) : null}

        <Stack gap={2}>
          <Stack direction="horizontal" gap={2} align="center">
            <Text as="h3" variant="heading-sm">
              {t("settings.novaPost.tariff.title")}
            </Text>
            <Badge tone={confirmed ? "success" : "outline"}>
              {confirmed ? t("settings.novaPost.tariff.confirmed") : t("settings.novaPost.tariff.notConfirmed")}
            </Badge>
          </Stack>
          <ActionBanner data={confirm.result ?? revoke.result} />
          <Text variant="body-sm" tone="subdued">
            {confirmed && value.tariffConfirmation
              ? t("settings.novaPost.tariff.confirmedDetails", {
                  currency: value.tariffConfirmation.tariffCurrency,
                  contract: value.tariffConfirmation.payerContractNumber || "—",
                  tariff: value.tariffConfirmation.deliveryType || "—",
                })
              : t("settings.novaPost.tariff.help")}
          </Text>
          {!value.deliveryType ? <Banner tone="warning">{t("settings.novaPost.tariff.fixFirst")}</Banner> : null}
          {editable ? (
            <Form method="post">
              <input type="hidden" name="intent" value={confirmed ? "revokeTariffs" : "confirmTariffs"} />
              <input type="hidden" name="expectedVersion" value={version} />
              {confirmed ? (
                <Button type="submit" loading={revoke.pending}>
                  {t("settings.novaPost.tariff.revoke")}
                </Button>
              ) : (
                <ConfirmSubmitButton
                  variant="primary"
                  disabled={!value.deliveryType}
                  loading={confirm.pending}
                  title={t("settings.novaPost.tariff.confirmTitle")}
                  message={t("settings.novaPost.tariff.confirmMessage", {
                    currency: value.tariffCurrency,
                    contract: value.payerContractNumber || "—",
                    tariff: value.deliveryType || "—",
                  })}
                  confirmLabel={t("settings.novaPost.tariff.confirm")}
                  cancelLabel={t("common.cancel")}
                >
                  {t("settings.novaPost.tariff.confirm")}
                </ConfirmSubmitButton>
              )}
            </Form>
          ) : null}
        </Stack>
      </Stack>
    </Card>
  );
}

type CheckServiceRowView = NovaPostConnectionCheck["calculations"][number]["services"][number] & { key: string };

// ---------------------------------------------------------------- 6. Розрахунок доставки в Checkout

interface CheckoutRatesSectionProps extends SectionProps {
  preview: { result: SettingsActionResult | undefined; pending: boolean; fieldError: FieldErrorFn };
  connection: { result: SettingsActionResult | undefined; pendingEnable: boolean; pendingDisable: boolean };
}

function CheckoutRatesSection({ data, result, pending, fieldError, preview, connection }: CheckoutRatesSectionProps) {
  const t = useT();
  return (
    <Card title={t("settings.checkoutRates.title")} description={t("settings.checkoutRates.description")}>
      <Stack gap={5}>
        <CheckoutRatesForm key={data.checkoutRates.version} data={data} result={result} pending={pending} fieldError={fieldError} />
        <Divider />
        <CheckoutPreview data={data} {...preview} />
        <Divider />
        <CheckoutConnection data={data} {...connection} />
      </Stack>
    </Card>
  );
}

function CheckoutRatesForm({ data, result, pending, fieldError }: SectionProps) {
  const t = useT();
  const { value, version, baseCurrency } = data.checkoutRates;
  const editable = data.can.manage;
  return (
    <Form method="post">
      <Hidden intent="saveCheckoutRates" version={version} />
      <Stack gap={4}>
        <ActionBanner data={result} />
        {value.enabled ? <Banner tone="info">{t("settings.checkoutRates.enabledBanner")}</Banner> : null}
        {!data.checkoutRates.readiness.ready ? (
          <Banner tone="warning">{t(`settings.checkoutRates.notReady.${data.checkoutRates.readiness.reason}`)}</Banner>
        ) : null}
        <Checkbox
          id="checkoutRates-enabled"
          label={t("settings.checkoutRates.enabled")}
          name="enabled"
          defaultChecked={value.enabled}
          helpText={t("settings.checkoutRates.enabledHelp")}
          error={fieldError("enabled")}
          disabled={!editable}
        />
        <FormLayout columns={2}>
          <TextField
            label={t("settings.checkoutRates.markupPercent")}
            name="markupPercent"
            inputMode="decimal"
            defaultValue={value.markupPercent}
            maxLength={11}
            suffix="%"
            helpText={t("settings.checkoutRates.markupPercentHelp")}
            error={fieldError("markupPercent")}
            disabled={!editable}
          />
          <TextField
            label={t("settings.checkoutRates.markupFixed")}
            name="markupFixed"
            inputMode="decimal"
            defaultValue={value.markupFixed}
            maxLength={10}
            suffix={baseCurrency}
            helpText={t("settings.checkoutRates.markupFixedHelp", { base: baseCurrency })}
            error={fieldError("markupFixed")}
            disabled={!editable}
          />
          <Select
            label={t("settings.checkoutRates.rounding")}
            name="rounding"
            defaultValue={value.rounding}
            options={data.options.roundingModes.map((v) => ({ value: v, label: t(`settings.checkoutRates.rounding.${v}`) }))}
            error={fieldError("rounding")}
            disabled={!editable}
          />
          <TextField
            label={t("settings.checkoutRates.serviceName")}
            name="serviceName"
            defaultValue={value.serviceName}
            maxLength={80}
            autoComplete="off"
            helpText={t("settings.checkoutRates.serviceNameHelp")}
            error={fieldError("serviceName")}
            disabled={!editable}
          />
        </FormLayout>
        <FxRatesEditor
          initial={value.fxRates}
          editable={editable}
          base={baseCurrency}
          max={data.options.maxFxRates}
          result={result}
        />
        <SaveRow canSave={editable} pending={pending} version={version} />
      </Stack>
    </Form>
  );
}

const FX_ERROR_KEYS: Readonly<Record<string, string>> = {
  "currency:duplicate": "settings.checkoutRates.error.fxDuplicate",
  "currency:base": "settings.checkoutRates.error.fxBase",
  currency: "settings.checkoutRates.error.fxCurrency",
  rate: "settings.checkoutRates.error.fxRate",
};

type FxField = "currency" | "rate";
type FxRow = SubmittedFxRow & { id: number };
/** Помилки рядків курсів за стабільним id рядка (не за позицією — рядки можна видаляти). */
type FxRowErrors = Record<number, Partial<Record<FxField, string>>>;

/** Помилки сервера fxRates.{рядок форми}.{поле} → за id рядків, які були у формі на момент надсилання. */
function fxErrorsByRowId(rows: readonly FxRow[], errors: Record<string, string>): FxRowErrors {
  const out: FxRowErrors = {};
  for (const [path, message] of Object.entries(errors)) {
    const m = /^fxRates\.(\d+)\.(currency|rate)$/.exec(path);
    const row = m ? rows[Number(m[1])] : undefined;
    if (!m || !row) continue;
    (out[row.id] ??= {})[m[2] as FxField] = message;
  }
  return out;
}

/**
 * Таблиця курсів: рядки «валюта + курс», додавання/видалення до max рядків. Порожні рядки не зберігаються.
 * Помилки з сервера прив'язуються до рядків у момент відповіді й далі рухаються разом із рядком: видалення
 * рядка вище не переносить помилку на іншу валюту; виправлене поле більше не позначається як помилкове.
 * Після помилки без JavaScript рядки беруться з відповіді (як їх ввели), а не зі збереженого значення.
 */
function FxRatesEditor({
  initial,
  editable,
  base,
  max,
  result,
}: {
  initial: FxRate[];
  editable: boolean;
  base: string;
  max: number;
  result: SettingsActionResult | undefined;
}) {
  const t = useT();
  const errors = result && !result.ok ? (result.fieldErrors ?? {}) : {};
  const nextId = useRef(0);
  const withId = (row: SubmittedFxRow): FxRow => ({ currency: row.currency, rate: row.rate, id: nextId.current++ });
  const [rows, setRows] = useState<FxRow[]>(() => {
    const source = result?.fxRows ?? initial;
    return (source.length > 0 ? source : [{ currency: "", rate: "" }]).map(withId);
  });
  const [rowErrors, setRowErrors] = useState<FxRowErrors>(() => fxErrorsByRowId(rows, errors));
  // Нова відповідь сервера (та сама форма, без перемонтування) — прив'язуємо її помилки до поточних рядків.
  const [seenResult, setSeenResult] = useState(result);
  if (result !== seenResult) {
    setSeenResult(result);
    setRowErrors(fxErrorsByRowId(rows, errors));
  }
  const rowError = (id: number, field: FxField) => {
    const message = rowErrors[id]?.[field];
    if (!message) return null;
    return t(FX_ERROR_KEYS[`${field}:${message}`] ?? FX_ERROR_KEYS[field] ?? "settings.error.invalid", { base });
  };
  const clearError = (id: number, field: FxField) => {
    if (!rowErrors[id]?.[field]) return;
    setRowErrors((all) => ({ ...all, [id]: { ...all[id], [field]: undefined } }));
  };
  const add = () => setRows((r) => (r.length >= max ? r : [...r, withId({ currency: "", rate: "" })]));
  const remove = (id: number) => {
    setRows((r) => {
      const left = r.filter((row) => row.id !== id);
      return left.length > 0 ? left : [withId({ currency: "", rate: "" })];
    });
    setRowErrors(({ [id]: _removed, ...rest }) => rest);
  };
  const tooMany = Object.keys(errors).includes("fxRates");

  return (
    <Stack gap={3}>
      <Stack gap={1}>
        <Text as="h3" variant="heading-sm">
          {t("settings.checkoutRates.fx.title")}
        </Text>
        <Text variant="body-sm" tone="subdued">
          {t("settings.checkoutRates.fx.help", { base })}
        </Text>
      </Stack>
      {tooMany ? <Banner tone="critical">{t("settings.checkoutRates.error.fxTooMany", { max })}</Banner> : null}
      {rows.map((row, i) => (
        <div key={row.id} role="group" aria-label={t("settings.checkoutRates.fx.rowLabel", { n: i + 1 })}>
          <Grid columns={{ xs: 1, md: editable ? 3 : 2 }} gap={3}>
            <TextField
              id={`fxCurrency-${row.id}`}
              label={t("settings.checkoutRates.fx.currency")}
              name="fxCurrency"
              defaultValue={row.currency}
              onChange={() => clearError(row.id, "currency")}
              maxLength={3}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="EUR"
              error={rowError(row.id, "currency")}
              disabled={!editable}
            />
            <TextField
              id={`fxRate-${row.id}`}
              label={t("settings.checkoutRates.fx.rate", { base })}
              name="fxRate"
              inputMode="decimal"
              defaultValue={row.rate}
              onChange={() => clearError(row.id, "rate")}
              maxLength={13}
              autoComplete="off"
              placeholder="45.50"
              error={rowError(row.id, "rate")}
              disabled={!editable}
            />
            {editable ? (
              <Stack justify="end">
                <Button onClick={() => remove(row.id)} aria-label={t("settings.checkoutRates.fx.removeLabel", { n: i + 1 })}>
                  {t("settings.checkoutRates.fx.remove")}
                </Button>
              </Stack>
            ) : null}
          </Grid>
        </div>
      ))}
      {editable ? (
        <Stack direction="horizontal" gap={3} align="center">
          <Button onClick={add} disabled={rows.length >= max}>
            {t("settings.checkoutRates.fx.add")}
          </Button>
          <Text variant="caption" tone="subdued">
            {t("settings.checkoutRates.fx.limit", { max })}
          </Text>
        </Stack>
      ) : null}
    </Stack>
  );
}

function CheckoutPreview({
  data,
  result,
  pending,
  fieldError,
}: {
  data: LoaderData;
  result: SettingsActionResult | undefined;
  pending: boolean;
  fieldError: FieldErrorFn;
}) {
  const t = useT();
  const preview = result?.ok ? result.preview : undefined;
  return (
    <Stack gap={3}>
      <Stack gap={1}>
        <Text as="h3" variant="heading-sm">
          {t("settings.checkoutRates.preview.title")}
        </Text>
        <Text variant="body-sm" tone="subdued">
          {t("settings.checkoutRates.preview.help")}
        </Text>
      </Stack>
      {!data.can.manage ? (
        <Text variant="body-sm" tone="subdued">
          {t("settings.ownerOnly")}
        </Text>
      ) : (
        <Form method="post">
          <input type="hidden" name="intent" value="previewRates" />
          <Stack gap={3}>
            {preview ? null : <ActionBanner data={result} />}
            <FormLayout columns={2}>
              <TextField
                id="preview-countryCode"
                label={t("settings.checkoutRates.preview.countryCode")}
                name="countryCode"
                defaultValue="DE"
                maxLength={2}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                required
                error={fieldError("countryCode")}
              />
              <TextField
                id="preview-postalCode"
                label={t("settings.checkoutRates.preview.postalCode")}
                name="postalCode"
                defaultValue="10115"
                maxLength={20}
                autoComplete="off"
                spellCheck={false}
                error={fieldError("postalCode")}
              />
              <TextField
                id="preview-city"
                label={t("settings.checkoutRates.preview.city")}
                name="city"
                defaultValue="Berlin"
                maxLength={120}
                autoComplete="off"
                error={fieldError("city")}
              />
              <TextField
                id="preview-province"
                label={t("settings.checkoutRates.preview.province")}
                name="province"
                maxLength={120}
                autoComplete="off"
                error={fieldError("province")}
              />
              <TextField
                id="preview-weightGrams"
                label={t("settings.checkoutRates.preview.weightGrams")}
                name="weightGrams"
                type="number"
                inputMode="numeric"
                min={1}
                max={1_000_000}
                step={1}
                defaultValue={500}
                suffix={t("settings.checkoutRates.preview.weightUnit")}
                required
                helpText={t("settings.checkoutRates.preview.weightHelp")}
                error={fieldError("weightGrams")}
              />
              <TextField
                id="preview-value"
                label={t("settings.checkoutRates.preview.value")}
                name="value"
                inputMode="decimal"
                defaultValue="50.00"
                maxLength={12}
                required
                error={fieldError("value")}
              />
              <TextField
                id="preview-currency"
                label={t("settings.checkoutRates.preview.currency")}
                name="currency"
                defaultValue="EUR"
                maxLength={3}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                required
                error={fieldError("currency")}
              />
            </FormLayout>
            <div>
              <Button type="submit" loading={pending}>
                {t("settings.checkoutRates.preview.button")}
              </Button>
            </div>
          </Stack>
        </Form>
      )}
      {preview ? <PreviewResult preview={preview} /> : null}
    </Stack>
  );
}

function PreviewResult({ preview }: { preview: CheckoutPreviewView }) {
  const t = useT();
  const locale = useLocale();
  const money = (m: { amount: string; currency: string } | null) => (m ? formatMoney(m.amount, m.currency, locale) : "—");
  const kind = preview.errorKind ? t(`settings.checkoutRates.errorKind.${preview.errorKind}`) : "—";
  const delivery = (q: CheckoutPreviewView["quotes"][number]) => {
    const parts: string[] = [];
    if (q.minDeliveryDays !== null && q.maxDeliveryDays !== null) {
      parts.push(
        q.minDeliveryDays === q.maxDeliveryDays
          ? t("settings.checkoutRates.preview.daysExact", { days: q.minDeliveryDays })
          : t("settings.checkoutRates.preview.days", { min: q.minDeliveryDays, max: q.maxDeliveryDays }),
      );
    } else if (q.maxDeliveryDays !== null || q.minDeliveryDays !== null) {
      parts.push(t("settings.checkoutRates.preview.daysExact", { days: q.maxDeliveryDays ?? q.minDeliveryDays }));
    }
    if (q.estimatedDeliveryDate) parts.push(t("settings.checkoutRates.preview.until", { date: formatDate(q.estimatedDeliveryDate, locale) }));
    return parts.join(" · ") || "—";
  };
  return (
    <Stack gap={3}>
      {preview.reason ? (
        <Banner tone="warning">{t(`settings.checkoutRates.reason.${preview.reason}`, { kind })}</Banner>
      ) : (
        <Banner tone="success">{t("settings.checkoutRates.preview.ok", { count: preview.rateCount })}</Banner>
      )}
      {!preview.enabled ? (
        <Text variant="body-sm" tone="subdued">
          {t("settings.checkoutRates.preview.disabledNote")}
        </Text>
      ) : null}
      {preview.carrier ? (
        <Text variant="body-sm">{t("settings.checkoutRates.preview.carrier", { carrier: preview.carrier.displayName })}</Text>
      ) : null}
      {preview.parcel ? (
        <Text variant="body-sm">
          {t("settings.checkoutRates.preview.parcel", {
            actual: formatWeight(preview.parcel.actualWeightGrams, locale),
            volumetric: formatWeight(preview.parcel.volumetricWeightGrams, locale),
            chargeable: formatWeight(preview.parcel.chargeableWeightGrams, locale),
          })}
        </Text>
      ) : null}
      <DataTable<CheckoutPreviewView["quotes"][number]>
        caption={t("settings.checkoutRates.preview.title")}
        rows={preview.quotes}
        rowKey={(q) => `${q.shopifyServiceCode}:${q.carrierPrice.amount}:${q.serviceName}`}
        columns={[
          {
            key: "service",
            header: t("settings.checkoutRates.preview.col.service"),
            primary: true,
            render: (q) => (
              <Stack gap={1}>
                <span>{q.serviceName || q.serviceCode}</span>
                <InlineCode>{q.shopifyServiceCode}</InlineCode>
              </Stack>
            ),
          },
          {
            key: "carrierPrice",
            header: t("settings.checkoutRates.preview.col.carrierPrice"),
            align: "end",
            render: (q) => money(q.carrierPrice),
          },
          {
            key: "converted",
            header: t("settings.checkoutRates.preview.col.converted"),
            align: "end",
            render: (q) => money(q.convertedPrice),
          },
          {
            key: "checkoutPrice",
            header: t("settings.checkoutRates.preview.col.checkoutPrice"),
            align: "end",
            render: (q) =>
              q.checkoutPrice ? (
                <strong>{money(q.checkoutPrice)}</strong>
              ) : (
                <Text as="span" variant="body-sm" tone="critical">
                  {t(`settings.checkoutRates.failure.${q.failure ?? "no_fx_rate"}`)}
                </Text>
              ),
          },
          {
            key: "delivery",
            header: t("settings.checkoutRates.preview.col.delivery"),
            render: delivery,
          },
        ]}
      />
    </Stack>
  );
}

function CheckoutConnection({
  data,
  result,
  pendingEnable,
  pendingDisable,
}: {
  data: LoaderData;
  result: SettingsActionResult | undefined;
  pendingEnable: boolean;
  pendingDisable: boolean;
}) {
  const t = useT();
  const status = (state: CheckoutConnectionState) => (
    <CheckoutConnectionStatus
      state={state}
      serviceName={data.checkoutServiceName}
      pendingEnable={pendingEnable}
      pendingDisable={pendingDisable}
    />
  );
  return (
    <Stack gap={3}>
      <Stack gap={1}>
        <Text as="h3" variant="heading-sm">
          {t("settings.checkoutConnection.title")}
        </Text>
        <Text variant="body-sm" tone="subdued">
          {t("settings.checkoutConnection.help")}
        </Text>
      </Stack>
      <ActionBanner data={result} />
      {/* Стан із Shopify надходить окремо від сторінки: поки його немає — «Перевіряємо…», решта сторінки вже працює. */}
      <Suspense
        fallback={
          <Text variant="body-sm" tone="subdued">
            {t("settings.checkoutConnection.loading")}
          </Text>
        }
      >
        <Await resolve={data.checkoutConnection} errorElement={status({ kind: "error", shop: null })}>
          {(state) => status(state)}
        </Await>
      </Suspense>
    </Stack>
  );
}

function CheckoutConnectionStatus({
  state,
  serviceName,
  pendingEnable,
  pendingDisable,
}: {
  state: CheckoutConnectionState;
  serviceName: string;
  pendingEnable: boolean;
  pendingDisable: boolean;
}) {
  const t = useT();
  if (state.kind === "demo") return <Banner tone="info">{t("settings.checkoutConnection.demo")}</Banner>;
  if (state.kind === "ownerOnly") {
    return (
      <Text variant="body-sm" tone="subdued">
        {t("settings.ownerOnly")}
      </Text>
    );
  }

  let badge: ReactNode = null;
  let text: string;
  if (state.kind === "unavailable") {
    text = t(`settings.checkoutConnection.reason.${state.reason}`, { scope: state.scope ?? "" });
  } else if (state.kind === "error") {
    text = t("settings.checkoutConnection.state.error");
  } else if (!state.registered) {
    badge = <Badge tone="outline">{t("settings.checkoutConnection.badge.notRegistered")}</Badge>;
    text = t("settings.checkoutConnection.state.notRegistered");
  } else if (!state.callbackUrlCurrent) {
    badge = <Badge tone="warning">{state.active ? t("settings.checkoutConnection.badge.active") : t("settings.checkoutConnection.badge.inactive")}</Badge>;
    text = t("settings.checkoutConnection.state.stale");
  } else if (state.active) {
    badge = <Badge tone="success">{t("settings.checkoutConnection.badge.active")}</Badge>;
    text = t("settings.checkoutConnection.state.active");
  } else {
    badge = <Badge tone="outline">{t("settings.checkoutConnection.badge.inactive")}</Badge>;
    text = t("settings.checkoutConnection.state.inactive");
  }
  const actionable = state.kind === "status" || state.kind === "error";
  const canDisable = state.kind === "error" || (state.kind === "status" && state.registered && state.active);
  // Де вмикати тариф застосунку: зона профілю доставки (звичайна доставка) або доставка ринку (market-driven).
  const marketDriven = state.kind === "status" ? state.marketDrivenShipping : null;
  const placement =
    marketDriven === true
      ? [t("settings.checkoutConnection.enable.market", { name: serviceName })]
      : marketDriven === false
        ? [t("settings.checkoutConnection.enable.zone", { name: serviceName })]
        : [t("settings.checkoutConnection.enable.zone", { name: serviceName }), t("settings.checkoutConnection.enable.marketMaybe", { name: serviceName })];

  return (
    <Stack gap={3}>
      {state.kind === "unavailable" ? <Banner tone="warning">{text}</Banner> : <Status badges={badge} text={text} />}
      {state.kind === "status" && state.registered && state.active ? (
        <Text variant="body-sm" tone="subdued">
          {placement.join(" ")}
        </Text>
      ) : null}
      {actionable ? (
        <Stack direction="horizontal" gap={3}>
          <Form method="post">
            <input type="hidden" name="intent" value="enableCheckout" />
            <ConfirmSubmitButton
              variant="primary"
              title={t("settings.checkoutConnection.enable.title")}
              message={
                <Stack gap={2}>
                  <Text>{t("settings.checkoutConnection.enable.shop", { shop: state.shop ?? "—" })}</Text>
                  <Text>{t("settings.checkoutConnection.enable.plan")}</Text>
                  {placement.map((line) => (
                    <Text key={line}>{line}</Text>
                  ))}
                  <Text>{t("settings.checkoutConnection.enable.toggle")}</Text>
                </Stack>
              }
              confirmLabel={t("settings.checkoutConnection.enable.confirm")}
              cancelLabel={t("common.cancel")}
              loading={pendingEnable}
            >
              {t("settings.checkoutConnection.enable.button")}
            </ConfirmSubmitButton>
          </Form>
          {canDisable ? (
            <Form method="post">
              <input type="hidden" name="intent" value="disableCheckout" />
              <ConfirmSubmitButton
                variant="critical"
                title={t("settings.checkoutConnection.disable.title")}
                message={t("settings.checkoutConnection.disable.message")}
                confirmLabel={t("settings.checkoutConnection.disable.confirm")}
                cancelLabel={t("common.cancel")}
                loading={pendingDisable}
              >
                {t("settings.checkoutConnection.disable.button")}
              </ConfirmSubmitButton>
            </Form>
          ) : null}
        </Stack>
      ) : null}
    </Stack>
  );
}

// ---------------------------------------------------------------- 7. Відстеження та Shopify

function TrackingSection({ data, result, pending, fieldError }: SectionProps) {
  const t = useT();
  const { value, version } = data.tracking;
  const editable = data.can.manage;
  return (
    <Card title={t("settings.tracking.title")} description={t("settings.tracking.description")}>
      <Form method="post" key={version}>
        <Hidden intent="saveTracking" version={version} />
        <Stack gap={4}>
          <ActionBanner data={result} />
          {value.notifyCustomer ? <Banner tone="warning">{t("settings.tracking.notifyWarning")}</Banner> : null}
          <FormLayout columns={2}>
            <Checkbox
              id="tracking-enabled"
              label={t("settings.tracking.enabled")}
              name="enabled"
              defaultChecked={value.enabled}
              helpText={t("settings.tracking.enabledHelp")}
              error={fieldError("enabled")}
              disabled={!editable}
            />
            <TextField
              label={t("settings.tracking.intervalMinutes")}
              name="intervalMinutes"
              type="number"
              inputMode="numeric"
              min={30}
              max={1440}
              step={1}
              defaultValue={value.intervalMinutes}
              suffix={t("settings.tracking.intervalUnit")}
              helpText={t("settings.tracking.intervalHelp")}
              error={fieldError("intervalMinutes")}
              disabled={!editable}
            />
            <Checkbox
              label={t("settings.tracking.pushToShopify")}
              name="pushToShopify"
              defaultChecked={value.pushToShopify}
              helpText={t("settings.tracking.pushToShopifyHelp")}
              error={fieldError("pushToShopify")}
              disabled={!editable}
            />
            <Checkbox
              label={t("settings.tracking.notifyCustomer")}
              name="notifyCustomer"
              defaultChecked={value.notifyCustomer}
              helpText={t("settings.tracking.notifyCustomerHelp")}
              error={fieldError("notifyCustomer")}
              disabled={!editable}
            />
            <div className="ot-form-layout__full">
              <TextField
                label={t("settings.tracking.trackingUrlTemplate")}
                name="trackingUrlTemplate"
                type="url"
                defaultValue={value.trackingUrlTemplate}
                maxLength={300}
                autoComplete="off"
                spellCheck={false}
                placeholder="https://…{number}"
                helpText={t("settings.tracking.trackingUrlTemplateHelp")}
                error={fieldError("trackingUrlTemplate")}
                disabled={!editable}
              />
            </div>
          </FormLayout>
          <SaveRow canSave={editable} pending={pending} version={version} />
        </Stack>
      </Form>
    </Card>
  );
}

// ---------------------------------------------------------------- Склад (етап 5)

function WarehouseSection({ data, result, pending, fieldError }: SectionProps) {
  const t = useT();
  const { value, version } = data.warehouse;
  const editable = data.can.manage;
  // Демо: Shopify не підключено — передача й зміни з Shopify не діють (рухи складу — «Не надсилалося», movementOptionsFor).
  // Поля лишаються редагованими для перегляду; збережене значення й робочий текст не змінюються.
  const demo = data.mode === "demo";
  const shopifyHelp = (help: string, demoNote: string) =>
    demo ? (
      <Stack as="span" gap={1}>
        <Text as="span" variant="caption" weight="semibold">
          {demoNote}
        </Text>
        <span>{help}</span>
      </Stack>
    ) : (
      help
    );
  const number = (name: "lowStockThreshold" | "productionLeadDays" | "targetCoverDays" | "batchRounding", min: number, max: number, suffix?: string) => (
    <TextField
      label={t(`settings.warehouse.${name}`)}
      name={name}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={1}
      defaultValue={value[name]}
      {...(suffix ? { suffix } : {})}
      helpText={t(`settings.warehouse.${name}Help`)}
      error={fieldError(name)}
      disabled={!editable}
    />
  );
  return (
    <Card title={t("settings.warehouse.title")} description={t("settings.warehouse.description")}>
      <Form method="post" key={version}>
        <Hidden intent="saveWarehouse" version={version} />
        <Stack gap={4}>
          <ActionBanner data={result} />
          {demo ? (
            <Banner tone="info">{t("settings.warehouse.demoBanner")}</Banner>
          ) : value.shopifyPush === "deltas" ? (
            <Banner tone="info">{t("settings.warehouse.pushOnBanner")}</Banner>
          ) : null}
          {value.externalShopifyChanges === "apply" && value.shopifyPush !== "deltas" ? (
            <Banner tone="warning">{t("settings.warehouse.applyWithoutPushWarning")}</Banner>
          ) : null}
          <FormLayout columns={2}>
            {number("lowStockThreshold", 0, 100000, t("settings.warehouse.unitPieces"))}
            {number("productionLeadDays", 1, 365, t("settings.warehouse.unitDays"))}
            {number("targetCoverDays", 1, 730, t("settings.warehouse.unitDays"))}
            {number("batchRounding", 1, 10000, t("settings.warehouse.unitPieces"))}
            <Select
              label={t("settings.warehouse.shopifyPush")}
              name="shopifyPush"
              defaultValue={value.shopifyPush}
              options={WAREHOUSE_SHOPIFY_PUSH_MODES.map((m) => ({ value: m, label: t(`settings.warehouse.shopifyPush.${m}`) }))}
              helpText={shopifyHelp(t("settings.warehouse.shopifyPushHelp"), t("settings.warehouse.shopifyPushDemo"))}
              error={fieldError("shopifyPush")}
              disabled={!editable}
            />
            <Select
              label={t("settings.warehouse.externalShopifyChanges")}
              name="externalShopifyChanges"
              defaultValue={value.externalShopifyChanges}
              options={WAREHOUSE_EXTERNAL_CHANGE_MODES.map((m) => ({ value: m, label: t(`settings.warehouse.externalShopifyChanges.${m}`) }))}
              helpText={shopifyHelp(t("settings.warehouse.externalShopifyChangesHelp"), t("settings.warehouse.externalShopifyChangesDemo"))}
              error={fieldError("externalShopifyChanges")}
              disabled={!editable}
            />
            <div className="ot-form-layout__full">
              <Checkbox
                label={t("settings.warehouse.allowNegativeOnHand")}
                name="allowNegativeOnHand"
                defaultChecked={value.allowNegativeOnHand}
                helpText={t("settings.warehouse.allowNegativeOnHandHelp")}
                error={fieldError("allowNegativeOnHand")}
                disabled={!editable}
              />
            </div>
          </FormLayout>
          <SaveRow canSave={editable} pending={pending} version={version} />
        </Stack>
      </Form>
    </Card>
  );
}

// ---------------------------------------------------------------- 8. Тестовий перевізник (демо)

function TestCarrierSection({ data, result, pending, fieldError }: SectionProps) {
  const t = useT();
  if (!data.testCarrier) return null;
  const { value, version } = data.testCarrier;
  return (
    <Card
      title={t("settings.testCarrier.title")}
      description={t("settings.testCarrier.description")}
      actions={<TestBadge />}
    >
      <TestCarrierForm
        key={version}
        data={data}
        result={result}
        pending={pending}
        fieldError={fieldError}
        initialSimulation={value.simulation}
      />
    </Card>
  );
}

function TestCarrierForm({
  data,
  result,
  pending,
  fieldError,
  initialSimulation,
}: SectionProps & { initialSimulation: string }) {
  const t = useT();
  const [simulation, setSimulation] = useState(initialSimulation);
  if (!data.testCarrier) return null;
  const { value, version } = data.testCarrier;
  const editable = data.can.manage;
  return (
    <Form method="post">
      <Hidden intent="saveTestCarrier" version={version} />
      <Stack gap={4}>
        <ActionBanner data={result} />
        {value.simulation !== "none" ? (
          <Banner tone="warning">
            {t("settings.testCarrier.activeWarning", {
              simulation: t(`settings.testCarrier.simulation.${value.simulation}`),
            })}
          </Banner>
        ) : null}
        <FormLayout>
          <Select
            label={t("settings.testCarrier.simulation")}
            name="simulation"
            value={simulation}
            onChange={(e) => setSimulation(e.currentTarget.value)}
            options={data.options.simulations.map((s) => ({ value: s, label: t(`settings.testCarrier.simulation.${s}`) }))}
            helpText={t(`settings.testCarrier.help.${simulation}`)}
            error={fieldError("simulation")}
            disabled={!editable}
          />
        </FormLayout>
        <Stack gap={2}>
          <Text as="h3" variant="heading-sm">
            {t("settings.testCarrier.scenariosTitle")}
          </Text>
          <KeyValueList
            items={data.options.simulations.map((s) => ({
              key: s,
              label: t(`settings.testCarrier.simulation.${s}`),
              value: t(`settings.testCarrier.help.${s}`),
            }))}
          />
          <Text variant="body-sm" tone="subdued">
            {t("settings.testCarrier.manualReview")}
          </Text>
        </Stack>
        <SaveRow canSave={editable} pending={pending} version={version} />
      </Stack>
    </Form>
  );
}

// ---------------------------------------------------------------- 9. Інтеграції

function IntegrationsSection({ data }: { data: LoaderData }) {
  const t = useT();
  const { integrations } = data;
  const items = [
    {
      key: "shopify",
      label: t("settings.integrations.shopify"),
      value: integrations.shopifyConnected ? (
        <Stack gap={2}>
          <Status
            badges={<Badge tone="success">{t("settings.integrations.status.connected")}</Badge>}
            text={t("settings.integrations.shopify.production")}
          />
          <div>
            <Button to="/app/shopify" size="sm">
              {t("shopify.title")}
            </Button>
          </div>
        </Stack>
      ) : (
        <Status
          badges={<Badge tone="outline">{t("settings.integrations.status.notConnected")}</Badge>}
          text={t("settings.integrations.shopify.demo")}
        />
      ),
    },
    ...integrations.carriers.map((c) => ({
      key: `carrier-${c.code}`,
      label: c.mode === "test" ? t("demo.testCarrier") : c.displayName,
      value: <CarrierStatus carrier={c} />,
    })),
    {
      key: "carrier-nova-post",
      label: "Nova Post",
      value: <NovaPostStatus info={integrations.novaPost} mode={data.mode} />,
    },
    ...(integrations.novaGlobalRegistered
      ? []
      : [
          {
            key: "carrier-nova-global",
            label: "Nova Global",
            value: (
              <Status
                badges={<Badge tone="outline">{t("common.plannedStage", { stage: 3 })}</Badge>}
                text={t("settings.integrations.carrier.novaGlobalDemo")}
              />
            ),
          },
        ]),
    {
      key: "assistant",
      label: t("nav.assistant"),
      value: (
        <Status
          badges={<Badge tone="outline">{t("common.plannedStage", { stage: 7 })}</Badge>}
          text={t("settings.integrations.assistant.planned")}
        />
      ),
    },
    {
      key: "telegram",
      label: t("settings.integrations.telegram"),
      value: (
        <Status
          badges={<Badge tone="outline">{t("common.plannedStage", { stage: 8 })}</Badge>}
          text={t("settings.integrations.telegram.planned")}
        />
      ),
    },
  ];

  return (
    <Card title={t("settings.integrations.title")} description={t("settings.integrations.description")}>
      <Stack gap={4}>
        <Banner tone="info">{t("settings.integrations.secrets")}</Banner>
        {integrations.carriers.length === 0 && !integrations.novaPost.registered ? (
          <Text variant="body-sm" tone="critical">
            {t("settings.integrations.carriers.none")}
          </Text>
        ) : null}
        <KeyValueList items={items} />
      </Stack>
    </Card>
  );
}

function Status({ badges, text, extra }: { badges: ReactNode; text: string; extra?: string | string[] }) {
  const extras = extra === undefined ? [] : Array.isArray(extra) ? extra : [extra];
  return (
    <Stack gap={1} align="start">
      {badges ? (
        <Stack gap={2} direction="horizontal" align="center">
          {badges}
        </Stack>
      ) : null}
      <Text variant="body-sm" tone="subdued">
        {text}
      </Text>
      {extras.map((line) => (
        <Text key={line} variant="body-sm" tone="subdued">
          {line}
        </Text>
      ))}
    </Stack>
  );
}

function capabilityList(t: TFunction, keys: readonly string[]): string {
  return keys.length > 0
    ? t("settings.integrations.carrier.capabilities", {
        list: keys.map((k) => t(`settings.integrations.capability.${k}`)).join(", "),
      })
    : t("settings.integrations.carrier.noCapabilities");
}

/** Чесний стан перевізника: тестовий (sandbox), не налаштований (етап 3) або підключений. */
function CarrierStatus({ carrier }: { carrier: CarrierInfo }) {
  const t = useT();
  const capabilities = capabilityList(
    t,
    CAPABILITY_KEYS.filter((k) => carrier.capabilities[k]),
  );
  const defaultBadge = carrier.isDefault ? (
    <Badge tone="neutral">{t("settings.integrations.status.default")}</Badge>
  ) : null;

  if (carrier.mode === "test") {
    return (
      <Status
        badges={
          <>
            <TestBadge />
            {defaultBadge}
          </>
        }
        text={t("settings.integrations.carrier.test")}
        extra={capabilities}
      />
    );
  }
  if (!carrier.capabilities.createShipment) {
    return (
      <Status
        badges={
          <>
            <Badge tone="warning">{t("settings.integrations.status.notConfigured")}</Badge>
            {defaultBadge}
          </>
        }
        text={t("settings.integrations.carrier.notConfigured")}
        extra={capabilities}
      />
    );
  }
  return (
    <Status
      badges={
        <>
          <Badge tone="success">{t("settings.integrations.status.connected")}</Badge>
          {defaultBadge}
        </>
      }
      text={t("settings.integrations.carrier.ready")}
      extra={capabilities}
    />
  );
}

/** Nova Post: зареєстровано/ні, ключ задано/ні (без значення), хост API, можливості й дозвіл створення. */
function NovaPostStatus({ info, mode }: { info: LoaderData["integrations"]["novaPost"]; mode: LoaderData["mode"] }) {
  const t = useT();
  const details: string[] = [];
  if (info.apiKeyConfigured !== null) {
    details.push(
      t("settings.integrations.novaPost.apiKey", {
        state: t(info.apiKeyConfigured ? "settings.integrations.novaPost.key.set" : "settings.integrations.novaPost.key.missing"),
      }),
    );
  }
  if (info.apiHost) details.push(t("settings.integrations.novaPost.host", { host: info.apiHost }));

  if (!info.registered) {
    if (mode === "demo") {
      return (
        <Status
          badges={<Badge tone="outline">{t("settings.integrations.status.notConnected")}</Badge>}
          text={t("settings.integrations.novaPost.demo")}
        />
      );
    }
    return (
      <Status
        badges={<Badge tone="warning">{t("settings.integrations.status.notConfigured")}</Badge>}
        text={t(info.apiKeyConfigured ? "settings.integrations.novaPost.keyNotRegistered" : "settings.integrations.novaPost.noKey")}
        extra={details}
      />
    );
  }

  const caps = info.capabilities;
  const enabled = caps ? NOVA_POST_CAPABILITY_KEYS.filter((k) => caps[k]) : [];
  details.push(capabilityList(t, enabled));
  details.push(
    t("settings.integrations.novaPost.creation", {
      state: t(caps?.createShipment ? "settings.integrations.novaPost.creation.on" : "settings.integrations.novaPost.creation.off"),
    }),
  );
  return (
    <Status
      badges={
        <>
          <Badge tone="success">{t("settings.integrations.status.connected")}</Badge>
          {info.isDefault ? <Badge tone="neutral">{t("settings.integrations.status.default")}</Badge> : null}
          {caps?.createShipment ? null : <Badge tone="outline">{t("settings.integrations.status.creationDisabled")}</Badge>}
        </>
      }
      text={t("settings.integrations.novaPost.registered")}
      extra={details}
    />
  );
}

// ---------------------------------------------------------------- 10. Демо-дані

function DemoDataSection({ result, pending }: { result: SettingsActionResult | undefined; pending: boolean }) {
  const t = useT();
  return (
    <Card title={t("settings.demo.title")} description={t("settings.demo.description")}>
      <Form method="post">
        <input type="hidden" name="intent" value="resetDemo" />
        <Stack gap={3} align="start">
          <ActionBanner data={result} />
          <ConfirmSubmitButton
            variant="critical"
            title={t("demo.reset.title")}
            message={
              <Stack gap={2}>
                <Text>{t("demo.reset.message")}</Text>
                <Text>{t("settings.demo.resetSettings")}</Text>
              </Stack>
            }
            confirmLabel={t("settings.demo.confirm")}
            cancelLabel={t("common.cancel")}
            loading={pending}
          >
            {t("demo.reset.button")}
          </ConfirmSubmitButton>
        </Stack>
      </Form>
    </Card>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";
