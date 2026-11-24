import { timingSafeEqual } from "node:crypto";
import { Form, redirect, useActionData, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { getEnv } from "~/lib/env.server";
import { demoAccessCookie } from "~/server/cookies.server";
import { formString, safeRedirectPath } from "~/server/http.server";
import { readPreferences } from "~/server/cookies.server";
import { makeT } from "~/i18n";
import { useT } from "~/i18n";
import { Banner, Button, Card, Stack, Text, TextField } from "~/ui";

export async function loader({ request }: LoaderFunctionArgs) {
  const env = getEnv();
  if (!env.DEMO_MODE) throw new Response("Not Found", { status: 404 });
  if (!env.DEMO_PASSWORD) throw redirect("/demo");
  return null;
}

const attempts = new Map<string, { count: number; until: number }>();

export async function action({ request }: ActionFunctionArgs) {
  const env = getEnv();
  if (!env.DEMO_MODE || !env.DEMO_PASSWORD) throw new Response("Not Found", { status: 404 });
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const now = Date.now();
  const state = attempts.get(ip);
  if (state && state.count >= 10 && state.until > now) return { error: "demo.login.tooMany" };
  const form = await request.formData();
  const given = Buffer.from(formString(form, "password"));
  const expected = Buffer.from(env.DEMO_PASSWORD);
  const ok = given.length === expected.length && timingSafeEqual(given, expected);
  if (!ok) {
    const next = { count: (state && state.until > now ? state.count : 0) + 1, until: now + 15 * 60_000 };
    attempts.set(ip, next);
    const { locale } = await readPreferences(request);
    return { error: makeT(locale)("demo.login.invalid") };
  }
  attempts.delete(ip);
  const next = safeRedirectPath(new URL(request.url).searchParams.get("next"), "/demo");
  return redirect(next.startsWith("/demo") ? next : "/demo", {
    headers: { "Set-Cookie": await demoAccessCookie().serialize("granted") },
  });
}

export default function DemoLogin() {
  const t = useT();
  const data = useActionData<typeof action>();
  return (
    <main className="ot-auth-page">
      <Card>
        <Form method="post">
          <Stack gap={4}>
            <Text as="h1" variant="heading-md">
              {t("app.name")}
            </Text>
            <Text tone="subdued">{t("demo.login.description")}</Text>
            {data?.error ? <Banner tone="critical">{t(data.error)}</Banner> : null}
            <TextField label={t("demo.login.password")} name="password" type="password" autoComplete="current-password" required />
            <Button variant="primary" type="submit" fullWidth>
              {t("demo.login.submit")}
            </Button>
          </Stack>
        </Form>
      </Card>
    </main>
  );
}
