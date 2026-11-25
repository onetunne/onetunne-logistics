import { index, route, type RouteConfig } from "@react-router/dev/routes";

/**
 * Ті самі сторінки монтуються двічі:
 * - /demo/* — автономна демонстрація (DEMO_MODE=true), без Shopify;
 * - /app/*  — вбудований застосунок у Shopify Admin (завжди authenticate.admin).
 */
const pages = (prefix: "demo" | "app") => [
  index("pages/dashboard.tsx", { id: `${prefix}-dashboard` }),
  route("orders", "pages/orders.tsx", { id: `${prefix}-orders` }),
  route("orders/:orderId", "pages/order-detail.tsx", { id: `${prefix}-order` }),
  route("problems", "pages/problems.tsx", { id: `${prefix}-problems` }),
  route("waybills", "pages/waybills.tsx", { id: `${prefix}-waybills` }),
  route("country-rules", "pages/country-rules.tsx", { id: `${prefix}-country-rules` }),
  route("settings", "pages/settings.tsx", { id: `${prefix}-settings` }),
  route("shopify", "pages/shopify-sync.tsx", { id: `${prefix}-shopify` }),
  route("staff", "pages/staff.tsx", { id: `${prefix}-staff` }),
  route(":section", "pages/planned.tsx", { id: `${prefix}-planned` }),
];

export default [
  index("routes/index.tsx"),
  route("demo/login", "routes/demo-login.tsx"),
  route("demo", "routes/demo-layout.tsx", pages("demo")),
  route("app", "routes/app-layout.tsx", pages("app")),
  route("auth/login", "routes/auth-login.tsx"),
  route("auth/*", "routes/auth-splat.tsx"),
  route("webhooks/shopify", "routes/webhooks.shopify.tsx"),
  route("webhooks/app/uninstalled", "routes/webhooks.app.uninstalled.tsx"),
  route("webhooks/app/scopes_update", "routes/webhooks.app.scopes_update.tsx"),
  route("preferences", "routes/preferences.tsx"),
  route("healthz", "routes/healthz.tsx"),
] satisfies RouteConfig;
