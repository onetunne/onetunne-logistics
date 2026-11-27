/**
 * Чернетка запиту відсутніх даних у клієнта (етап 4, підготовка до автовідповідача).
 * Нічого не надсилає й не журналює: менеджер копіює текст і надсилає клієнту сам.
 * Текст формується на сервері лише з шаблонів і номера замовлення (modules/customer-requests).
 */
import { useState } from "react";
import { hasKey, useT } from "~/i18n";
import { Button, Card, Select, Stack, Text, TextField } from "~/ui";

export interface CustomerRequestDraftView {
  text: string;
  fields: string[];
}

export function CustomerRequestPanel({
  drafts,
  defaultLocale,
}: {
  drafts: { uk: CustomerRequestDraftView | null; en: CustomerRequestDraftView | null };
  defaultLocale: "uk" | "en";
}) {
  const t = useT();
  const [locale, setLocale] = useState<"uk" | "en">(defaultLocale);
  const [copied, setCopied] = useState(false);
  const draft = drafts[locale];
  if (!drafts.uk && !drafts.en) return null;
  const fieldLabel = (f: string) => (hasKey(`field.${f}`) ? t(`field.${f}`) : f);
  return (
    <Card title={t("customerRequest.panel.title")} description={t("customerRequest.panel.hint")}>
      <Stack gap={3}>
        <Select
          label={t("customerRequest.panel.language")}
          name="customerRequestLocale"
          value={locale}
          onChange={(e) => {
            setLocale(e.currentTarget.value === "uk" ? "uk" : "en");
            setCopied(false);
          }}
          options={[
            { value: "en", label: "English" },
            { value: "uk", label: "Українська" },
          ]}
        />
        {draft ? (
          <>
            <Text variant="body-sm" tone="subdued">
              {t("customerRequest.panel.fields")}: {[...new Set(draft.fields)].map(fieldLabel).join(", ")}
            </Text>
            <TextField
              label={t("customerRequest.panel.title")}
              labelHidden
              name="customerRequestText"
              multiline={10}
              readOnly
              value={draft.text}
            />
            <Stack direction="horizontal" gap={2} align="center">
              <Button
                onClick={() => {
                  void navigator.clipboard?.writeText(draft.text).then(() => setCopied(true));
                }}
              >
                {t("customerRequest.panel.copy")}
              </Button>
              {copied ? <Text tone="subdued">{t("customerRequest.panel.copied")}</Text> : null}
            </Stack>
          </>
        ) : (
          <Text tone="subdued">{t("customerRequest.panel.none")}</Text>
        )}
      </Stack>
    </Card>
  );
}
