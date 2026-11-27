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
  route("orders/:orderId/invoice", "pages/order-invoice.tsx", { id: `${prefix}-order-invoice` }),
  route("orders/:orderId/shipments/:shipmentId/documents/:kind", "pages/order-document.tsx", {
    id: `${prefix}-order-document`,
  }),
  route("products", "pages/products.tsx", { id: `${prefix}-products` }),
  route("problems", "pages/problems.tsx", { id: `${prefix}-problems` }),
  route("waybills", "pages/waybills.tsx", { id: `${prefix}-waybills` }),
  route("country-rules", "pages/country-rules.tsx", { id: `${prefix}-country-rules` }),
  route("settings", "pages/settings.tsx", { id: `${prefix}-settings` }),
  route("shopify", "pages/shopify-sync.tsx", { id: `${prefix}-shopify` }),
  route("staff", "pages/staff.tsx", { id: `${prefix}-staff` }),
  // Етап 5: склад, виробництво, комплектація/пакування.
  route("warehouse", "pages/warehouse.tsx", { id: `${prefix}-warehouse` }),
  route("warehouse/movements", "pages/warehouse-movements.tsx", { id: `${prefix}-warehouse-movements` }),
  route("warehouse/items/:stockItemId", "pages/warehouse-item.tsx", { id: `${prefix}-warehouse-item` }),
  route("production", "pages/production.tsx", { id: `${prefix}-production` }),
  route("production/:batchId", "pages/production-batch.tsx", { id: `${prefix}-production-batch` }),
  route("picking", "pages/picking.tsx", { id: `${prefix}-picking` }),
  route("picking/print", "pages/print-batch.tsx", { id: `${prefix}-picking-print` }),
  route("picking/labels", "pages/labels-batch.tsx", { id: `${prefix}-picking-labels` }),
  route("picking/handover", "pages/handover-list.tsx", { id: `${prefix}-picking-handover` }),
  route("picking/:orderId", "pages/packing-order.tsx", { id: `${prefix}-packing-order` }),
  route("warehouse/materials", "pages/materials.tsx", { id: `${prefix}-materials` }),
  route("warehouse/kits", "pages/kits.tsx", { id: `${prefix}-kits` }),
  route("warehouse/shopify", "pages/inventory-sync.tsx", { id: `${prefix}-inventory-sync` }),
  route("warehouse/analytics", "pages/warehouse-analytics.tsx", { id: `${prefix}-warehouse-analytics` }),
  route("warehouse/export", "pages/warehouse-export.tsx", { id: `${prefix}-warehouse-export` }),
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
  route("carrier-service/:token", "routes/carrier-service.tsx"),
  route("preferences", "routes/preferences.tsx"),
  route("healthz", "routes/healthz.tsx"),
] satisfies RouteConfig;
