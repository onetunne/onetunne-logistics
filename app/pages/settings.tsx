import { useState, type ReactNode } from "react";
import {
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
import type { CarrierCapabilities } from "~/integrations/carriers/types";
import { NOVA_GLOBAL_CODE } from "~/integrations/carriers/nova-global";
import { useLocale, useT, type TFunction } from "~/i18n";
import { formatWeight } from "~/lib/format";
import {
  AUTOMATION_MODES,
  REQUIRED_SHIPPER_FIELDS,
  shipperSchema,
  TEST_CARRIER_SIMULATIONS,
  type SettingsKey,
  type SettingsValue,
} from "~/modules/settings/schema";
import { loadSettings, updateSetting, type UpdateSettingResult } from "~/modules/settings/settings.server";
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

const INTENTS = ["saveAutomation", "saveShipper", "savePackaging", "saveTestCarrier", "resetDemo"] as const;
type Intent = (typeof INTENTS)[number];

/** Результат дії з позначкою форми, якій він належить (банер показується лише в ній). */
export type SettingsActionResult = ActionResult & { intent: string };

// ---------------------------------------------------------------- loader

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  try {
    requirePermission(ctx.actor, "settings.view");
  } catch {
    throw new Response("Forbidden", { status: 403 });
  }
  const { values, versions } = await loadSettings(ctx.db);
  const isDemo = ctx.mode === "demo";
  const defaultCarrierCode = ctx.carriers.getDefault()?.code ?? null;

  return {
    mode: ctx.mode,
    can: {
      automation: can(ctx.actor, "automation.manage"),
      manage: can(ctx.actor, "settings.manage"),
      demoReset: isDemo && can(ctx.actor, "demo.reset"),
    },
    options: {
      modes: [...AUTOMATION_MODES],
      simulations: [...TEST_CARRIER_SIMULATIONS],
      requiredShipperFields: [...REQUIRED_SHIPPER_FIELDS] as ShipperField[],
    },
    automation: { value: values.automation, version: versions.automation },
    shipper: {
      value: values.shipper,
      version: versions.shipper,
      missing: REQUIRED_SHIPPER_FIELDS.filter((f) => !String(values.shipper[f] ?? "").trim()) as ShipperField[],
    },
    packaging: { value: values.packaging, version: versions.packaging },
    testCarrier: isDemo ? { value: values.testCarrier, version: versions.testCarrier } : null,
    integrations: {
      // Лише булеві ознаки та публічні назви — жодних значень змінних середовища.
      shopifyConnected: ctx.mode === "production",
      carriers: ctx.carriers.list().map((c) => ({
        code: c.code,
        displayName: c.displayName,
        mode: c.mode,
        isDefault: c.code === defaultCarrierCode,
        capabilities: { ...c.capabilities },
      })),
      novaGlobalRegistered: ctx.carriers.get(NOVA_GLOBAL_CODE) !== undefined,
    },
  };
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

async function runIntent(ctx: RequestContext, intent: Intent, form: FormData): Promise<ActionResult> {
  switch (intent) {
    case "saveAutomation": {
      requirePermission(ctx.actor, "automation.manage");
      const version = expectedVersion(form);
      if (version === null) return { ok: false, error: "error.generic" };
      const input = { mode: formString(form, "mode"), globalPause: form.get("globalPause") === "on" };
      return saved(await updateSetting(ctx.db, ctx.actor, "automation", input, version));
    }
    case "saveShipper": {
      requirePermission(ctx.actor, "settings.manage");
      const version = expectedVersion(form);
      if (version === null) return { ok: false, error: "error.generic" };
      const fields = Object.keys(shipperSchema.shape) as ShipperField[];
      const input = Object.fromEntries(fields.map((f) => [f, formString(form, f)]));
      return saved(await updateSetting(ctx.db, ctx.actor, "shipper", input, version));
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
    case "saveTestCarrier": {
      if (ctx.mode !== "demo") throw new Response("Not Found", { status: 404 });
      requirePermission(ctx.actor, "settings.manage");
      const version = expectedVersion(form);
      if (version === null) return { ok: false, error: "error.generic" };
      const input = { simulation: formString(form, "simulation") };
      return saved(await updateSetting(ctx.db, ctx.actor, "testCarrier", input, version));
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

function saved<K extends SettingsKey>(result: UpdateSettingResult<K>): ActionResult {
  return result.ok
    ? { ok: true, message: "result.settings.saved" }
    : { ok: false, error: "error.validation", fieldErrors: result.fieldErrors };
}

// ---------------------------------------------------------------- page

type LoaderData = Awaited<ReturnType<typeof loader>>;
type CarrierInfo = LoaderData["integrations"]["carriers"][number];
type FieldErrorFn = (name: string) => string | null;

/** Повідомлення сервера (zod) не показуємо як є — перекладаємо за назвою поля. */
const FIELD_ERROR_KEYS: Readonly<Record<string, string>> = {
  email: "settings.error.email",
  countryCode: "settings.error.countryCode",
  defaultPackageCode: "settings.error.defaultPackage",
  volumetricDivisor: "settings.error.volumetricDivisor",
};

interface ShipperFieldConfig {
  type?: TextFieldType;
  autoComplete: string;
  maxLength: number;
  help?: string;
  autoCapitalize?: string;
  /** На всю ширину у двоколонковій розкладці. */
  full?: boolean;
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
        <PackagingSection data={data} {...sectionProps("savePackaging")} />
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
  return (name) => (errors?.[name] ? t(FIELD_ERROR_KEYS[name] ?? "settings.error.invalid") : null);
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
          <FormLayout columns={2}>
            {SHIPPER_FIELD_ORDER.map((f) => {
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
            })}
          </FormLayout>
          <SaveRow canSave={editable} pending={pending} version={version} />
        </Stack>
      </Form>
    </Card>
  );
}

// ---------------------------------------------------------------- 3. Упаковка

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

// ---------------------------------------------------------------- 4. Тестовий перевізник (демо)

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

// ---------------------------------------------------------------- 5. Інтеграції

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
        {integrations.carriers.length === 0 ? (
          <Text variant="body-sm" tone="critical">
            {t("settings.integrations.carriers.none")}
          </Text>
        ) : null}
        <KeyValueList items={items} />
      </Stack>
    </Card>
  );
}

function Status({ badges, text, extra }: { badges: ReactNode; text: string; extra?: string }) {
  return (
    <Stack gap={1} align="start">
      <Stack gap={2} direction="horizontal" align="center">
        {badges}
      </Stack>
      <Text variant="body-sm" tone="subdued">
        {text}
      </Text>
      {extra ? (
        <Text variant="body-sm" tone="subdued">
          {extra}
        </Text>
      ) : null}
    </Stack>
  );
}

/** Чесний стан перевізника: тестовий (sandbox), не налаштований (етап 3) або підключений. */
function CarrierStatus({ carrier }: { carrier: CarrierInfo }) {
  const t = useT();
  const enabled = CAPABILITY_KEYS.filter((k) => carrier.capabilities[k]);
  const capabilities =
    enabled.length > 0
      ? t("settings.integrations.carrier.capabilities", {
          list: enabled.map((k) => t(`settings.integrations.capability.${k}`)).join(", "),
        })
      : t("settings.integrations.carrier.noCapabilities");
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

// ---------------------------------------------------------------- 7. Демо-дані

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
