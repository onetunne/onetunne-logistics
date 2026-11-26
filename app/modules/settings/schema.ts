import { z } from "zod";
import { EXPORT_REASONS, INCOTERMS } from "~/integrations/carriers/types";
import { NOVA_POST_DELIVERY_TYPES } from "~/integrations/carriers/nova-post/mapping";

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
});

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

export const settingsSchemas = {
  automation: automationSchema,
  shipper: shipperSchema,
  packaging: packagingSchema,
  testCarrier: testCarrierSchema,
  customs: customsSchema,
  novaPost: novaPostSchema,
  checkoutRates: checkoutRatesSchema,
  tracking: trackingSchema,
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
  customs: { incoterm: "DAP", exportReason: "sale", invoiceType: "commercial", recipientRegistrationAddress: "none" },
  novaPost: { payerType: "Sender", payerContractNumber: "", deliveryType: "", tariffCurrency: "UAH" },
  checkoutRates: { enabled: false, markupPercent: 0, markupFixed: "0.00", rounding: "none", fxRates: [], serviceName: "" },
  tracking: { enabled: true, intervalMinutes: 60, pushToShopify: true, notifyCustomer: false, trackingUrlTemplate: "" },
};

/** Перелік обов'язкових полів відправника для створення накладної. */
export const REQUIRED_SHIPPER_FIELDS = ["companyName", "contactName", "phone", "countryCode", "city", "address1"] as const;
