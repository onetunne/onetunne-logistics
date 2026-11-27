/**
 * GraphQL Admin API 2026-10: залишки (етап 5, синхронізація складу з Shopify).
 * Звірено з документацією shopify.dev (docs/research/stage5/shopify-inventory-mutations.md, -quantities.md, -webhooks.md;
 * сторінки queries/locations, queries/nodes, objects/InventoryItem, objects/InventoryLevel, mutations/inventoryAdjustQuantities):
 * - inventoryAdjustQuantities(input: InventoryAdjustQuantitiesInput!) — дельта; від 2026-04 ОБОВ'ЯЗКОВІ директива
 *   `@idempotent(key:)` (ключ живе 24 год) і поле `changeFromQuantity` у кожній зміні (число або явний null);
 *   name "available" — без ledgerDocumentUri; reason — лише задокументовані значення (SHOPIFY_ADJUST_REASONS);
 *   referenceDocumentUri — необов'язковий URI (у застосунку — посилання на рух/розбіжність, не gid://shopify).
 *   Потрібен дозвіл write_inventory (+ право працівника «apply changes to inventory quantities»).
 * - InventoryItem.inventoryLevel(locationId: ID!) → InventoryLevel.quantities(names: [String!]!) — читання станів
 *   (read_inventory). Неактивний рівень без includeInactive повертає null.
 * - locations(first, sortKey: CREATED_AT) — лише активні локації (без локацій fulfillment-сервісів за замовчуванням).
 *   Поля «основна локація» магазину в 2026-10 немає — застосунок обирає лише однозначну (єдину) локацію.
 * - nodes(ids:) — пакетне читання кількох InventoryItem (масиви вводу — до 250 елементів).
 *
 * Вартість запиту (rate-limits: об'єкт — 1, з'єднання — 2 + first; ліміт одного запиту — 1000 балів, перевіряється ДО
 * виконання): RECONCILE_PAGE_SIZE предметів × (InventoryItem 1 + InventoryLevel 1 + до 3 InventoryQuantity) ≈ 250 балів;
 * мутація — 10 балів. Помилка THROTTLED → повтор завдання пізніше (ShopifyApiError.retryable).
 */

export const SHOPIFY_INVENTORY_QUANTITY = "available" as const;

/** Задокументовані значення reason (InventoryAdjustQuantitiesInput.reason, «possible reasons»). Інше → INVALID_REASON. */
export const SHOPIFY_ADJUST_REASONS = [
  "correction",
  "cycle_count_available",
  "damaged",
  "movement_created",
  "movement_updated",
  "movement_received",
  "movement_canceled",
  "other",
  "promotion",
  "quality_control",
  "received",
  "reservation_created",
  "reservation_deleted",
  "reservation_updated",
  "restock",
  "safety_stock",
  "shrinkage",
] as const;
export type ShopifyAdjustReason = (typeof SHOPIFY_ADJUST_REASONS)[number];

/** Коди InventoryAdjustQuantitiesUserErrorCode (2026-10), які застосунок розрізняє. */
export const ADJUST_ERROR = {
  concurrent: "IDEMPOTENCY_CONCURRENT_REQUEST",
  previousFailed: "IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED",
  paramMismatch: "IDEMPOTENCY_KEY_PARAMETER_MISMATCH",
  stale: "CHANGE_FROM_QUANTITY_STALE",
  tryAgain: "ADJUST_QUANTITIES_FAILED",
  unavailable: "SERVICE_UNAVAILABLE",
} as const;

export const INVENTORY_ADJUST_MUTATION = `#graphql
  mutation OtInventoryAdjust($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
    inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryAdjustmentGroup { id createdAt reason referenceDocumentUri changes { name delta } }
      userErrors { field message code }
    }
  }`;

/** Локації магазину (найстаріші першими). Більше LOCATIONS_PAGE_SIZE — вважається неоднозначним вибором. */
export const LOCATIONS_PAGE_SIZE = 20;
export const LOCATIONS_QUERY = `#graphql
  query OtLocations {
    locations(first: ${LOCATIONS_PAGE_SIZE}, sortKey: CREATED_AT) {
      pageInfo { hasNextPage }
      nodes { id name isActive isFulfillmentService fulfillsOnlineOrders }
    }
  }`;

/** Предметів на одну сторінку звірки (≈ 250 балів вартості, див. вище). */
export const RECONCILE_PAGE_SIZE = 50;
export const RECONCILE_QUANTITY_NAMES = ["available", "on_hand", "committed"] as const;

export const INVENTORY_LEVELS_QUERY = `#graphql
  query OtInventoryLevels($ids: [ID!]!, $locationId: ID!) {
    nodes(ids: $ids) {
      ... on InventoryItem {
        id
        tracked
        inventoryLevel(locationId: $locationId) {
          id
          quantities(names: ["available", "on_hand", "committed"]) { name quantity }
        }
      }
    }
  }`;

// --- Типи (лише запитувані поля) ---

export interface GqlAdjustUserError {
  field: string[] | null;
  message: string;
  code: string | null;
}

export interface GqlInventoryAdjustResult {
  inventoryAdjustQuantities: {
    inventoryAdjustmentGroup: {
      id: string;
      createdAt: string;
      reason: string;
      referenceDocumentUri: string | null;
      changes: Array<{ name: string; delta: number }>;
    } | null;
    userErrors: GqlAdjustUserError[];
  } | null;
}

export interface GqlLocation {
  id: string;
  name: string;
  isActive: boolean;
  isFulfillmentService: boolean;
  fulfillsOnlineOrders: boolean;
}

export interface GqlLocationsResult {
  locations: { pageInfo: { hasNextPage: boolean }; nodes: GqlLocation[] };
}

export interface GqlInventoryItemLevel {
  id: string;
  tracked: boolean;
  inventoryLevel: { id: string; quantities: Array<{ name: string; quantity: number }> } | null;
}

/** nodes(ids:) повертає null для невідомого id; інші типи вузлів — без полів InventoryItem. */
export interface GqlInventoryLevelsResult {
  nodes: Array<GqlInventoryItemLevel | Record<string, never> | null>;
}

/** Вхід мутації. Порядок полів сталий: Shopify враховує порядок параметрів у відбитку ключа ідемпотентності. */
export interface InventoryAdjustInput {
  name: typeof SHOPIFY_INVENTORY_QUANTITY;
  reason: ShopifyAdjustReason;
  referenceDocumentUri?: string;
  changes: Array<{ inventoryItemId: string; locationId: string; delta: number; changeFromQuantity: number | null }>;
}

export function buildAdjustInput(p: {
  reason: ShopifyAdjustReason;
  referenceDocumentUri: string | null;
  inventoryItemId: string;
  locationId: string;
  delta: number;
  /** null — без порівняння (дельти комутативні); число — CAS: зміна лише якщо поточне значення саме таке. */
  changeFromQuantity: number | null;
}): InventoryAdjustInput {
  const changes = [
    { inventoryItemId: p.inventoryItemId, locationId: p.locationId, delta: p.delta, changeFromQuantity: p.changeFromQuantity },
  ];
  return p.referenceDocumentUri
    ? { name: SHOPIFY_INVENTORY_QUANTITY, reason: p.reason, referenceDocumentUri: p.referenceDocumentUri, changes }
    : { name: SHOPIFY_INVENTORY_QUANTITY, reason: p.reason, changes };
}

export interface ShopifyLevelQuantities {
  available: number;
  onHand: number;
  committed: number;
}

/** Кількості рівня; null — якщо Shopify не повернув усіх трьох станів. */
export function quantitiesOf(level: GqlInventoryItemLevel["inventoryLevel"]): ShopifyLevelQuantities | null {
  if (!level) return null;
  const by = new Map(level.quantities.map((q) => [q.name, q.quantity]));
  const available = by.get("available");
  const onHand = by.get("on_hand");
  const committed = by.get("committed");
  if (typeof available !== "number" || typeof onHand !== "number" || typeof committed !== "number") return null;
  return { available, onHand, committed };
}

export function isInventoryItemNode(node: GqlInventoryLevelsResult["nodes"][number]): node is GqlInventoryItemLevel {
  return Boolean(node && typeof (node as { id?: unknown }).id === "string" && "inventoryLevel" in node);
}
