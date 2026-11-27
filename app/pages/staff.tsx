import { Form, useActionData, useLoaderData, useNavigation, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { asc, eq } from "drizzle-orm";
import { staffMembers } from "~/db/schema";
import { can, requirePermission } from "~/domain/permissions";
import { useLocale, useT } from "~/i18n";
import { formatDateTime } from "~/lib/format";
import { DomainError } from "~/lib/errors";
import { writeAudit } from "~/modules/audit/audit.server";
import { ActionBanner, type ActionResult } from "~/components/action-banner";
import { getRequestContext } from "~/server/context.server";
import { formString, toActionError } from "~/server/http.server";
import { getEnv } from "~/lib/env.server";
import { Badge, Banner, Button, Card, Checkbox, InlineCode, Page, Select, Stack, Text, TextField } from "~/ui";

const UUID_RE = /^[0-9a-f-]{36}$/i;

/** Працівники: кожен бачить свій Shopify User ID; керує ролями лише власник. */
export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  const manage = can(ctx.actor, "staff.manage");
  const members = manage ? await ctx.db.select().from(staffMembers).orderBy(asc(staffMembers.createdAt)) : [];
  const ownerIds = [...getEnv().ownerShopifyUserIds];
  return {
    mode: ctx.mode,
    me: { id: ctx.actor.id.replace(/^shopify:/, ""), role: ctx.actor.role },
    manage,
    members: members.map((m) => ({
      id: m.id,
      shopifyUserId: m.shopifyUserId,
      displayName: m.displayName,
      role: m.role,
      active: m.active,
      lastSeenAt: m.lastSeenAt,
      ownerByEnv: Boolean(m.shopifyUserId && ownerIds.includes(m.shopifyUserId)),
    })),
  };
}

export async function action({ request }: ActionFunctionArgs): Promise<ActionResult> {
  const ctx = await getRequestContext(request);
  try {
    requirePermission(ctx.actor, "staff.manage");
    const form = await request.formData();
    const id = formString(form, "memberId");
    if (!UUID_RE.test(id)) throw new DomainError("error.notFound", 404);
    const role = formString(form, "role") === "owner" ? "owner" : "staff";
    const displayName = formString(form, "displayName").trim().slice(0, 80);
    const active = form.has("active");
    const [member] = await ctx.db.select().from(staffMembers).where(eq(staffMembers.id, id));
    if (!member) throw new DomainError("error.notFound", 404);
    if (`shopify:${member.shopifyUserId}` === ctx.actor.id && (!active || role !== "owner")) {
      throw new DomainError("staff.cannotDemoteSelf", 409);
    }
    await ctx.db
      .update(staffMembers)
      .set({ role, active, displayName: displayName || member.displayName, updatedAt: new Date() })
      .where(eq(staffMembers.id, id));
    await writeAudit(ctx.db, ctx.actor, "staff.updated", { type: "staff", id }, { role, active });
    return { ok: true, message: "staff.saved" };
  } catch (e) {
    return toActionError(e);
  }
}

export default function StaffPage() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const t = useT();
  const locale = useLocale();
  const busy = useNavigation().state !== "idle";
  return (
    <Page title={t("nav.staff")} subtitle={t("staff.subtitle")}>
      <Stack gap={4}>
        <ActionBanner data={result} />
        {data.mode === "demo" ? <Banner tone="info">{t("staff.demo")}</Banner> : null}
        <Card title={t("staff.me.title")}>
          <Stack gap={2}>
            <Text>
              {t("staff.me.id")} <InlineCode>{data.me.id}</InlineCode>
            </Text>
            <Text tone="subdued">{t(`role.${data.me.role}`)}</Text>
            <Text variant="body-sm" tone="subdued">{t("staff.me.help")}</Text>
          </Stack>
        </Card>
        {data.manage ? (
          <Card title={t("staff.list.title")} description={t("staff.list.help")}>
            <Stack gap={4}>
              {data.members.length === 0 ? <Text tone="subdued">{t("staff.list.empty")}</Text> : null}
              {data.members.map((m) => (
                <Form method="post" key={m.id}>
                  <input type="hidden" name="memberId" value={m.id} />
                  <Stack gap={2}>
                    <Stack direction="horizontal" gap={2} wrap align="center">
                      <InlineCode>{m.shopifyUserId ?? "—"}</InlineCode>
                      {m.ownerByEnv ? <Badge tone="strong">{t("staff.ownerByEnv")}</Badge> : null}
                      {!m.active ? <Badge tone="critical">{t("staff.inactive")}</Badge> : null}
                      <Text variant="caption" tone="subdued">
                        {t("staff.lastSeen", { time: formatDateTime(m.lastSeenAt, locale) })}
                      </Text>
                    </Stack>
                    <TextField label={t("staff.displayName")} name="displayName" defaultValue={m.displayName} maxLength={80} />
                    <Select
                      label={t("staff.role")}
                      name="role"
                      defaultValue={m.role}
                      options={[
                        { value: "staff", label: t("role.staff") },
                        { value: "owner", label: t("role.owner") },
                      ]}
                    />
                    <Checkbox label={t("staff.active")} name="active" defaultChecked={m.active} />
                    <div>
                      <Button type="submit" loading={busy}>
                        {t("common.save")}
                      </Button>
                    </div>
                  </Stack>
                </Form>
              ))}
            </Stack>
          </Card>
        ) : null}
      </Stack>
    </Page>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";
