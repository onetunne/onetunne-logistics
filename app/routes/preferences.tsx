import { redirect, type ActionFunctionArgs } from "react-router";
import { isLocale } from "~/i18n/types";
import { demoRoleCookie, isRole, isTheme, localeCookie, themeCookie } from "~/server/cookies.server";
import { formString, isSameOrigin, safeRedirectPath } from "~/server/http.server";

/** Особисті налаштування (мова, тема) і вибір ролі в демо. */
export async function action({ request }: ActionFunctionArgs) {
  if (!isSameOrigin(request)) return new Response("Forbidden", { status: 403 });
  const form = await request.formData();
  const intent = formString(form, "intent");
  const value = formString(form, "value");
  const back = safeRedirectPath(formString(form, "redirectTo"), "/");
  const headers = new Headers();
  if (intent === "locale" && isLocale(value)) headers.append("Set-Cookie", await localeCookie.serialize(value));
  else if (intent === "theme" && isTheme(value)) headers.append("Set-Cookie", await themeCookie.serialize(value));
  else if (intent === "demoRole" && isRole(value) && back.startsWith("/demo")) {
    // Роль діє лише в демо-маршрутах; /app завжди визначає роль через Shopify.
    headers.append("Set-Cookie", await demoRoleCookie.serialize(value));
  } else return new Response("Bad Request", { status: 400 });
  return redirect(back, { headers });
}

export function loader() {
  return redirect("/");
}
