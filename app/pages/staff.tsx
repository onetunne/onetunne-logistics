import { Form, useActionData, useLoaderData, useNavigation, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { asc, eq } from "drizzle-orm";
import { staffMembers } from "~/db/schema";
import {
  DELEGABLE_PERMISSIONS,
  OWNER_ONLY_PERMISSIONS,
  STAFF_DEFAULT_PERMISSIONS,
  can,
  requirePermission,
  resolvePermissions,
  staffOverridesFromSelection,
  type Permission,
} from "~/domain/permissions";
import { useLocale, useT } from "~/i18n";
import { formatDateTime } from "~/lib/format";
import { DomainError } from "~/lib/errors";
import { writeAudit } from "~/modules/audit/audit.server";
import { ActionBanner, type ActionResult } from "~/components/action-banner";
import { getRequestContext } from "~/server/context.server";
import { formString, toActionError } from "~/server/http.server";
import { getEnv } from "~/lib/env.server";
import { Badge, Banner, Button, Card, Checkbox, Disclosure, InlineCode, Page, Select, Stack, Text, TextField } from "~/ui";

const UUID_RE = /^[0-9a-f-]{36}$/i;
/** Префікс полів прав у формі: perm.<дозвіл> (прапорець без value — браузер надсилає "on"). */
const PERMISSION_FIELD = "perm.";
/** Прихована ознака, що форма містить блок прав (інакше збережені права не змінюються). */
const PERMISSIONS_FORM_FIELD = "permissionsForm";

/** Діючі права працівника з урахуванням перевизначень (лише ті, що можна надати/зняти). */
function delegatedPermissions(overrides: { grant?: readonly string[]; revoke?: readonly string[] }): Permission[] {
  const effective = resolvePermissions("staff", overrides);
  return DELEGABLE_PERMISSIONS.filter((p) => effective.has(p));
}

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
      permissions: delegatedPermissions(m.permissionOverrides),
      customized: (m.permissionOverrides.grant?.length ?? 0) + (m.permissionOverrides.revoke?.length ?? 0),
    })),
    delegable: DELEGABLE_PERMISSIONS,
    staffDefaults: STAFF_DEFAULT_PERMISSIONS,
    ownerOnly: OWNER_ONLY_PERMISSIONS,
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
    // Окремі права — лише для ролі «Працівник» і лише з DELEGABLE_PERMISSIONS (перевіряє сервер; права лише власника —
    // відмова). Власнику перевизначення не потрібні: очищуються, щоб не діяли несподівано після зміни ролі.
    let permissionOverrides = member.permissionOverrides;
    if (role === "owner") {
      permissionOverrides = {};
    } else if (form.get(PERMISSIONS_FORM_FIELD) === "1") {
      const selected = [...new Set([...form.keys()].filter((k) => k.startsWith(PERMISSION_FIELD)).map((k) => k.slice(PERMISSION_FIELD.length)))];
      const parsed = staffOverridesFromSelection(selected);
      if (!parsed.ok) throw new DomainError("staff.error.ownerOnlyPermission", 400);
      permissionOverrides = parsed.overrides;
    }
    await ctx.db
      .update(staffMembers)
      .set({ role, active, displayName: displayName || member.displayName, permissionOverrides, updatedAt: new Date() })
      .where(eq(staffMembers.id, id));
    await writeAudit(ctx.db, ctx.actor, "staff.updated", { type: "staff", id }, {
      role,
      active,
      grant: [...(permissionOverrides.grant ?? [])],
      revoke: [...(permissionOverrides.revoke ?? [])],
    });
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
                    <input type="hidden" name={PERMISSIONS_FORM_FIELD} value="1" />
                    <Disclosure
                      summary={
                        m.customized > 0
                          ? `${t("staff.permissions.title")} · ${t("staff.permissions.customized", { count: m.customized })}`
                          : t("staff.permissions.title")
                      }
                    >
                      <Stack gap={2}>
                        <Text variant="body-sm" tone="subdued">
                          {m.role === "owner" || m.ownerByEnv ? t("staff.permissions.ownerNote") : t("staff.permissions.help")}
                        </Text>
                        {data.delegable.map((p) => (
                          <Checkbox
                            key={p}
                            id={`perm-${m.id}-${p}`}
                            name={`${PERMISSION_FIELD}${p}`}
                            label={
                              data.staffDefaults.includes(p) ? `${t(`permission.${p}`)} (${t("staff.permissions.default")})` : t(`permission.${p}`)
                            }
                            defaultChecked={m.permissions.includes(p)}
                          />
                        ))}
                        <Text variant="body-sm" tone="subdued">
                          {t("staff.permissions.ownerOnly", { list: data.ownerOnly.map((p) => t(`permission.${p}`)).join(", ") })}
                        </Text>
                      </Stack>
                    </Disclosure>
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
