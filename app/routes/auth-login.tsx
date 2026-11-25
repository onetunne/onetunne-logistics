import { Form, useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { getEnv } from "~/lib/env.server";
import { useT } from "~/i18n";
import { Button, Card, Stack, Text, TextField } from "~/ui";

/** Вхід за доменом магазину (для відкриття поза Shopify Admin). */
async function login(request: Request) {
  if (!getEnv().shopifyConfigured) throw new Response("Shopify is not configured", { status: 503 });
  const { getShopify } = await import("~/shopify.server");
  return (await getShopify()).login(request);
}

export async function loader({ request }: LoaderFunctionArgs) {
  const errors = await login(request);
  return { errors: errors ?? {} };
}

export async function action({ request }: ActionFunctionArgs) {
  const errors = await login(request);
  return { errors: errors ?? {} };
}

export default function AuthLogin() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors = (actionData ?? loaderData).errors as { shop?: string };
  const t = useT();
  return (
    <main className="ot-auth-page">
      <Card>
        <Form method="post">
          <Stack gap={4}>
            <Text as="h1" variant="heading-md">
              {t("app.name")}
            </Text>
            <Text tone="subdued">{t("auth.login.title")}</Text>
            <TextField
              label={t("auth.login.shop")}
              name="shop"
              helpText={t("auth.login.help")}
              autoComplete="on"
              error={errors.shop ? t("auth.login.invalid") : null}
            />
            <Button variant="primary" type="submit" fullWidth>
              {t("auth.login.submit")}
            </Button>
          </Stack>
        </Form>
      </Card>
    </main>
  );
}
