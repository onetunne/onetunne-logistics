import type { Db } from "~/db/client.server";
import type { Actor } from "~/domain/permissions";
import type { CarrierRegistry } from "~/integrations/carriers/types";
import type { ShopifyGateway } from "~/integrations/shopify/types";
import type { Locale } from "~/i18n/types";

export type AppMode = "demo" | "production";

/** Контекст запиту, який отримують усі сервіси. Бізнес-логіка не залежить від React/HTTP. */
export interface ServiceContext {
  mode: AppMode;
  db: Db;
  actor: Actor;
  carriers: CarrierRegistry;
  shopify: ShopifyGateway;
  now: () => Date;
}

export interface RequestContext extends ServiceContext {
  basePath: "/demo" | "/app";
  locale: Locale;
}
