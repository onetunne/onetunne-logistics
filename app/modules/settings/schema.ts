import { z } from "zod";
import { EXPORT_REASONS, INCOTERMS } from "~/integrations/carriers/types";
import { NOVA_POST_DELIVERY_TYPES } from "~/integrations/carriers/nova-post/mapping";
import { FX_RATE_DATE_POLICIES } from "~/domain/finance";
import { currencyMinorDigits, isSupportedCurrency } from "~/lib/decimal";

/**
 * Схеми налаштувань (зберігаються у таблиці settings, версіонуються у settings_history).
 * Мова й тема — особисті налаштування користувача (cookie), не тут.
 */

export const AUTOMATION_MODES = ["manual", "semi", "auto"] as const;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];

export const automationSchema = z.object({
  /** manual — усі зовнішні дії підтверджує менеджер; semi — авто-перевірка; auto — ще й авто-накладна. */
  mode: z.enum(AUTOMATION_MODES),
  /** Глобальна кнопка призупинення автоматизації. */
  globalPause: z.boolean(),
});

const trimmed = (max: number) => z.string().trim().max(max);

export const shipperSchema = z.object({
  companyName: trimmed(120),
  contactName: trimmed(120),
  phone: trimmed(32),
  email: z.union([z.literal(""), z.string().trim().email().max(160)]),
  countryCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^([A-Z]{2})?$/, "ISO-3166 alpha-2"),
  city: trimmed(120),
  postalCode: trimmed(20),
  address1: trimmed(200),
  address2: trimmed(200),
  warehouseName: trimmed(120),
  /** Відділення/пункт прийому перевізника. */
  carrierBranch: trimmed(120),
  // Етап 3 (митні документи). Значення за замовчуванням — для сумісності зі збереженими налаштуваннями.
  /** ЄДРПОУ (юрособа) або ІПН (ФОП). */
  taxId: z.string().trim().regex(/^(\d{8}|\d{10})?$/, "8 or 10 digits").default(""),
  eori: z.string().trim().toUpperCase().regex(/^([A-Z]{2}[A-Z0-9]{1,15})?$/, "EORI").default(""),
  ioss: z.string().trim().toUpperCase().regex(/^(IM\d{10})?$/, "IOSS: IM + 10 digits").default(""),
});

export const packageSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[a-z0-9_-]{1,32}$/),
  name: trimmed(80).min(1),
  lengthCm: z.number().int().min(1).max(300),
  widthCm: z.number().int().min(1).max(300),
  heightCm: z.number().int().min(1).max(300),
  tareWeightGrams: z.number().int().min(0).max(30000),
});

export const packagingSchema = z
  .object({
    defaultPackageCode: z.string().trim().min(1),
    /** Дільник об'ємної ваги (см³/кг), залежить від перевізника. Напр. 5000. */
    volumetricDivisor: z.number().int().min(1000).max(10000),
    packages: z.array(packageSchema).min(1).max(20),
  })
  .refine((v) => v.packages.some((p) => p.code === v.defaultPackageCode), {
    message: "defaultPackageCode must reference an existing package",
    path: ["defaultPackageCode"],
  })
  .refine((v) => new Set(v.packages.map((p) => p.code)).size === v.packages.length, {
    message: "package codes must be unique",
    path: ["packages"],
  });

export const TEST_CARRIER_SIMULATIONS = [
  "none",
  "reject",
  "unavailable",
  "fail_after_create",
  "timeout_before_create",
] as const;
export type TestCarrierSimulation = (typeof TEST_CARRIER_SIMULATIONS)[number];

export const testCarrierSchema = z.object({
  /** Імітація збоїв тестового перевізника для перевірки захисту від дублікатів. */
  simulation: z.enum(TEST_CARRIER_SIMULATIONS),
});

/** Митні дані за замовчуванням для комерційного інвойсу. */
export const customsSchema = z.object({
  incoterm: z.enum(INCOTERMS),
  exportReason: z.enum(EXPORT_REASONS),
  invoiceType: z.enum(["commercial", "proforma"]),
  /**
   * Адреса реєстрації одержувача (Nova Post вимагає для DE, SK, HU, FR). Застосунок не знає адреси реєстрації клієнта:
   * "shipping" — власник дозволив використовувати адресу доставки; "none" — накладні до цих країн не створюються.
   */
  recipientRegistrationAddress: z.enum(["none", "shipping"]).default("none"),
  /**
   * Власник підтвердив, що адреса доставки відповідає адресі реєстрації одержувача і що це допустимо за правилами
   * перевізника. Без підтвердження адреса доставки як адреса реєстрації НЕ використовується.
   */
  recipientRegistrationAddressConfirmed: z.boolean().default(false),
});

/** Параметри Nova Post API v1.0 (договір, тариф). */
export const NOVA_POST_PAYER_TYPES = ["Sender", "Recipient", "ThirdPerson"] as const;
export const novaPostSchema = z.object({
  /** Хто оплачує доставку. */
  payerType: z.enum(NOVA_POST_PAYER_TYPES),
  /** Номер договору (безготівкова оплата / договірні тарифи; обов'язковий для ThirdPerson). */
  payerContractNumber: z.string().trim().max(50),
  /**
   * Тариф Nova Post (deliveryType у POST /shipments, deliveryTypes у розрахунку): лише документовані коди
   * standard / economy / express (НЕ UUID тарифу з відповіді розрахунку); порожньо — тариф визначає перевізник.
   */
  deliveryType: z.enum(["", ...NOVA_POST_DELIVERY_TYPES]),
  /**
   * Валюта сум, які повертає розрахунок Nova Post (у відповіді API валюта не вказана; за договором клієнта з України — UAH).
   */
  tariffCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  /**
   * Підтвердження власника (після «Перевірки підключення»): валюта сум розрахунку й договірні тарифи відповідають
   * договору. Дійсне лише для тих самих валюти, договору й тарифу — після їх зміни потрібне нове підтвердження.
   * Без дійсного підтвердження вартість доставки не використовується в Checkout.
   */
  tariffConfirmation: z
    .object({
      confirmedAt: z.string(),
      confirmedBy: z.string(),
      tariffCurrency: z.string(),
      payerContractNumber: z.string(),
      deliveryType: z.string(),
    })
    .nullable()
    .default(null),
});

/** Підтвердження валюти/договірних тарифів дійсне для поточних налаштувань Nova Post. */
export function isTariffConfirmed(np: z.infer<typeof novaPostSchema>): boolean {
  const c = np.tariffConfirmation;
  return Boolean(
    c && c.tariffCurrency === np.tariffCurrency && c.payerContractNumber === np.payerContractNumber && c.deliveryType === np.deliveryType,
  );
}

/** Розрахунок доставки в Shopify Checkout (CarrierService). */
export const ROUNDING_MODES = ["none", "up_whole", "up_99"] as const;
export const checkoutRatesSchema = z.object({
  /** Вимкнено — застосунок повертає порожній список тарифів (Shopify показує лише власні тарифи магазину). */
  enabled: z.boolean(),
  /** Націнка у відсотках до вартості перевізника (0–200). */
  markupPercent: z.number().min(0).max(200),
  /** Фіксована надбавка у валюті тарифу перевізника (novaPost.tariffCurrency — база таблиці курсів), десятковий рядок; у валюту кошика перераховується за fxRates. */
  markupFixed: z.string().trim().regex(/^\d{1,7}(\.\d{1,2})?$/, "0.00"),
  rounding: z.enum(ROUNDING_MODES),
  /**
   * Курси для перерахунку вартості перевізника у валюту кошика: скільки одиниць валюти перевізника (UAH)
   * коштує 1 одиниця валюти. Вносить власник; без курсу тариф не показується.
   */
  fxRates: z
    .array(
      z.object({
        currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
        rate: z.string().trim().regex(/^\d{1,6}(\.\d{1,6})?$/, "0.000000"),
      }),
    )
    .max(20),
  /** Назва тарифу в Checkout (порожньо — назва послуги перевізника). */
  serviceName: trimmed(80),
});

/** Відстеження посилок і передача трек-номерів у Shopify. */
export const trackingSchema = z.object({
  enabled: z.boolean(),
  /** Інтервал автоматичного опитування перевізника, хв. */
  intervalMinutes: z.number().int().min(30).max(1440),
  /** Створювати виконання (fulfillment) з трек-номером у Shopify після фактичної передачі перевізнику. */
  pushToShopify: z.boolean(),
  /** Чи надсилати клієнту лист Shopify про відправлення. За замовчуванням — ні. */
  notifyCustomer: z.boolean(),
  /**
   * Шаблон публічного посилання відстеження для Shopify, напр. https://…{number}… (Nova Post немає в списку
   * перевізників Shopify, тому без посилання трек-номер у Shopify не клікабельний). Порожньо — лише номер.
   */
  trackingUrlTemplate: z
    .string()
    .trim()
    .max(300)
    .refine((v) => v === "" || (/^https:\/\/[^\s]+$/.test(v) && v.includes("{number}")), "https://…{number}")
    .default(""),
});

/**
 * Етап 5: склад і виробництво. Усі поля мають .default() — збережені раніше налаштування лишаються дійсними.
 */
export const WAREHOUSE_SHOPIFY_PUSH_MODES = ["off", "deltas"] as const;
export const WAREHOUSE_EXTERNAL_CHANGE_MODES = ["review", "apply"] as const;
export const warehouseSchema = z.object({
  /** Поріг «мало на складі» (доступно ≤ порогу) для позицій без власного порогу. */
  lowStockThreshold: z.number().int().min(0).max(100000).default(5),
  /** Типовий термін виробництва партії, днів (рекомендації наступних партій). */
  productionLeadDays: z.number().int().min(1).max(365).default(30),
  /** Цільовий запас після надходження партії, днів продажів. */
  targetCoverDays: z.number().int().min(1).max(730).default(60),
  /** Округлення рекомендованої кількості партії вгору до кратного (штук). */
  batchRounding: z.number().int().min(1).max(10000).default(10),
  /**
   * Передача внутрішніх змін залишку (надходження, брак, коригування) у Shopify дельтою: off — не надсилати
   * (рухи позначаються shopify_sync_state = skipped); deltas — у чергу (pending). Продажі/виконання Shopify рахує сам.
   */
  shopifyPush: z.enum(WAREHOUSE_SHOPIFY_PUSH_MODES).default("off"),
  /**
   * Зміни залишку, зроблені в Shopify не застосунком: review — розбіжність на розгляд власника (inventory_conflicts);
   * apply — прийняти значення Shopify автоматично (рух shopify_external).
   */
  externalShopifyChanges: z.enum(WAREHOUSE_EXTERNAL_CHANGE_MODES).default("review"),
  /**
   * Фізичні події можуть зробити on_hand від'ємним (з попередженням negative_on_hand): передача перевізнику
   * (consume_sale) — ЗАВЖДИ (посилка вже фізично передана); прийняте значення Shopify (shopify_external) — лише
   * коли true. false — прийняття значення Shopify, що дає on_hand < 0, відхиляється (inventory.insufficient).
   * Інші рухи (коригування, брак, витрата матеріалів) ніколи не роблять on_hand від'ємним.
   */
  allowNegativeOnHand: z.boolean().default(true),
});

/**
 * Етап 6: фінанси (docs/stage6-design.md §5.2). Усі поля мають .default() — збережені раніше значення лишаються дійсними.
 * Дозвіл зміни — finance.manage (лише власник) + роль owner (PERMISSION_FOR_KEY, saveFinanceSettings у
 * modules/finance/core/settings.server.ts; кожна зміна — settings_history + finance_change_log). Сторінка «Налаштування»
 * (pages/settings.tsx) НІКОЛИ не повертає ключ finance (settings.view делегується працівникам) — лише /finance/settings.
 */
const financeCurrency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "currency")
  .refine(isSupportedCurrency, "currency");
const financeAmount = z.string().trim().regex(/^\d{1,12}(\.\d{1,2})?$/, "amount");

/**
 * §5.1: сума з ненульовими сотими у валюті з 0 знаками (JPY, KRW…) — помилка розбору, не округлення. Повідомлення —
 * код finance.error.amountWholeUnits.
 */
function hasFractionForZeroDecimal(amount: string | undefined, currency: string | undefined): boolean {
  if (amount === undefined || currency === undefined || !isSupportedCurrency(currency)) return false;
  if (currencyMinorDigits(currency) !== 0) return false;
  const frac = amount.trim().split(".")[1] ?? "";
  return /[1-9]/.test(frac);
}
const WHOLE_UNITS = "amountWholeUnits";

export const financeFxSchema = z.object({
  /** ОДИН вимикач кожного запиту до НБУ (розклад, кнопка, історія). Типово вимкнено (D-4). */
  nbuEnabled: z.boolean().default(false),
  /** Лише розклад (коли вимикач увімкнено). */
  autoFetch: z.boolean().default(true),
  /** Запасний курс — до N днів назад, із позначкою (D-17). */
  fallbackDays: z.number().int().min(0).max(31).default(7),
  /** Дата курсу виручки й комісій передоплачених замовлень (D-25). */
  rateDatePolicy: z.enum(FX_RATE_DATE_POLICIES).default("payment_date"),
});

export const financeShippingVarianceSchema = z
  .object({
    /** Поріг розбіжності «факт vs прогноз»: max(percent % прогнозу, minAmount) (D-18). */
    percent: z.number().int().min(0).max(1000).default(15),
    minAmount: financeAmount.default("50.00"),
    currency: financeCurrency.default("UAH"),
    /** Поріг ваги: max(weightPercent %, weightMinGrams г). */
    weightPercent: z.number().int().min(0).max(1000).default(10),
    weightMinGrams: z.number().int().min(0).max(100000).default(100),
    /** Збиткова доставка: факт − сплачено покупцем > lossMinAmount (у currency). */
    lossMinAmount: financeAmount.default("50.00"),
  })
  .superRefine((v, ctx) => {
    for (const field of ["minAmount", "lossMinAmount"] as const) {
      if (hasFractionForZeroDecimal(v[field], v.currency)) ctx.addIssue({ code: "custom", path: [field], message: WHOLE_UNITS });
    }
  });

export const financeShippingForecastRowSchema = z
  .object({
    country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "country"),
    amount: financeAmount,
    currency: financeCurrency,
  })
  .superRefine((row, ctx) => {
    if (hasFractionForZeroDecimal(row.amount, row.currency)) ctx.addIssue({ code: "custom", path: ["amount"], message: WHOLE_UNITS });
  });

export const financeShippingForecastSchema = z.object({
  historyDays: z.number().int().min(7).max(730).default(90),
  minSamples: z.number().int().min(1).max(1000).default(3),
  /** Таблиця власника (прогноз №3), одна сума на країну. */
  byCountry: z
    .array(financeShippingForecastRowSchema)
    .max(250)
    .default([])
    .refine((rows) => new Set(rows.map((r) => r.country)).size === rows.length, "duplicateCountry"),
});

export const financePartnersSchema = z.object({
  defaultRateBp: z.number().int().min(0).max(10000).default(1000),
  holdDays: z.number().int().min(0).max(365).default(30),
});

export const financeReportsSchema = z.object({
  /** Робочий режим: знімки завершених періодів за розкладом. */
  scheduledSnapshots: z.boolean().default(true),
});

export const financeSchema = z.object({
  reportingCurrency: financeCurrency.default("UAH"),
  /** Валюта оцінки запасів; блокується після першого запису оцінки (finance.error.valuationCurrencyLocked). */
  valuationCurrency: financeCurrency.default("UAH"),
  displayCurrencies: z
    .array(financeCurrency)
    .min(1)
    .max(10)
    .default(["UAH", "EUR", "USD", "GBP", "PLN"])
    .refine((list) => new Set(list).size === list.length, "duplicateCurrency"),
  fx: financeFxSchema.default(financeFxSchema.parse({})),
  /** Платник ПДВ: витрати перевізника без ПДВ (ПДВ довідково); ні — з ПДВ (D-16). */
  vatPayer: z.boolean().default(false),
  /** Лише для перевірки на тестовому магазині (D-27); увімкнене — банер на кожній фінансовій сторінці. */
  includeTestOrders: z.boolean().default(false),
  shippingVariance: financeShippingVarianceSchema.default(financeShippingVarianceSchema.parse({})),
  shippingForecast: financeShippingForecastSchema.default(financeShippingForecastSchema.parse({})),
  partners: financePartnersSchema.default(financePartnersSchema.parse({})),
  reports: financeReportsSchema.default(financeReportsSchema.parse({})),
});
export type FinanceSettings = z.infer<typeof financeSchema>;

/** Поля фінансових налаштувань (шляхи) — підписи й підказки i18n finance.settings.<шлях>.label / .help. */
export const FINANCE_SETTINGS_FIELDS = [
  "reportingCurrency",
  "valuationCurrency",
  "displayCurrencies",
  "fx.nbuEnabled",
  "fx.autoFetch",
  "fx.fallbackDays",
  "fx.rateDatePolicy",
  "vatPayer",
  "includeTestOrders",
  "shippingVariance.percent",
  "shippingVariance.minAmount",
  "shippingVariance.currency",
  "shippingVariance.weightPercent",
  "shippingVariance.weightMinGrams",
  "shippingVariance.lossMinAmount",
  "shippingForecast.historyDays",
  "shippingForecast.minSamples",
  "shippingForecast.byCountry",
  "partners.defaultRateBp",
  "partners.holdDays",
  "reports.scheduledSnapshots",
] as const;
export type FinanceSettingsField = (typeof FINANCE_SETTINGS_FIELDS)[number];

export const settingsSchemas = {
  automation: automationSchema,
  shipper: shipperSchema,
  packaging: packagingSchema,
  testCarrier: testCarrierSchema,
  customs: customsSchema,
  novaPost: novaPostSchema,
  checkoutRates: checkoutRatesSchema,
  tracking: trackingSchema,
  warehouse: warehouseSchema,
  finance: financeSchema,
} as const;

export type SettingsKey = keyof typeof settingsSchemas;
export type SettingsValue<K extends SettingsKey> = z.infer<(typeof settingsSchemas)[K]>;
export type AllSettings = { [K in SettingsKey]: SettingsValue<K> };

export const SETTINGS_KEYS = Object.keys(settingsSchemas) as SettingsKey[];

/** Безпечні значення за замовчуванням (production): ручний режим, порожній відправник. */
export const DEFAULT_SETTINGS: AllSettings = {
  automation: { mode: "manual", globalPause: false },
  shipper: {
    companyName: "",
    contactName: "",
    phone: "",
    email: "",
    countryCode: "UA",
    city: "",
    postalCode: "",
    address1: "",
    address2: "",
    warehouseName: "",
    carrierBranch: "",
    taxId: "",
    eori: "",
    ioss: "",
  },
  packaging: {
    defaultPackageCode: "mailer_m",
    volumetricDivisor: 5000,
    packages: [
      { code: "mailer_s", name: "Mailer S", lengthCm: 25, widthCm: 18, heightCm: 5, tareWeightGrams: 40 },
      { code: "mailer_m", name: "Mailer M", lengthCm: 35, widthCm: 25, heightCm: 8, tareWeightGrams: 70 },
      { code: "box_l", name: "Box L", lengthCm: 40, widthCm: 30, heightCm: 20, tareWeightGrams: 250 },
    ],
  },
  testCarrier: { simulation: "none" },
  customs: { incoterm: "DAP", exportReason: "sale", invoiceType: "commercial", recipientRegistrationAddress: "none", recipientRegistrationAddressConfirmed: false },
  novaPost: { payerType: "Sender", payerContractNumber: "", deliveryType: "", tariffCurrency: "UAH", tariffConfirmation: null },
  checkoutRates: { enabled: false, markupPercent: 0, markupFixed: "0.00", rounding: "none", fxRates: [], serviceName: "" },
  tracking: { enabled: true, intervalMinutes: 60, pushToShopify: true, notifyCustomer: false, trackingUrlTemplate: "" },
  warehouse: {
    lowStockThreshold: 5,
    productionLeadDays: 30,
    targetCoverDays: 60,
    batchRounding: 10,
    shopifyPush: "off",
    externalShopifyChanges: "review",
    allowNegativeOnHand: true,
  },
  finance: financeSchema.parse({}),
};

/** Перелік обов'язкових полів відправника для створення накладної. */
export const REQUIRED_SHIPPER_FIELDS = ["companyName", "contactName", "phone", "countryCode", "city", "address1"] as const;
