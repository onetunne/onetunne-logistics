import { Form, useNavigation } from "react-router";
import { useT } from "~/i18n";
import type { CustomsOverrides, OverrideField, VariantCustomsFields } from "~/modules/products/customs-overrides";
import { Badge, Button, FormLayout, Stack, Text, TextField } from "~/ui";

/**
 * Форма митних даних, ваги й габаритів варіанта товару (сторінка «Товари» і сторінка замовлення).
 * Поля форми — перевизначення застосунку: порожнє поле = значення з Shopify (у демо — демо-значення товару).
 * Значення Shopify показується як підказка і плейсхолдер. Дія — intent "updateVariant" з variantId.
 */

/** Значення полів без перевизначень (з Shopify). */
export type VariantShopifyValues = Omit<VariantCustomsFields, "customsOverrides">;

export interface VariantCustomsFormVariant {
  id: string;
  /** Значення, збережені в застосунку (лише задані поля). */
  overrides: CustomsOverrides;
  /** Значення з Shopify для підказок (null — невідомо). */
  shopify: VariantShopifyValues | null;
}

interface FieldDef {
  name: OverrideField;
  kind: "text" | "number";
  maxLength?: number;
  max?: number;
  help?: string;
  full?: boolean;
  upper?: boolean;
}

const FIELDS: readonly FieldDef[] = [
  { name: "hsCode", kind: "text", maxLength: 20, help: "products.form.hsHelp" },
  { name: "countryOfOrigin", kind: "text", maxLength: 2, help: "products.form.originHelp", upper: true },
  { name: "customsDescription", kind: "text", maxLength: 200, help: "products.form.descriptionHelp", full: true },
  { name: "customsDescriptionLocal", kind: "text", maxLength: 200, help: "products.form.descriptionLocalHelp", full: true },
  { name: "material", kind: "text", maxLength: 50, help: "products.form.materialHelp" },
  { name: "weightGrams", kind: "number", max: 100_000, help: "products.form.weightHelp" },
  { name: "lengthMm", kind: "number", max: 3_000 },
  { name: "widthMm", kind: "number", max: 3_000 },
  { name: "heightMm", kind: "number", max: 3_000 },
];

/** Позначка поля, зміненого в застосунку. */
export function OverriddenBadge() {
  const t = useT();
  return (
    <Badge tone="info" size="sm">
      {t("products.overridden")}
    </Badge>
  );
}

export function VariantCustomsForm({
  variant,
  isDemo,
  fieldErrors,
  issueErrors,
  open,
}: {
  variant: VariantCustomsFormVariant;
  isDemo: boolean;
  /** Помилки дії з ключами `variant.<id>.<поле>`. */
  fieldErrors?: Record<string, string>;
  /** Відкриті проблеми замовлення за полями (назви проблем). */
  issueErrors?: Partial<Record<OverrideField, string>>;
  open?: boolean;
}) {
  const t = useT();
  const navigation = useNavigation();
  const prefix = `variant.${variant.id}.`;
  const hasFieldError = Object.keys(fieldErrors ?? {}).some((k) => k.startsWith(prefix));
  const busy =
    navigation.state !== "idle" &&
    navigation.formMethod?.toUpperCase() === "POST" &&
    navigation.formData?.get("intent") === "updateVariant" &&
    navigation.formData?.get("variantId") === variant.id;
  const id = (field: string) => `variant-${variant.id}-${field}`;
  const errorFor = (field: OverrideField): string | null => {
    if (fieldErrors?.[`${prefix}${field}`]) return t(`products.error.${field}`);
    return issueErrors?.[field] ?? null;
  };
  const sourceHint = (field: OverrideField): string => {
    const value = variant.shopify?.[field];
    const has = value !== null && value !== undefined && String(value).trim() !== "";
    if (!variant.shopify) return "";
    if (isDemo) return has ? t("products.demoValue", { value: String(value) }) : t("products.demoEmpty");
    return has ? t("products.shopifyValue", { value: String(value) }) : t("products.shopifyEmpty");
  };
  // Нова версія збережених даних → поля створюються заново зі збереженими значеннями.
  const formKey = JSON.stringify(variant.overrides);

  return (
    <details open={open || hasFieldError || undefined}>
      <summary>
        <Text as="span" variant="body-sm" weight="semibold">
          {t("products.form.edit")}
        </Text>
      </summary>
      <Form method="post" key={formKey}>
        <input type="hidden" name="intent" value="updateVariant" />
        <input type="hidden" name="variantId" value={variant.id} />
        <Stack gap={3}>
          <Text variant="body-sm" tone="subdued">
            {t(isDemo ? "products.form.help.demo" : "products.form.help.production")}
          </Text>
          <FormLayout columns={2}>
            {FIELDS.map((f) => {
              const shopifyValue = variant.shopify?.[f.name];
              const hint = sourceHint(f.name);
              const field = (
                <TextField
                  key={f.name}
                  id={id(f.name)}
                  name={f.name}
                  label={t(`field.variant.${f.name}`)}
                  type={f.kind === "number" ? "number" : "text"}
                  inputMode={f.kind === "number" ? "numeric" : undefined}
                  min={f.kind === "number" ? 1 : undefined}
                  max={f.max}
                  step={f.kind === "number" ? 1 : undefined}
                  maxLength={f.maxLength}
                  defaultValue={variant.overrides[f.name] ?? ""}
                  placeholder={shopifyValue !== null && shopifyValue !== undefined ? String(shopifyValue) : undefined}
                  helpText={
                    f.help || hint ? (
                      <>
                        {f.help ? <div>{t(f.help)}</div> : null}
                        {hint ? <div>{hint}</div> : null}
                      </>
                    ) : undefined
                  }
                  error={errorFor(f.name)}
                  autoCapitalize={f.upper ? "characters" : undefined}
                  spellCheck={f.kind === "text" && !f.upper && f.name !== "hsCode" ? undefined : false}
                  autoComplete="off"
                />
              );
              return f.full ? (
                <div key={f.name} className="ot-form-layout__full">
                  {field}
                </div>
              ) : (
                field
              );
            })}
            <div className="ot-form-layout__full">
              <Text variant="body-sm" tone="subdued">
                {t("products.form.dimensionsHelp")}
              </Text>
            </div>
          </FormLayout>
          <Stack direction="horizontal" gap={2}>
            <Button type="submit" loading={busy}>
              {t("products.form.save")}
            </Button>
          </Stack>
        </Stack>
      </Form>
    </details>
  );
}
