import { z } from "zod";

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

export const settingsSchemas = {
  automation: automationSchema,
  shipper: shipperSchema,
  packaging: packagingSchema,
  testCarrier: testCarrierSchema,
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
};

/** Перелік обов'язкових полів відправника для створення накладної. */
export const REQUIRED_SHIPPER_FIELDS = ["companyName", "contactName", "phone", "countryCode", "city", "address1"] as const;
