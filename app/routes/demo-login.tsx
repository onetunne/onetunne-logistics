import { timingSafeEqual, createHash } from "node:crypto";
import { Form, redirect, useActionData, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { getEnv } from "~/lib/env.server";
import { demoAccessCookie, demoAccessToken, isHttpsRequest, readPreferences } from "~/server/cookies.server";
import { formString, safeRedirectPath } from "~/server/http.server";
import { makeT, useT } from "~/i18n";
import { Banner, Button, Card, Stack, Text, TextField } from "~/ui";

export async function loader(_: LoaderFunctionArgs) {
  const env = getEnv();
  if (!env.DEMO_MODE) throw new Response("Not Found", { status: 404 });
  if (!env.DEMO_PASSWORD) throw redirect("/demo");
  return null;
}

/**
 * Обмеження спроб: 10 невдалих спроб на IP за 15 хв + загальний ліміт 100 спроб за 15 хв
 * (захист від підбору з підробленими IP). IP — від сервера (trust proxy), не з заголовків клієнта.
 */
const WINDOW_MS = 15 * 60_000;
const PER_IP_LIMIT = 10;
const GLOBAL_LIMIT = 100;
const MAX_TRACKED = 1000;
const attempts = new Map<string, { count: number; until: number }>();
let global = { count: 0, until: 0 };

function clientIp(context: unknown): string {
  const ip = (context as { clientIp?: unknown } | undefined)?.clientIp;
  return typeof ip === "string" && ip ? ip : "unknown";
}

function sweep(now: number) {
  if (attempts.size < MAX_TRACKED) return;
  for (const [k, v] of attempts) if (v.until <= now) attempts.delete(k);
  if (attempts.size >= MAX_TRACKED) attempts.clear();
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getEnv();
  if (!env.DEMO_MODE || !env.DEMO_PASSWORD) throw new Response("Not Found", { status: 404 });
  const { locale } = await readPreferences(request);
  const t = makeT(locale);
  const now = Date.now();
  const ip = clientIp(context);
  const state = attempts.get(ip);
  if (global.until <= now) global = { count: 0, until: now + WINDOW_MS };
  if ((state && state.until > now && state.count >= PER_IP_LIMIT) || global.count >= GLOBAL_LIMIT) {
    return { error: t("demo.login.tooMany") };
  }
  const form = await request.formData();
  // Порівняння хешів однакової довжини — без витоку довжини пароля через час відповіді.
  const ok = timingSafeEqual(digest(formString(form, "password")), digest(env.DEMO_PASSWORD));
  if (!ok) {
    sweep(now);
    attempts.set(ip, { count: (state && state.until > now ? state.count : 0) + 1, until: now + WINDOW_MS });
    global.count++;
    return { error: t("demo.login.invalid") };
  }
  attempts.delete(ip);
  const next = safeRedirectPath(new URL(request.url).searchParams.get("next"), "/demo");
  return redirect(next.startsWith("/demo") ? next : "/demo", {
    headers: {
      "Set-Cookie": await demoAccessCookie().serialize(demoAccessToken(), { secure: isHttpsRequest(request) }),
    },
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
            {data?.error ? <Banner tone="critical">{data.error}</Banner> : null}
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
