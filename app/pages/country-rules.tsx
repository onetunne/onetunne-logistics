import { useLoaderData, type LoaderFunctionArgs } from "react-router";
import { requirePermission } from "~/domain/permissions";
import { useLocale, useT } from "~/i18n";
import { loadCountryRuleRows } from "~/modules/orders/repository.server";
import { getRequestContext } from "~/server/context.server";
import { Badge, Banner, Card, DataTable, InlineCode, Page, Stack, Text } from "~/ui";

/** Правила країн (лише перегляд; редагування — етап 4). Ці правила використовує перевірка даних. */
export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  try {
    requirePermission(ctx.actor, "orders.view");
  } catch {
    throw new Response("Forbidden", { status: 403 });
  }
  const rows = await loadCountryRuleRows(ctx.db);
  return {
    rules: rows.map((r) => ({
      countryCode: r.countryCode,
      nameUk: r.nameUk,
      nameEn: r.nameEn,
      shippingEnabled: r.shippingEnabled,
      postalCodeRequired: r.postalCodeRequired,
      postalCodeExample: r.postalCodeExample,
      provinceRequired: r.provinceRequired,
      phoneRequired: r.phoneRequired,
      dutyPayer: r.dutyPayer,
      notes: r.notes,
    })),
  };
}

type Rule = Awaited<ReturnType<typeof loader>>["rules"][number];

export default function CountryRulesPage() {
  const { rules } = useLoaderData<typeof loader>();
  const t = useT();
  const locale = useLocale();
  const yesNo = (v: boolean) => (v ? t("common.yes") : t("common.no"));
  return (
    <Page title={t("nav.countryRules")} subtitle={t("planned.countryRules.subtitle")}>
      <Stack gap={4}>
        <Banner tone="info">{t("planned.countryRules.readOnly")}</Banner>
        <Card padded={false}>
          <DataTable<Rule>
            caption={t("nav.countryRules")}
            rows={rules}
            rowKey={(r) => r.countryCode}
            columns={[
              {
                key: "country",
                header: t("planned.countryRules.country"),
                primary: true,
                render: (r) => (
                  <Stack gap={1} direction="horizontal" align="center" wrap>
                    <InlineCode>{r.countryCode}</InlineCode>
                    <span>{locale === "uk" ? r.nameUk : r.nameEn}</span>
                  </Stack>
                ),
              },
              {
                key: "shipping",
                header: t("planned.countryRules.shipping"),
                render: (r) =>
                  r.shippingEnabled ? (
                    <Badge tone="neutral">{t("planned.countryRules.enabled")}</Badge>
                  ) : (
                    <Badge tone="critical">{t("planned.countryRules.disabled")}</Badge>
                  ),
              },
              {
                key: "postal",
                header: t("planned.countryRules.postalCode"),
                render: (r) =>
                  r.postalCodeRequired ? (
                    <Text variant="body-sm">
                      {t("planned.countryRules.required")}
                      {r.postalCodeExample ? ` · ${r.postalCodeExample}` : ""}
                    </Text>
                  ) : (
                    <Text variant="body-sm" tone="subdued">
                      {r.postalCodeExample ? t("planned.countryRules.optional") : t("planned.countryRules.notUsed")}
                    </Text>
                  ),
              },
              { key: "province", header: t("planned.countryRules.province"), render: (r) => yesNo(r.provinceRequired), hideOnMobile: true },
              { key: "phone", header: t("planned.countryRules.phone"), render: (r) => yesNo(r.phoneRequired), hideOnMobile: true },
              {
                key: "duty",
                header: t("planned.countryRules.dutyPayer"),
                render: (r) => t(`planned.countryRules.duty.${r.dutyPayer}`),
              },
            ]}
          />
        </Card>
      </Stack>
    </Page>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";
