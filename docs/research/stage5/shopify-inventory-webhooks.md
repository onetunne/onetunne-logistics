# Shopify inventory webhooks, change attribution, fulfillment effect — fact sheet (Admin API 2026-10)

Retrieved 2026-11-27 from shopify.dev `.md` pages (front-matter of each page reports `api_version: 2026-10`).
help.shopify.com is blocked by the session proxy (HTTP 403 CONNECT), so Help Center pages were NOT consulted.
Legend: **[DOC]** = stated in docs (quoted/paraphrased closely); **[INFERENCE]** = my derivation from documented facts, not stated;
**NOT DOCUMENTED** = searched, not found.

Sources (abbreviations used below):
- [WH-REF] https://shopify.dev/docs/api/webhooks/latest.md (webhook topic list + sample payloads, "Headers")
- [ENUM] https://shopify.dev/docs/api/admin-graphql/latest/enums/WebhookSubscriptionTopic.md (identical to `/2026-10/`)
- [WH-ABOUT] https://shopify.dev/docs/apps/build/webhooks.md ("What to expect")
- [WH-VERIFY] https://shopify.dev/docs/apps/build/webhooks/verify-deliveries.md (old URL `/ignore-duplicates` redirects here)
- [WH-STRUCT] https://shopify.dev/docs/apps/build/webhooks/delivery-structure.md
- [WH-FILTER] https://shopify.dev/docs/apps/build/webhooks/delivery-filtering.md
- [WH-SUB] https://shopify.dev/docs/apps/build/webhooks/subscribe.md ("Subscription types")
- [WH-TROUBLE] https://shopify.dev/docs/apps/build/webhooks/troubleshoot.md
- [INV-APPS] https://shopify.dev/docs/apps/build/inventory-management-apps.md ("How it works", "Inventory states", "Webhooks", "Limitations")
- [INV-QS] https://shopify.dev/docs/apps/build/inventory-management-apps/manage-quantities-states.md
- [IAG] https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryAdjustmentGroup.md
- [ICHG] https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryChange.md
- [ILVL] https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryLevel.md
- [IQTY] https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryQuantity.md
- [IPROPS] https://shopify.dev/docs/api/admin-graphql/latest/queries/inventoryProperties.md
- [ADJ] https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventoryAdjustQuantities.md
- [SET] https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventorySetQuantities.md
- [IN-ADJ] https://shopify.dev/docs/api/admin-graphql/latest/input-objects/InventoryAdjustQuantitiesInput.md
- [IN-CHG] https://shopify.dev/docs/api/admin-graphql/latest/input-objects/InventoryChangeInput.md
- [IN-SET] https://shopify.dev/docs/api/admin-graphql/latest/input-objects/InventorySetQuantitiesInput.md
- [IDEM] https://shopify.dev/docs/apps/build/apis/graphql-admin/implementing-idempotency.md
- [FC] https://shopify.dev/docs/api/admin-graphql/latest/mutations/fulfillmentCreate.md
- [FUL] https://shopify.dev/docs/api/admin-graphql/latest/objects/Fulfillment.md (Mutations > fulfillmentCancel)
- [REST-IL] https://shopify.dev/docs/api/admin-rest/latest/resources/inventorylevel.md ("How an order affects inventory"; REST is legacy)
- [IITEMS] https://shopify.dev/docs/api/admin-graphql/latest/queries/inventoryItems.md
- [IITEM] https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryItem.md (field `inventoryLevels`)
- [LOC] https://shopify.dev/docs/api/admin-graphql/latest/objects/Location.md (field `inventoryLevels`)
- [EV] https://shopify.dev/docs/api/events/latest.md ; [EV-II] https://shopify.dev/docs/api/events/latest/inventory-item.md
- [EV-VS] https://shopify.dev/docs/apps/build/events-webhooks.md ; [VER] https://shopify.dev/docs/api/usage/versioning.md

---

## 1. Inventory-related webhook topics (2026-10)

| Topic | Description in docs | Scope | Source |
|---|---|---|---|
| `inventory_levels/update` (`INVENTORY_LEVELS_UPDATE`) | "Occurs whenever an inventory level is updated." | `read_inventory` | [ENUM] |
| `inventory_levels/connect` | "Occurs whenever an inventory level is connected." | `read_inventory` | [ENUM] |
| `inventory_levels/disconnect` | "Occurs whenever an inventory level is disconnected." | `read_inventory` | [ENUM] |
| `inventory_items/create` / `update` / `delete` | "Occurs whenever an inventory item is created / updated / deleted." | at least one of `read_inventory`, `read_products` | [ENUM] |
| `orders/fulfilled` | "Occurs whenever an order is fulfilled." | at least one of `read_orders`, `read_marketplace_orders` | [ENUM] |
| `orders/partially_fulfilled` | "Occurs whenever an order is partially fulfilled." | same as above | [ENUM] |
| `fulfillments/create` / `fulfillments/update` | "Occurs whenever a fulfillment is created / updated." | `read_fulfillments` or `read_marketplace_orders` | [ENUM] |
| `variants/in_stock` / `variants/out_of_stock` | "Occurs whenever a variant becomes in stock / out of stock. Online channels receive this webhook only when the variant becomes in stock [out of stock] online." | `read_products` | [ENUM] |
| `products/update` | "Occurs whenever a product is updated, ordered, or variants are added, removed or updated." | `read_products` | [ENUM] |
| `inventory_transfers/*` | `add_items`, `cancel`, `complete`, `ready_to_ship`, `remove_items`, `update_item_quantities`, `updated` (note: `updated`, not `update`; "Re-fetch the transfer to get the latest state") | `read_inventory_transfers` | [ENUM] |
| `inventory_shipments/*` | `add_items`, `create`, `delete`, `mark_in_transit`, `receive_items`, `remove_items`, `update_item_quantities`, `update_tracking` | `read_inventory_shipments` (`receive_items`: `read_inventory_shipments_received_items`) | [ENUM] |

[INV-APPS "Webhooks"] lists the six inventory topics (`inventory_items/create|update|delete`, `inventory_levels/connect|disconnect|update`) and refers to the `InventoryItem` / `InventoryLevel` reference for payloads.

## 2. Payloads

### 2.1 `inventory_levels/update` — [WH-REF sample payload]
```json
{ "inventory_item_id": 271878346596884015, "location_id": 24826418, "available": 10,
  "updated_at": "2021-12-31T19:00:00-05:00",
  "admin_graphql_api_id": "gid://shopify/InventoryLevel/24826418?inventory_item_id=271878346596884015" }
```
- Fields: `inventory_item_id`, `location_id`, `available`, `updated_at`, `admin_graphql_api_id` — nothing else. [WH-REF]
- `on_hand`, `committed`, `incoming`, `reserved`, `damaged`, `safety_stock`, `quality_control`: **NOT in the payload** (not present in sample; the REST InventoryLevel resource, which is the payload shape per [WH-STRUCT] "By default, the payload contains the full REST resource", has only `available`, `inventory_item_id`, `location_id`, `updated_at`). [WH-REF], [WH-STRUCT], [REST-IL "The InventoryLevel resource"]
- REST `available`: "Returns `null` if the inventory item is not tracked." [REST-IL Properties]
- No actor/app/staff/reason/referenceDocumentUri field in the payload. [WH-REF] (absence in sample + REST resource)
- `inventory_levels/connect` payload = same five fields as update. `inventory_levels/disconnect` payload = only `inventory_item_id`, `location_id`. [WH-REF]

### 2.2 `inventory_items/update` (create identical) — [WH-REF]
Fields: `id`, `sku`, `created_at`, `updated_at`, `requires_shipping`, `cost`, `country_code_of_origin`, `province_code_of_origin`,
`harmonized_system_code`, `tracked`, `country_harmonized_system_codes`, `weight_value`, `weight_unit`, `admin_graphql_api_id`. No quantities.
`inventory_items/delete`: `id`, origin/HS fields, `admin_graphql_api_id`.

### 2.3 `orders/fulfilled` — [WH-REF]
Full REST Order resource (top-level keys include `id`, `admin_graphql_api_id`, `fulfillment_status`, `financial_status`, `updated_at`,
`location_id`, `line_items[]` (with `fulfillable_quantity`, `fulfillment_status`, `fulfillment_service`, `sku`, `variant_inventory_management`, ...),
`fulfillments[]`, `refunds[]`, `shipping_address`, `customer`, ...). The published sample is a generic order sample (`fulfillment_status: null`, `fulfillments: []`), i.e. sample values are not representative of a fulfilled order.
Contains personal data (customer, addresses) → needs Protected Customer Data access for `read_orders` [apps/build/webhooks/get-started.md, step on scopes].

### 2.4 `fulfillments/create` — [WH-REF]
Top-level: `id`, `order_id`, `status`, `created_at`, `service`, `updated_at`, `tracking_company`, `shipment_status`, `location_id`, `origin_address`,
`email`, `destination`, `line_items`, `tracking_number(s)`, `tracking_url(s)`, `receipt`, `name`, `admin_graphql_api_id`.

## 3. Which quantity changes fire webhooks

- **[DOC]** "Changes to `committed`, `reserved`, `damaged`, `safety_stock`, and `quality_control` inventory states don't trigger webhooks." [INV-APPS "Webhooks" note]
- Whether changes to `incoming` (alone) trigger `inventory_levels/update`: **NOT DOCUMENTED** (it is not in the exclusion list, but no positive statement).
- Whether an `on_hand` change that does not change `available` triggers it: **NOT DOCUMENTED**.
- **[INFERENCE, corrected by verifier]** Fulfilling an order decrements `committed` (see §7), which by the documented sum also lowers `on_hand`. The exclusion note covers the `committed` change, but `on_hand` is not on the exclusion list, so whether fulfillment fires `inventory_levels/update` is **NOT DOCUMENTED** (the docs neither confirm nor rule it out). Even if a delivery comes, the payload carries only `available`, which fulfillment does not change. So `inventory_levels/update` cannot be relied on to observe `on_hand` decreases caused by fulfillment; re-read `InventoryLevel.quantities(names:["on_hand","committed",...])` instead.
- **[INFERENCE]** Order placement decrements `available` (see §7) → is a change to a state not on the exclusion list; whether it fires `inventory_levels/update` is not explicitly stated.

## 4. Do webhooks fire for the app's own mutations?

- **NOT DOCUMENTED.** No statement found in [WH-ABOUT], [WH-VERIFY], [WH-STRUCT], [WH-FILTER], [WH-SUB], [WH-TROUBLE], [INV-APPS], [INV-QS], webhooks get-started, React Router webhooks guide, or the Events docs about suppressing or excluding deliveries caused by the subscribing app. No "exclude own app" filter option is documented ([WH-FILTER] filters evaluate payload fields only; the inventory payload has no app field).
- Topic descriptions are unconditional ("Occurs whenever an inventory level is updated") [ENUM].
- **[INFERENCE]** Design must assume own `inventorySetQuantities`/`inventoryAdjustQuantities` calls may echo back as `inventory_levels/update`, and must not treat them as foreign changes (match by item+location+resulting `available` and time, or re-read).

## 5. Delivery guarantees

- **Ordering: none.** "Shopify doesn't guarantee ordering within a topic, or across different topics for the same resource." Recommends ordering by `X-Shopify-Triggered-At` header or payload `updated_at`. [WH-ABOUT "Ordering event data"]
- **Delivery not guaranteed**: "Webhook delivery isn't always guaranteed" → use periodic reconciliation jobs; many GraphQL queries support `updated_at` filters. [WH-ABOUT "Implement reconciliation jobs"]
- **Duplicates possible**: "Shopify minimizes duplicate deliveries, but your app might receive the same webhook more than once, for example after a network timeout or a retry." Process idempotently or dedupe on `X-Shopify-Webhook-Id` (persist ID; if seen, return success). [WH-VERIFY "Ignoring duplicates"]
- Multiple subscriptions to the same topic → one delivery each, different `X-Shopify-Webhook-Id`, same `X-Shopify-Event-Id`; Event-Id correlates "deliveries that originated from the same merchant action". [WH-VERIFY note], [WH-REF "Headers"]
- **Timeouts**: 1 s connect, 5 s total; non-2xx (incl. 3xx) = failure. [WH-VERIFY "Respond with a 200 OK quickly"]
- **Retries**: 8 times over 4 hours with increasing interval; after 8 consecutive failures an Admin-API (shop-specific) subscription is deleted; app-specific (`shopify.app.toml`) subscriptions are **not** deleted. [WH-VERIFY "Retries and failures"], [WH-SUB "Subscription types"], [WH-TROUBLE]
- **Delays**: "If receiving webhooks up to a day late might cause issues in your app, then compare the timestamp of the webhook to the current date and time." [WH-TROUBLE "Manage delays"]
- **Debouncing**: with `include_fields`, identical payloads within a short window are dropped; include `updated_at` to prevent. [WH-STRUCT "Debouncing"]
- **Filter evaluation**: "Shopify evaluates the expression against the payload after the event occurs, using current field values at the time of delivery." [WH-FILTER "Filters"]. Whether the *payload itself* is a snapshot at event time or current-at-delivery: **NOT DOCUMENTED**.
- Headers: `X-Shopify-Topic`, `X-Shopify-Hmac-Sha256`, `X-Shopify-Shop-Domain`, `X-Shopify-API-Version`, `X-Shopify-Webhook-Id`, `X-Shopify-Triggered-At`, `X-Shopify-Event-Id`, optional `X-Shopify-Name`. Names case-insensitive. [WH-REF "Headers"], [WH-STRUCT]
- Webhook payloads are versioned like API responses; "Shopify falls forward when your selected version becomes inaccessible", and `X-Shopify-Api-Version` confirms the version used. [VER table]. For app-specific subscriptions, `[webhooks] api_version` in `shopify.app.toml` sets the payload version; for shop-specific (Admin API) subscriptions the request URL version does. [WH-SUB]
- Another documented source of duplicates: having shop-specific and app-specific subscriptions to the same topic. When migrating, remove the shop-specific ones first "to avoid conflicts and duplicate notifications". [WH-SUB "Migrate to app-specific subscriptions"]

## 6. Change history and attribution (distinguishing own vs others' changes)

- `InventoryAdjustmentGroup` [IAG] — "Records a batch of inventory changes made together in a single operation. Tracks which App or StaffMember initiated the changes, when they occurred, and why." Fields: `app` (App, "The app that triggered the inventory event, if one exists"), `staffMember`, `changes(inventoryItemIds, locationIds, quantityNames): [InventoryChange!]!`, `createdAt`, `id`, `reason: String!`, `referenceDocumentUri: String`. Implements `Node`.
- **How to read history via API: effectively NOT DOCUMENTED / not available.** [IAG "Map": "No referencing types"]; it is returned only by `inventoryAdjustQuantities`, `inventoryMoveQuantities`, `inventorySetQuantities` ("Mutated by"; the page's Mutations list also shows the deprecated `inventorySetOnHandQuantities`). The object requires the `read_inventory` scope. `queries/inventoryAdjustmentGroup(s)` → HTTP 404 on shopify.dev (re-checked 2026-11-27). No field on InventoryLevel/InventoryItem/Location lists adjustment groups ([ILVL], [IITEM], [LOC]; no "adjustment" field found). **[INFERENCE]** Because it implements `Node`, it can presumably be re-fetched with `node(id:)` when the ID is already known, which in practice means only your own groups (from your mutation responses). Fetching it via `node` is not shown in any example. **Listing other apps'/staff/order-driven changes through the Admin API: NOT DOCUMENTED.**
- Where history is visible: `referenceDocumentUri` appears in the merchant-facing "Inventory adjustment history" page and in Analytics > Reports inventory adjustment reports; "Your app name appears directly in the Shopify admin inventory history". [INV-QS "Using referenceDocumentUri…/Where your URI appears"] (UI only.)
- `InventoryChange` [ICHG]: `delta: Int!`, `item`, `ledgerDocumentUri`, `location`, `name: String!` (quantity name), `quantityAfterChange: Int` (nullable; examples in [INV-QS] return `null`).
- `referenceDocumentUri` (on input of adjust/set/move) — "why the change happened"; optional; may be a Shopify GID (e.g. `gid://shopify/Order/…`); preferred format `gid://[namespace]/[entity]/[id]` (query params allowed); URLs and custom schemes also accepted; "Valid URI with scheme and content. For GID format, all components (app, entity, id) must be present." [IN-ADJ], [IN-SET], [INV-QS "Format specification"]. Docs advise against using `gid://shopify/App/<id>` as the reference ("Recommended: Use meaningful references"). [INV-QS "Migrating existing integrations"]
- `ledgerDocumentUri` (per change, adjust only) — "identifies the exact inventory movement in your system"; **required for every quantity name except `available`** (`INVALID_QUANTITY_DOCUMENT`); must be omitted for `available` (`INVALID_AVAILABLE_DOCUMENT`); cannot be `gid://shopify/…` (`INTERNAL_LEDGER_DOCUMENT`); all entries must share one value (`MAX_ONE_LEDGER_DOCUMENT`). [INV-QS "Adjust inventory quantities"], [IN-CHG]
- Valid `reason` values (set/adjust): `correction`, `cycle_count_available`, `damaged`, `movement_created`, `movement_updated`, `movement_received`, `movement_canceled`, `other`, `promotion`, `quality_control`, `received`, `reservation_created`, `reservation_deleted`, `reservation_updated`, `restock`, `safety_stock`, `shrinkage`. Response `reason` is a display string (e.g. "Inventory correction"). [INV-QS "Set inventory quantities on hand"]

## 7. Fulfillment / order effect on inventory

- **[DOC]** "Shopify decrements the available inventory quantity for product variants that are included in an order, and increments the committed inventory quantity for the order. After the order is fulfilled, Shopify decrements the committed inventory quantity." [INV-APPS "How it works"]
- **[DOC]** `on_hand` = `available` + `committed` + `reserved` + `damaged` + `safety_stock` + `quality_control`; `incoming` is not on hand. [INV-APPS "Inventory states"], [INV-QS "Set inventory quantities on hand"]
- **[INFERENCE]** Therefore fulfilling a tracked item decrements `on_hand` (via `committed`) automatically; the app must NOT also decrement on_hand in Shopify for the same shipment (double write-off). The docs do not state this specifically for `fulfillmentCreate` or for "merchant-managed locations".
- [FC] `fulfillmentCreate` reference: **no mention of inventory effects** (NOT DOCUMENTED there). Requires `write_assigned_fulfillment_orders` / `write_merchant_managed_fulfillment_orders` / `write_third_party_fulfillment_orders` and user permission `fulfill_and_ship_orders`.
- Location mismatch (legacy REST doc, still published for 2026-10): on order, Shopify "decrements the inventory level at the location that has the lowest ID" (POS orders: sale location); on fulfillment, if the fulfillment location differs, "Shopify decrements the inventory level at the fulfillment location and increments the inventory level at the original location." [REST-IL "How an order affects inventory"]. The REST page states this without version qualification; that it reflects an older model (before quantity states and order routing) is **[INFERENCE]**. The GraphQL guides do not restate the "lowest ID" rule or the location-swap behaviour (NOT DOCUMENTED there).
- `committed` cannot be adjusted or moved via the Admin API; managed by Shopify (orders, fulfillment, draft-order reservations, transfers/shipments ready to ship). [INV-APPS "Limitations"], [INV-QS "Step 3" note]
- `fulfillmentCancel`: creates new fulfillment orders for cancelled items. Effect on inventory quantities (restock of committed/on_hand): **NOT DOCUMENTED** in [FUL].
- Untracked items (`InventoryItem.tracked = false`): REST `available` is `null` [REST-IL]; behaviour on fulfillment: **NOT DOCUMENTED** beyond "When a product variant that Shopify tracks is included in an order, Shopify decrements the inventory" [REST-IL].

## 8. Writing quantities safely (relevant to conflict protection)

- Scopes: `inventoryAdjustQuantities` and `inventorySetQuantities` require `write_inventory`, and the user also needs permission to change inventory quantities ("apply changes to inventory quantities" / "update an inventory"). [ADJ], [SET]
- `inventorySetQuantities`: only `available` or `on_hand` [IN-SET]; as of 2026-04 every quantity must include `changeFromQuantity` (pass `null` explicitly to opt out; omitting = error); mismatch → `CHANGE_FROM_QUANTITY_STALE`. "Only use this mutation if calling on behalf of a system that acts as the source of truth" otherwise use adjust. [SET]
- `inventoryAdjustQuantities`: delta-based; `changeFromQuantity` "is mandatory: you must explicitly pass in a value, even if that value is `null`" (CAS on the named quantity). [IN-CHG]
- `@idempotent(key:)`: optional from 2026-01, **required from 2026-04** for adjust/set/move. [ADJ], [SET], [IAG]. Keys tracked **24 hours**; concurrent duplicate → `IDEMPOTENCY_CONCURRENT_REQUEST`; successful duplicate → cached response (built from current DB state, may differ); after 24 h treated as new operation; same key + different parameters → `IDEMPOTENCY_KEY_PARAMETER_MISMATCH`. Persist the key before sending, or derive deterministically (UUID v5). Directive syntax in examples: `@idempotent(key: $idempotencyKey)`. [IDEM], [ADJ], [SET]
- From 2026-04 quantity mutations on a not-stocked item can create an *inactive* InventoryLevel; item is not sellable there until `inventoryActivate`/`inventoryBulkToggleActivation`. [INV-QS "Step 3"]
- `inventorySetScheduledChanges` "isn't available in the 2026-07 Admin API"; `InventoryLevel.scheduledChanges` deprecated. [INV-QS "Schedule changes…" caution], [ILVL]. For 2026-10 the reference page https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/inventorySetScheduledChanges.md says "This API version is not supported."
- Quantity names in a shop: `inventoryProperties { quantityNames { name displayName belongsTo comprises isInUse } }`; sample: available, committed, damaged, incoming, on_hand, quality_control, reserved, safety_stock. [IPROPS]
- `InventoryQuantity` has `id: ID!`, `name: String!`, `quantity: Int!`, `updatedAt: DateTime` (nullable; per quantity name). [IQTY]

## 9. Reconciliation (pull) tools

- `InventoryItem.inventoryLevels(query:)` and `Location.inventoryLevels(query:)` accept filters `created_at`, `id`, `inventory_group_id`, `inventory_item_id`, `updated_at`; `includeInactive` default false. [IITEM], [LOC]
- `inventoryItems(query:)` filters: `created_at`, `id`, `sku`, `updated_at`. [IITEMS]. Whether InventoryItem `updated_at` changes when its level quantities change: **NOT DOCUMENTED**.
- Whether `InventoryLevel.updatedAt` changes on `committed`-only changes (e.g. fulfillment): **NOT DOCUMENTED**.

## 10. Events (alternative to webhooks)

- Events topic `InventoryItem` (scope `read_inventory`) has triggers `inventoryItem.inventoryLevel.quantities.quantity` (variables `inventoryItemId`, `inventoryLevelId`, `quantitiesName`), `inventoryItem.inventoryLevel.isActive`, `inventoryItem.tracked`, `inventoryItem.sku`, `inventoryItem.unitCost`, measurement/weight, etc.; payload = custom GraphQL `query` + `fields_changed` paths. No `InventoryLevel` topic (404). [EV-II], [EV]
- Whether quantity triggers fire for `committed` changes, or for the subscribing app's own changes: **NOT DOCUMENTED**. Events payloads always carry `topic`, `action`, `handle`, `fields_changed`, `query_variables` (+ `data`/`errors` with a `query`). Headers are `Shopify-Topic`, `-Action`, `-Handle`, `-Api-Version`, `-Webhook-Id`, `-Triggered-At`, `-Shop-Domain`, `-Hmac-Sha256`. There is no actor/app field in either. [EV "Delivery structure", "Headers"]
- The Events topic page also says: "Calculated fields, derived fields, auto-updated timestamps, and cross-domain fields aren't available as triggers." Whether this excludes `on_hand` (a derived sum) or `available` from the quantity trigger: **NOT DOCUMENTED**. [EV-II]
- Status conflict: [EV]/[EV-II] examples use `api_version = "2026-10"`, but [VER] versioning table says "Events is currently available in the `unstable` version and will follow Shopify's API versioning policy soon"; [WH-REF] example uses `[events] api_version = "unstable"`. Requires Shopify CLI ≥ 3.92, configured only in `shopify.app.toml`. [EV-VS], [apps/build/events/subscribe.md]
- Events dedupe header `Shopify-Webhook-Id`; duplicates possible. [apps/build/events/verify-deliveries.md]

## 11. Summary of gaps (NOT DOCUMENTED)
1. Whether webhooks/Events fire for the subscribing app's own mutations, and any way to exclude them.
2. Any Admin API query to list inventory adjustment history (other apps, staff, orders) — none found; history is UI/Analytics only.
3. Whether `incoming`-only or `on_hand`-only changes fire `inventory_levels/update`, including the fulfillment case (`committed`↓ and `on_hand`↓, `available` unchanged).
4. Inventory effect of `fulfillmentCreate` stated on the mutation itself; of `fulfillmentCancel` (restock).
5. Whether webhook payload values are event-time snapshots or delivery-time values.
6. Whether `InventoryLevel.updatedAt` / InventoryItem `updated_at` move on committed-only changes.
7. Help Center (help.shopify.com) content — not reachable from this environment.

## Verification notes

Independent re-check on 2026-11-27. All cited shopify.dev `.md` pages were re-downloaded (front-matter `api_version: 2026-10` where present; `/latest/` and `/2026-10/` WebhookSubscriptionTopic are byte-identical). Every claim was compared with the primary text.

**Confirmed verbatim or near-verbatim (no change needed):**
- Topic descriptions and scopes for `inventory_levels/update|connect|disconnect` (`read_inventory`), `inventory_items/*` (`read_inventory` or `read_products`), `orders/fulfilled|partially_fulfilled` (`read_orders` or `read_marketplace_orders`), `fulfillments/create|update` (`read_fulfillments` or `read_marketplace_orders`), `variants/in_stock|out_of_stock` and `products/update` (`read_products`). [ENUM]
- Sample payloads: `inventory_levels/update` and `connect` have exactly `inventory_item_id`, `location_id`, `available`, `updated_at`, `admin_graphql_api_id`. `disconnect` has only `inventory_item_id` and `location_id`. `inventory_items/create|update|delete` field lists are as stated. The `orders/fulfilled` sample has `fulfillment_status: null` and `fulfillments: []`. The `fulfillments/create` top-level keys are as stated. [WH-REF]
- "By default, the payload contains the full REST resource" [WH-STRUCT]. REST InventoryLevel properties are `available` (null if untracked), `inventory_item_id`, `location_id`, `updated_at`. [REST-IL]
- The note "Changes to `committed`, `reserved`, `damaged`, `safety_stock`, and `quality_control` inventory states don't trigger webhooks". [INV-APPS "Webhooks"]
- Ordering not guaranteed, reconciliation jobs recommended, duplicates possible with `X-Shopify-Webhook-Id` dedupe, `X-Shopify-Event-Id` shared per merchant action, 1 s / 5 s timeouts, 8 retries over 4 h with increasing interval, shop-specific subscriptions deleted after 8 failures and app-specific ones not, "up to a day late", debouncing with `include_fields`, filter evaluated "using current field values at the time of delivery". [WH-ABOUT], [WH-VERIFY], [WH-TROUBLE], [WH-SUB], [WH-STRUCT], [WH-FILTER]
- The InventoryAdjustmentGroup fields and "No referencing types" [IAG]. The `queries/inventoryAdjustmentGroup` and `queries/inventoryAdjustmentGroups` pages still return 404.
- The `referenceDocumentUri` and `ledgerDocumentUri` rules and error codes, the reason list (shared by set and adjust: both input objects link to the same "possible reasons"), the response `reason` "Inventory correction", and `quantityAfterChange: null` in the examples. [INV-QS], [IN-ADJ], [IN-SET], [IN-CHG]
- "Shopify decrements the available … increments the committed … After the order is fulfilled, Shopify decrements the committed". The `on_hand` sum. `committed` cannot be adjusted or moved via the API. [INV-APPS], [INV-QS]
- `fulfillmentCreate` contains no inventory statement (grep for inventor/stock/committed/on_hand found nothing). Neither `fulfillmentCancel` nor the fulfillment-service guide "Step 7: Cancel a fulfillment" says anything about inventory restock. [FC], [FUL], https://shopify.dev/docs/apps/build/orders-fulfillment/fulfillment-service-apps/build-for-fulfillment-services.md
- The `changeFromQuantity` CAS (mandatory, `null` to opt out), `@idempotent` optional from 2026-01 and required from 2026-04, the 24 h key window, and `IDEMPOTENCY_CONCURRENT_REQUEST`. [SET], [ADJ], [IN-CHG], [IDEM]
- The `inventoryLevels(query:)` filters, `includeInactive` default false, and the `inventoryItems(query:)` filters. [IITEM], [LOC], [IITEMS]
- The Events conflict ("Events is currently available in the `unstable` version" in [VER] against `api_version = "2026-10"` in the Events pages, and `[events] api_version = "unstable"` in [WH-REF]), CLI 3.92, toml-only configuration, `Shopify-Webhook-Id` dedupe. There is no Events `InventoryLevel` topic (404), while `order`, `fulfillment-order` and `product` topic pages exist. [EV], [EV-II], [EV-VS], [VER]
- "Webhooks fire for the app's own mutations" is still **NOT DOCUMENTED**. Searches of all downloaded webhook, Events and inventory pages for self-trigger and loop wording found nothing.

**Corrections made in place:**
1. §3: the inference "fulfillment does *not* fire `inventory_levels/update`" went beyond the docs. Fulfillment also lowers `on_hand`, which is not on the exclusion list, so the bullet now says NOT DOCUMENTED. Even if a delivery comes, its `available` value is unchanged.
2. §6: "only via `node(id:)`" is now marked as an inference (Node interface only, no documented example). Added that the `read_inventory` scope is required, and that the deprecated `inventorySetOnHandQuantities` also appears in the IAG Mutations list.
3. §7: the claim that the REST "lowest ID / location swap" text "describes the pre-quantity-states model" was the author's own reading. It is now marked as an inference.
4. §1: the transfers and shipments row merged topics from both families (`receive_items` exists only for shipments). It is now split, with the exact enum lists.
5. §8: the scheduled-changes caution says only "2026-07". Added that the 2026-10 reference page states "This API version is not supported." Added the scope `write_inventory` plus user permission for adjust and set, `IDEMPOTENCY_KEY_PARAMETER_MISMATCH`, the directive syntax, and `InventoryQuantity.id`.
6. §5: added the version fall-forward rule, which version setting serializes the payload, and a second documented cause of duplicates (shop-specific and app-specific subscriptions to the same topic at once).
7. §10: added the Events payload and header fields (no actor field), and the "derived fields aren't available as triggers" caveat.

**Still unverifiable here:** Help Center pages (help.shopify.com is blocked by the proxy). Any statement about real-store behaviour (whether own mutations echo back, and whether fulfillment emits `inventory_levels/update`) needs an empirical test on a development store.
