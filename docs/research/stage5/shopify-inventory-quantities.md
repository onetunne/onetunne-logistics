# Shopify inventory model — GraphQL Admin API 2026-10 (fact sheet)

Research date: 2026-11-27. Only official shopify.dev pages, fetched as `.md`.
Every statement cites a source key (see "Sources" at the end). "Derived" = a logical consequence of two cited
statements, not a sentence in the docs. "NOT DOCUMENTED" = not stated in any page fetched.

Version check: `latest` reference pages were byte-identical to `2026-10` for every object fetched, and front-matter says
`api_version: 2026-10` [IL][II][IQ]. The version table lists 2026-10 (released Oct 1 2026, supported until Oct 16 2027)
as "Latest stable", 2027-01 as release candidate [VER].
Note: `https://shopify.dev/docs/apps/build/orders-fulfillment/inventory-management-apps.md` returns 301 to
`https://shopify.dev/docs/apps/build/inventory-management-apps.md` [IMA]. help.shopify.com was blocked by the
environment proxy (HTTP 403), so the Help Center was not consulted.

---

## 1. Object model

| Object | Fact | Source |
|---|---|---|
| ProductVariant ↔ InventoryItem | Every variant has a 1:1 relationship with its inventory item. `ProductVariant.inventoryItem` is non-null. **Caveat (verifier):** the 2026-10 `InventoryItem` reference also has a `variants: ProductVariantConnection` field ("A paginated list of the variants that reference this inventory item") and marks the singular `variant` field as deprecated. When/whether several variants can share one inventory item: NOT DOCUMENTED in fetched pages. | [MQS §Inventory object relationships], [PV], [II fields `variants`, `variant`] |
| InventoryItem | Physical-product / backend data: SKU, `tracked`, `requiresShipping`, customs (HS codes, country/province of origin), `measurement`, `unitCost`, `inventoryHistoryUrl`, `duplicateSkuCount`, `locationsCount`. Has one InventoryLevel per location where it is stocked. | [II], [MQS] |
| InventoryItem.unitCost | MoneyV2 in shop currency; "the user must have 'View product costs' permission ... once product granular permissions are enabled". | [II] |
| InventoryLevel | Connects one InventoryItem to one Location. Fields: `id`, `item`, `location`, `quantities(names: [String!]!)`, `isActive`, `canDeactivate`, `deactivationAlert`, `createdAt`, `updatedAt`, `scheduledChanges` (deprecated). | [IL] |
| InventoryLevel ID | Parameterised GID: `gid://shopify/InventoryLevel/<n>?inventory_item_id=<itemId>`. | [MQS §Step 1 note] |
| InventoryQuantity | Fields: `id`, `name` (String!, the state name), `quantity` (Int!), `updatedAt` (DateTime, nullable). Only reachable via `InventoryLevel.quantities`. | [IQ] |
| `quantities(names:)` | `names` argument is **required** (`[String!]!`). | [IL] |
| InventoryItem.inventoryLevels / inventoryLevel(locationId) | Both take `includeInactive` (default false). `inventoryLevels` filter keys: `created_at`, `id`, `inventory_group_id`, `inventory_item_id`, `updated_at`. | [II]; [RN04 §Inventory] |
| inventoryItems query | Filter keys: `created_at`, `id`, `sku`, `updated_at`. | [II §Queries] |
| Location | Has many inventory levels; one per stocked item. `Location.inventoryLevel(s)` also take `includeInactive`. | [MQS], [LOC], [RN04] |
| inventoryProperties query | Returns `quantityNames[]` with `name`, `displayName`, `belongsTo[]`, `comprises[]`, `isInUse`. | [IP], [IQN] |

## 2. Quantity names (inventory states)

Documented set of names (8): `incoming`, `on_hand`, `available`, `committed`, `reserved`, `damaged`, `safety_stock`,
`quality_control` [IMA §Inventory states], [MQS §Step 2 comments], [IP example response].

| Name | Meaning (quoted/condensed) | Part of `on_hand`? | Physically at location? | Source |
|---|---|---|---|---|
| `available` | Inventory a merchant can sell; not committed, not part of incoming transfers. | yes (`belongsTo: ["on_hand"]`) | yes | [IMA], [IP] |
| `committed` | Set aside, not available to sell. Committed when a placed order isn't fulfilled; when inventory is reserved on a draft order (committed immediately, before draft completes); when a transfer/shipment is marked ready to ship. | yes | yes | [IMA], [IP] |
| `reserved` | On-hand units temporarily set aside (holds, inspection). Admin shows as **Unavailable**. Use cases incl. "allocated to an order by a 3PL that Shopify is unaware of" (i.e. not `committed`). | yes | yes | [IMA], [MQS §Adjust table], [IP] |
| `damaged` | On-hand units not sellable/usable due to damage. Admin shows as **Unavailable**. | yes | yes | [IMA], [IP] |
| `safety_stock` | On-hand units set aside to guard against overselling. Admin shows as **Unavailable**. | yes | yes | [IMA], [IP] |
| `quality_control` | On-hand units in quality inspection, not sellable. Admin shows as **Unavailable**. | yes | yes | [IMA], [IP] |
| `incoming` | On its way to the location; not sellable until received and moved to `available`. The **only** state not physically present. Surfaced at the destination location. | **no** (`belongsTo: []`) | no | [IMA], [MQS §Move], [IP] |
| `on_hand` | Total units physically at a location = `available + committed + reserved + damaged + safety_stock + quality_control`. (`comprises` lists exactly these six.) | — (aggregate) | — | [IMA], [MQS §Set], [IP] |

- The states `incoming, available, committed, reserved, damaged, safety_stock, quality_control` are mutually exclusive [IMA note].
- `unavailable`: **NOT DOCUMENTED as an API quantity name.** "Unavailable" is only the Shopify-admin display label for
  `reserved`, `damaged`, `safety_stock`, `quality_control` [IMA], [MQS §Move note]. It is not in the `inventoryProperties`
  example list [IP].
- Whether a shop can have additional/custom quantity names: NOT DOCUMENTED (only the 8 above appear; `isInUse` flag exists) [IP].
- Max number of `names` per `quantities` call: NOT DOCUMENTED.

## 3. Computed vs writable (by API)

| Name | `inventorySetQuantities` (absolute) | `inventoryAdjustQuantities` (delta) | `inventoryMoveQuantities` (state→state) | Notes / source |
|---|---|---|---|---|
| `available` | yes | yes | yes | [IMA §GraphQL], [MQS §Step 3], [ISQ input: name "only accepted values: available or on_hand"] |
| `on_hand` | yes | not listed | not listed | Setting `on_hand` +1 returned changes `available +1` and `on_hand +1` (example) [MQS §Set example] |
| `committed` | **no** | **no** | **no** | "You can't use the Admin API to adjust or move inventory quantities in the `committed` state" — managed by Shopify (orders, fulfillment, draft-order reservations, transfers ready to ship) [IMA §Limitations], [MQS note] |
| `reserved`, `damaged`, `safety_stock`, `quality_control` | no | yes | yes | [MQS §Adjust, §Move] |
| `incoming` | no | yes | yes | Moving out of `incoming` increases `on_hand`; moving into `incoming` decreases `on_hand` [MQS §Move] |

- Adjusting `available` by −4 returned changes on both `available −4` and `on_hand −4` [IAQ example response].
- `on_hand` is an aggregate of six states [IP `comprises`], yet it is directly settable [ISQ]. Which component absorbs a
  set-`on_hand` delta: the only evidence is the example where `available` moved by the same delta [MQS §Set example];
  a general rule is NOT DOCUMENTED.
- Activation can set initial `available` / `onHand` (`inventoryActivate(available:, onHand:)`) [IACT].
- Variant bulk create accepts `inventoryQuantities: [InventoryLevelInput{availableQuantity, locationId}]` [ILI].

## 4. Order / fulfillment / cancel / refund effects on quantities

| Event | Documented effect | Source | Status |
|---|---|---|---|
| Order placed | "Shopify decrements the available inventory quantity for product variants that are included in an order, and increments the committed inventory quantity for the order." | [IMA §How it works] | documented |
| Order placed → `on_hand` | available −n and committed +n ⇒ on_hand unchanged. | [IMA] + on_hand definition | derived |
| Which location gets committed on order | NOT DOCUMENTED in fetched pages. | — | gap |
| `Order.confirmed` | "Whether inventory has been reserved for an order. Returns true if inventory quantities for an order's line items have been reserved." | [ORD] | documented |
| Order fulfilled | "After the order is fulfilled, Shopify decrements the committed inventory quantity." | [IMA §How it works] | documented |
| Fulfilled → `on_hand` | committed −n ⇒ on_hand −n (committed is a component of on_hand). | [IMA] + [IP] | derived; not stated explicitly |
| `fulfillmentCreate` page itself | Says nothing about inventory. Scopes: `write_assigned_fulfillment_orders` or `write_merchant_managed_fulfillment_orders` or `write_third_party_fulfillment_orders`; user needs `fulfill_and_ship_orders`. All fulfillment orders in one call must belong to the same Order and same Location. | [FC] | documented |
| `fulfillmentCancel` | Reverses effects on FulfillmentOrders; creates new FOs at the original Location if still stocked, else per fulfillment-priority settings. Effect on inventory quantities: NOT DOCUMENTED. | [FCAN] | gap |
| `orderCancel(restock: Boolean!)` | `restock` is **required**: "Whether to restock the inventory committed to the order." Deactivated location: paid order + restock → cancellation fails; unpaid order → succeeds but nothing restocked, "the committed inventory effectively becomes unavailable". Cancellation is async (`job`, `jobResult`; poll `node` until `done`). Irreversible. Requires `write_orders` (or marketplace/buyer-membership variants). Preconditions: not already cancelled; no pending payment authorizations; no active returns in progress; no outstanding fulfillments that can't be cancelled. | [OC] | documented |
| `Order.restockable: Boolean!` | "Whether any line items on the order can be restocked into inventory. Returns `false` for digital products, custom items, or items that can't be resold." | [ORD] | documented |
| orderCancel restock → target state (back to `available`?) | NOT DOCUMENTED explicitly. | [OC] | gap |
| `refundCreate` line `restockType` | `CANCEL` = restock unfulfilled line items; `RETURN` = restock fulfilled items; `NO_RESTOCK`; `LEGACY_RESTOCK` deprecated/not accepted. `RefundLineItemInput.locationId` = intended restock location (empty if NO_RESTOCK). `refundCreate` itself: `@idempotent` optional since 2026-01, **required since 2026-04**. | [RLRT], [RLI], [RC], [RN04 §Inventory mutation safety] | documented |
| Refund restock → exact state change | NOT DOCUMENTED (only reason `restock` = "add a returned unit back to available inventory" in the reasons table) | [MQS reasons] | gap |
| `returnProcess` dispositions | `RESTOCKED`, `NOT_RESTOCKED`, `PROCESSING_REQUIRED`, `MISSING`. Requires `write_returns` (or marketplace). Quantity effect per disposition: NOT DOCUMENTED. | [RFODT], [RP] | partial |
| `orderEditSetQuantity(restock:)` | When decreasing quantity, `restock: true` optionally restocks; default false (default stated only in the guide [EDIT §Step 2], not on the reference page). Requires `write_order_edits`. Only unfulfilled line items can be edited [EDIT §Step 3]. | [OESQ], [EDIT] | documented |
| `orderCreate` `inventoryBehaviour` | `BYPASS` (don't claim), `DECREMENT_IGNORING_POLICY`, `DECREMENT_OBEYING_POLICY`. | [OCIB] | documented |
| Overselling (`inventoryPolicy: CONTINUE`) → can `available` go negative? | NOT DOCUMENTED in fetched pages. Indirect evidence only: an adjust example uses `delta: -4` with `changeFromQuantity: 1` and returns no errors. Adjust error text: `INVALID_QUANTITY_TOO_LOW` "The quantity can't be lower than -2,000,000,000" (whether "quantity" means the delta or the resulting quantity is not stated). Set: `INVALID_QUANTITY_NEGATIVE` "The quantity can't be negative" — yet the same enum also has `INVALID_QUANTITY_TOO_LOW` "The total quantity can't be lower than -1,000,000,000". | [IAQ example], [IAQ-E], [ISQ-E] | gap |

## 5. Mutations — exact rules (2026-10)

### Common
- All three quantity mutations (`inventorySetQuantities`, `inventoryAdjustQuantities`, `inventoryMoveQuantities`) and
  `inventoryActivate`: `@idempotent(key:)` optional since 2026-01, **required since 2026-04** [IAQ][ISQ][IMQ][IACT][MQS §Requirements][RN04].
- `changeFromQuantity` (compare-and-swap) is **mandatory to pass** on every change entry; pass explicit `null` to opt out;
  omitting it returns an error. Mismatch → `CHANGE_FROM_QUANTITY_STALE` [ICI][IQI][IMTI][ISQ][RN04].
  `compareQuantity` / `ignoreCompareQuantity` were removed from inputs in 2026-04 [RN04] (the error enum still lists
  `COMPARE_QUANTITY_REQUIRED/STALE` [ISQ-E]).
- Opt-out of CAS recommended only when "you're the source of truth" [MQS §Compare and swap].
- `inventorySetQuantities`: "Only use this mutation if calling on behalf of a system that acts as the source of truth
  for inventory quantities, otherwise please consider using `inventoryAdjustQuantities`" [ISQ].
- Scopes/permissions: all require `write_inventory`; plus a user permission, worded per page: adjust "apply changes to
  inventory quantities" [IAQ]; set "update an inventory" [ISQ]; move "move an inventory" [IMQ]; activate "activate an
  inventory item" [IACT]; deactivate "deactivate an inventory" [IDEACT]; item update "update an inventory item" [IIU].
- `inventorySetOnHandQuantities` still exists in 2026-10 but is **Deprecated** ("Use inventorySetQuantities to set
  on_hand or available quantites instead"); it also requires `@idempotent` since 2026-04 [ISOH].
- `productVariantsBulkUpdate` also implements compare-and-swap and needs `changeFromQuantity` since 2026-04
  [MQS §Compare and swap][RN04 §Inventory mutation safety].
- Since 2026-04 quantity mutations can create an **inactive** InventoryLevel and store the quantity; the item is not
  sellable/fulfillable there until activated (`inventoryActivate` / `inventoryBulkToggleActivation`). Before 2026-04 they
  returned `ITEM_NOT_STOCKED_AT_LOCATION` [MQS §Step 3]; that error was removed in 2026-10 [RN10].
- Parent bundle items cannot be changed via API → `NON_MUTABLE_INVENTORY_ITEM` [IAQ-E][ISQ-E][IMQ-E].
- Response `quantityAfterChange` "always returns null immediately after running the mutation"; populated only after
  processing [MQS §Move example comments].
- Returned `reason` is humanised (input `"correction"` → `"Inventory correction"`, `"damaged"` → `"Damaged"`) [MQS examples][IMQ example].

### inventorySetQuantities(input: InventorySetQuantitiesInput)
- Fields: `name` (`available` | `on_hand` only), `reason` (String!), `referenceDocumentUri` (optional),
  `quantities: [InventoryQuantityInput{inventoryItemId, locationId, quantity, changeFromQuantity}]` [ISQI][IQI].
- Errors incl. `INVALID_NAME`, `INVALID_QUANTITY_NEGATIVE` ("can't be negative"), `INVALID_QUANTITY_TOO_HIGH/LOW`
  (±1,000,000,000 total), `NO_DUPLICATE_INVENTORY_ITEM_ID_GROUP_ID_PAIR` (item+location must be unique), idempotency errors [ISQ-E].

### inventoryAdjustQuantities(input: InventoryAdjustQuantitiesInput)
- Fields: `name` (state), `reason`, `referenceDocumentUri` (optional), `changes: [InventoryChangeInput{inventoryItemId,
  locationId, delta, changeFromQuantity, ledgerDocumentUri}]` [IAQI][ICI].
- Allowed states: `available, damaged, incoming, quality_control, reserved, safety_stock` [MQS §Adjust].
- `ledgerDocumentUri` rules: required on every change when `name` ≠ `available` (`INVALID_QUANTITY_DOCUMENT`);
  forbidden when `name` = `available` (`INVALID_AVAILABLE_DOCUMENT`); must not be `gid://shopify/...`
  (`INTERNAL_LEDGER_DOCUMENT`); all changes must share one value (`MAX_ONE_LEDGER_DOCUMENT`) [MQS §Adjust][IAQ-E].
- Limits: ±2,000,000,000 (`INVALID_QUANTITY_TOO_HIGH/LOW`). Other errors: `ADJUST_QUANTITIES_FAILED` ("Try again"),
  `SERVICE_UNAVAILABLE`, `INVALID_QUANTITY_NAME`, `INVALID_REASON`, `INVALID_LOCATION`, `INVALID_INVENTORY_ITEM`,
  `INVALID_LEDGER_DOCUMENT`, `INVALID_REFERENCE_DOCUMENT`, `NON_MUTABLE_INVENTORY_ITEM`, `CHANGE_FROM_QUANTITY_STALE`,
  idempotency codes [IAQ-E]. Which code is returned when `name: "committed"` is sent: NOT DOCUMENTED.

### inventoryMoveQuantities(input: InventoryMoveQuantitiesInput)
- Fields: `reason`, `referenceDocumentUri` (**String! — required here**, optional in set/adjust),
  `changes: [{inventoryItemId, quantity, from:{locationId,name,changeFromQuantity,ledgerDocumentUri}, to:{...}}]` [IMQI][IMQC][IMTI].
- Same location only (`DIFFERENT_LOCATIONS`); names must differ (`SAME_QUANTITY_NAME`); negative quantity rejected
  (`INVALID_QUANTITY_NEGATIVE`); at most 2 ledger URIs across all changes (`MAXIMUM_LEDGER_DOCUMENT_URIS`);
  `ledgerDocumentUri` required for non-`available` terminal, forbidden for `available` [IMQ-E][IMTI].
  Also `MOVE_QUANTITIES_FAILED` ("Try again"), `SERVICE_UNAVAILABLE` [IMQ-E].
  Note: the `InventoryMoveQuantityChange` description still says a change "can either involve the same quantity name
  between different locations, or involve different quantity names between the same location" — contradicted by the
  mutation description ("at a single location") and `DIFFERENT_LOCATIONS` [IMQC][IMQ][IMQ-E].
- Allowed states: `available, damaged, incoming, quality_control, reserved, safety_stock` [MQS §Move].
- Shopify advice: for POS customer holds use draft orders rather than manually moving to `reserved` [MQS §Move table].

### Reasons (string values for `reason`)
`correction`, `cycle_count_available`, `damaged`, `movement_created`, `movement_updated`, `movement_received`,
`movement_canceled`, `other`, `promotion`, `quality_control`, `received`, `reservation_created`, `reservation_deleted`,
`reservation_updated`, `restock`, `safety_stock`, `shrinkage` [MQS §Set table]. Input docs point to this list for all
three mutations [IAQI][ISQI][IMQI]. Invalid → `INVALID_REASON`.

### referenceDocumentUri vs ledgerDocumentUri
- `referenceDocumentUri` = *why* (business document: order, PO, cycle count); may be a Shopify GID; preferred format
  `gid://<namespace>/<Entity>/<id>`; shown in admin inventory history and Analytics reports [MQS §Using referenceDocumentUri][IAQI].
- `ledgerDocumentUri` = the exact ledger entry / transaction in *your* system; non-Shopify URI [ICI][MQS §Adjust].

### Idempotency details
- Keys tracked **24 h**; duplicate in-flight → `IDEMPOTENCY_CONCURRENT_REQUEST`; same key + different params →
  `IDEMPOTENCY_KEY_PARAMETER_MISMATCH` [IDEM2]. The enum (not the guide) adds `IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED`:
  "A previous request with this idempotency key failed. Retry with a new idempotency key." [IAQ-E][ISQ-E][IMQ-E].
  The guide says a duplicate of a failed request gets `IDEMPOTENCY_CONCURRENT_REQUEST` (if stalled/in progress) or "an
  error with a suitable message", and recommends **reusing** the key after a backend failure/timeout [IDEM2 §Failed
  request retries, §When to generate a new key] — i.e. on `IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED` use a new key; otherwise reuse.
- Successful retry returns cached response built from current DB state (may differ from original) [IDEM2].
- Persist the key before sending; reuse on timeout/failure; new key for genuinely new operation; UUID v4/v7 or
  deterministic UUID v5 for jobs [IDEM2].
- Bulk operations: idempotency per JSONL row, each row its own key [IDEM2].

### Activation / deactivation
- `inventoryActivate(inventoryItemId, locationId, available?, onHand?)` returns `inventoryLevel` [IACT].
- `inventoryDeactivate(inventoryLevelId)` "Removes an inventory item's quantities from a location, and turns off
  inventory at the location" [IDEACT].
- **Doc conflict:** [IACT]/[IL] say omitted `available`/`onHand` "default to zero"; [RN04] says since 2026-04
  `inventoryActivate` "no longer defaults available or onHand quantities to zero when those arguments are omitted"
  (existing quantities on an inactive level are preserved), and [MQS §Step 3] agrees with RN04.

### Scheduled changes
- `inventorySetScheduledChanges` removed in 2026-07 with no replacement; `InventoryLevel.scheduledChanges` deprecated
  [MQS §Schedule caution][RN07][IL].

## 6. Tracked vs untracked; selling policy

- `InventoryItem.tracked: Boolean!` — "Whether inventory levels are tracked for the item." [II]
- `InventoryItem.trackedEditable: EditableProperty{locked, reason}` — whether `tracked` can be changed [II][EP].
- Set via `inventoryItemUpdate(id, input: {tracked, cost, sku, requiresShipping, measurement, HS codes, origin...})`,
  requires `write_inventory` [IIU][III]; also nested in `ProductVariantsBulkInput`/`ProductVariantSetInput.inventoryItem` [III].
- `products` query has a `tracks_inventory` filter (since 2026-04) [RN04].
- `ProductVariant.inventoryPolicy`: `DENY` (can't buy when out of stock) / `CONTINUE` (can buy after out of stock) [PV][PVIP].
- `ProductVariant.inventoryQuantity: Int` — "The total sellable quantity of the variant." `sellableOnlineQuantity: Int!` —
  total sellable for online channels; not total available inventory [PV]. Exact formula (sum of `available` over which
  locations?): NOT DOCUMENTED.
- What happens to quantities / committed on orders when `tracked = false`: **NOT DOCUMENTED** in fetched pages.
- Whether quantity mutations are rejected for untracked items: NOT DOCUMENTED (no such error code in the three enums) [IAQ-E][ISQ-E][IMQ-E].

## 7. Locations

- Location = physical place (store, warehouse, popup, dropshipper). Fields relevant to stock: `isActive`,
  `fulfillsOnlineOrders`, `hasActiveInventory`, `hasUnfulfilledOrders`, `isFulfillmentService`, `fulfillmentService`,
  `deactivatable`, `shipsInventory` (legacy; "All locations with valid addresses can now ship"), `inventoryLevel(s)` [LOC].
- `locations` query returns only active locations by default (`includeInactive`), excludes fulfillment-service
  ("legacy") locations unless `includeLegacy: true`; default sort NAME [LOCQ].
- Fulfillment-service app locations: read via `shop { fulfillmentServices { location { ... } } }` [MQS §Step 1].
- Fulfillment-service apps may expose `/fetch_stock.json` returning SKU → `on_hand` (hourly full sync) [FS §Step 10].
- SKU sharing is enabled for all fulfillment services (`permitsSkuSharing` removed 2026-04): "review logic that assumes
  inventory is stocked at only one location" [RN04].

## 8. Access scopes

| Need | Scope(s) | Source |
|---|---|---|
| Read InventoryLevel, InventoryQuantity, InventoryAdjustmentGroup, InventoryChange, inventoryProperties | `read_inventory` | [IL][IQ][IAG][IC][IP] |
| Read InventoryItem | `read_inventory` **or** `read_products` | [II] |
| Read Location | `read_locations` **or** `read_inventory` **or** `read_markets_home` | [LOC] |
| Read ProductVariant (inventoryQuantity, inventoryPolicy) | `read_products` | [PV] |
| Write quantities / activate / deactivate / update item | `write_inventory` (+ user permission) | [IAQ][ISQ][IMQ][IACT][IDEACT][IIU] |
| Scope table | `read_inventory`/`write_inventory` → InventoryItem, InventoryLevel; `read_locations`/`write_locations` → Location | [SCOPES] |
| Write implies read | "Any scope that writes a resource also grants read access to it" | [SCOPES] |
| Guide requirement | "Your app has the `read_inventory` and `write_inventory` access scopes" | [MQS §Requirements] |
| Webhooks inventory_levels/* | `read_inventory`; inventory_items/* need `read_inventory` or `read_products` | [WHT] |
| Cancel order (restock) | `write_orders` | [OC] |
| Refund (restockType) | "orders" scope (page wording: "Requires `orders` access scope") | [RC] |
| Order edit restock | `write_order_edits` | [OESQ] |
| Purchase orders (`inventoryPurchaseOrder(s)`, new in 2026-10) | `read_inventory_purchase_orders` — "`read_inventory` alone no longer authorizes purchase order reads" | [RN10 §Inventory] |
| Order age window | `read_orders`/`write_orders` cover orders created in the last 60 days; older orders need `read_all_orders` in addition | [SCOPES §Orders permissions] |

Project context (repo file, not docs): current scopes in `/home/user/onetunne-logistics/shopify.app.toml` line 19 are
`write_orders,read_products,read_inventory,write_merchant_managed_fulfillment_orders,write_shipping` — i.e. reading
quantities/locations is already covered by `read_inventory`; any write to Shopify stock would need `write_inventory`.

## 9. Webhooks

- Topics: `inventory_items/create|update|delete`, `inventory_levels/connect|disconnect|update` [IMA §Webhooks][WHT].
- "Changes to `committed`, `reserved`, `damaged`, `safety_stock`, and `quality_control` inventory states don't trigger
  webhooks." [IMA §Webhooks note]
- `inventory_levels/update` sample payload: `inventory_item_id`, `location_id`, `available`, `updated_at`,
  `admin_graphql_api_id` — only `available` is in the payload [WH].
- Derived (narrow): the `committed` part of an order/fulfillment change triggers no inventory webhook. Whether the
  accompanying `available` change (order placed) or `on_hand` change (fulfillment) triggers `inventory_levels/update`,
  and whether `incoming` changes do, is NOT DOCUMENTED (the excluded list names only committed, reserved, damaged,
  safety_stock, quality_control) [IMA §Webhooks note]. Do not assume a fulfillment is webhook-silent.
- Shopify guidance for external systems: deduplicate by event ID in delivery headers, not timestamp; webhooks can
  arrive twice or be missed → run scheduled reconciliation; on difference "flag for review. Do not auto-write back"
  [XFER §Step 5, §Step 7] (stated for transfers, not for levels in general).

## 10. Audit trail objects

- `InventoryAdjustmentGroup`: `id`, `createdAt`, `reason`, `referenceDocumentUri`, `app`, `staffMember`,
  `changes(inventoryItemIds, locationIds, quantityNames)` [IAG].
- `InventoryChange`: `name`, `delta`, `quantityAfterChange`, `ledgerDocumentUri`, `item`, `location` [IC].
- A query to list historical adjustment groups for an item: NOT DOCUMENTED in fetched pages (only
  `InventoryItem.inventoryHistoryUrl` — admin URL [II]).

## 11. NOT DOCUMENTED (gaps to treat as unknown)

1. API quantity name `unavailable` (only an admin label).
2. Which location's `committed` increases when an order is placed (multi-location routing).
3. Exact state transitions for `orderCancel(restock:true)`, refund `CANCEL`/`RETURN`, `returnProcess` dispositions,
   `fulfillmentCancel`.
4. Explicit statement that fulfillment decrements `on_hand` (only derivable).
5. Whether `available` can go negative under `inventoryPolicy: CONTINUE`; behaviour of untracked items.
6. Formula of `ProductVariant.inventoryQuantity`.
7. Which component a set-`on_hand` delta lands in (example shows `available`).
8. Whether `available`/`on_hand`/`incoming` changes fire `inventory_levels/update` (only the five non-firing states are listed).
9. Limit on number of `names` in `quantities()`.
10. Whether offline (non-user) access tokens bypass the "user must have permission" requirement.

## 12. Doc inconsistencies spotted

- `inventoryActivate` default-to-zero (reference) vs preserve-existing (2026-04 release notes + guide) — see §5.
- Reference pages still link `https://shopify.dev/docs/apps/fulfillment/inventory-management-apps...` and
  `.../orders-fulfillment/inventory-management-apps/...`; canonical is `.../apps/build/inventory-management-apps...` [IMA][IL].
- `InventorySetQuantitiesUserErrorCode` still lists `COMPARE_QUANTITY_*` codes though inputs were removed in 2026-04 [ISQ-E][RN04].
- `InventorySetQuantitiesUserErrorCode` has both `INVALID_QUANTITY_NEGATIVE` and `INVALID_QUANTITY_TOO_LOW` (−1,000,000,000 total) [ISQ-E].
- `InventoryMoveQuantityChange` description allows cross-location moves; `DIFFERENT_LOCATIONS` forbids them [IMQC][IMQ-E].
- Idempotency: enum says retry with a **new** key after `IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED`; guide says **reuse** the key after a failure [IAQ-E][IDEM2].
- MQS says variant ↔ inventory item is 1:1, while `InventoryItem` exposes a `variants` connection and deprecates `variant` [MQS][II].

---

## Sources

API reference base: `https://shopify.dev/docs/api/admin-graphql/2026-10/` (identical to `/latest/`).

- [IMA] https://shopify.dev/docs/apps/build/inventory-management-apps.md — §How it works, §Inventory states, §GraphQL queries and mutations, §Webhooks, §Limitations
- [MQS] https://shopify.dev/docs/apps/build/inventory-management-apps/manage-quantities-states.md — §Requirements, §Inventory object relationships, §Step 1–3, §Set, §Adjust, §Move, §Schedule, §Compare and swap
- [XFER] https://shopify.dev/docs/apps/build/inventory-management-apps/receiving-external-transfers-in-pos.md — §Step 5–7
- [FS] https://shopify.dev/docs/apps/build/orders-fulfillment/fulfillment-service-apps/build-for-fulfillment-services.md — §Step 10
- [EDIT] https://shopify.dev/docs/apps/build/orders-fulfillment/order-management-apps/edit-orders.md — §Remove a line item
- [IL] objects/InventoryLevel.md · [II] objects/InventoryItem.md · [IQ] objects/InventoryQuantity.md
- [IQN] objects/InventoryQuantityName.md · [IP] queries/inventoryProperties.md (+ objects/InventoryProperties.md)
- [IAG] objects/InventoryAdjustmentGroup.md · [IC] objects/InventoryChange.md · [EP] objects/EditableProperty.md
- [IAQ] mutations/inventoryAdjustQuantities.md · [ISQ] mutations/inventorySetQuantities.md · [IMQ] mutations/inventoryMoveQuantities.md
- [IACT] mutations/inventoryActivate.md · [IDEACT] mutations/inventoryDeactivate.md · [IIU] mutations/inventoryItemUpdate.md
- [ISOH] mutations/inventorySetOnHandQuantities.md · [PQ] queries/products.md (filter `tracks_inventory`)
- [IAQI] input-objects/InventoryAdjustQuantitiesInput.md · [ICI] input-objects/InventoryChangeInput.md
- [ISQI] input-objects/InventorySetQuantitiesInput.md · [IQI] input-objects/InventoryQuantityInput.md
- [IMQI] input-objects/InventoryMoveQuantitiesInput.md · [IMQC] input-objects/InventoryMoveQuantityChange.md · [IMTI] input-objects/InventoryMoveQuantityTerminalInput.md
- [III] input-objects/InventoryItemInput.md · [ILI] input-objects/InventoryLevelInput.md
- [IAQ-E] enums/InventoryAdjustQuantitiesUserErrorCode.md · [ISQ-E] enums/InventorySetQuantitiesUserErrorCode.md · [IMQ-E] enums/InventoryMoveQuantitiesUserErrorCode.md
- [LOC] objects/Location.md · [LOCQ] queries/locations.md
- [PV] objects/ProductVariant.md · [PVIP] enums/ProductVariantInventoryPolicy.md
- [ORD] objects/Order.md (field `confirmed`) · [OC] mutations/orderCancel.md · [OCIB] enums/OrderCreateInputsInventoryBehavior.md
- [RC] mutations/refundCreate.md · [RLRT] enums/RefundLineItemRestockType.md · [RLI] input-objects/RefundLineItemInput.md
- [RP] mutations/returnProcess.md · [RFODT] enums/ReverseFulfillmentOrderDispositionType.md
- [FC] mutations/fulfillmentCreate.md · [FCAN] mutations/fulfillmentCancel.md · [OESQ] mutations/orderEditSetQuantity.md
- [WHT] enums/WebhookSubscriptionTopic.md · [WH] https://shopify.dev/docs/api/webhooks/2026-10.md (sample payloads)
- [SCOPES] https://shopify.dev/docs/api/usage/access-scopes.md
- [IDEM] https://shopify.dev/docs/api/usage/idempotent-requests.md · [IDEM2] https://shopify.dev/docs/apps/build/apis/graphql-admin/implementing-idempotency.md
- [VER] https://shopify.dev/docs/api/usage/versioning.md
- [RN04] https://shopify.dev/changelog/release-notes/2026-04.md §Inventory, §Inventory mutation safety, §Products · [RN07] https://shopify.dev/changelog/release-notes/2026-07.md §Inventory · [RN10] https://shopify.dev/changelog/release-notes/2026-10.md §Inventory

---

## Verification notes

Verifier pass on 2026-11-27. I re-fetched every primary page cited above as `.md` from shopify.dev (all HTTP 200;
`/apps/build/orders-fulfillment/inventory-management-apps.md` → 301 → `/apps/build/inventory-management-apps.md`, confirmed).
Spot check: `latest` was byte-identical to `2026-10` for InventoryLevel, InventoryItem, InventoryQuantity,
inventoryAdjustQuantities and InventorySetQuantitiesUserErrorCode. Front-matter says `api_version: 2026-10`. The version
table says 2026-10 = "Latest stable" and 2027-01 = "Release candidate" [VER]. 2027-01 changes were not checked.

**Confirmed as written:** the 8 quantity names and their meanings, the `on_hand` composition (six components) and
`incoming` not being part of on_hand [IMA][MQS][IP]; `quantities(names: [String!]!)` being required [IL]; the InventoryLevel /
InventoryQuantity / InventoryQuantityName / InventoryAdjustmentGroup / InventoryChange field lists; `includeInactive`
(default false) on InventoryItem/Location `inventoryLevel(s)` [II][LOC][RN04]; set = `available`|`on_hand` only [ISQI];
adjust/move state lists; `committed` not writable via API [IMA §Limitations][MQS]; `changeFromQuantity` mandatory
(explicit `null` opts out) [ICI][IQI][IMTI][ISQ]; `@idempotent` optional in 2026-01 and required from 2026-04 [IAQ][ISQ][IMQ][IACT];
the ledgerDocumentUri rules and error codes; `referenceDocumentUri` being `String!` only on move [IMQI]; the reasons list [MQS];
the order-placed and order-fulfilled sentences [IMA §How it works]; the `orderCancel` restock semantics and async job [OC];
the refund restock types [RLRT]; return dispositions [RFODT]; `inventoryBehaviour` values [OCIB]; `Order.confirmed` [ORD];
`inventoryPolicy` DENY/CONTINUE [PVIP]; `inventoryQuantity` / `sellableOnlineQuantity` wording [PV]; the scope table
(`read_inventory`/`write_inventory` → InventoryItem, InventoryLevel; Location readable with `read_locations` OR
`read_inventory` OR `read_markets_home`; write implies read) [SCOPES][LOC][II]; webhook topics, their scopes, the
non-firing states note and the `inventory_levels/update` sample payload (`inventory_item_id`, `location_id`, `available`,
`updated_at`, `admin_graphql_api_id`) [IMA][WHT][WH]; `inventorySetScheduledChanges` removed in 2026-07 [RN07][MQS];
`ITEM_NOT_STOCKED_AT_LOCATION` removed in 2026-10 and absent from all three 2026-10 enums [RN10][IAQ-E][ISQ-E][IMQ-E];
the inventoryActivate doc conflict (the reference says default 0, RN04 and MQS say quantities are preserved) [IACT][IL][RN04][MQS];
`tracks_inventory` products filter [RN04][PQ]; the idempotency 24 h window, the UUID v4/v7/v5 advice, persist-before-send and
per-row bulk keys [IDEM][IDEM2]; the XFER dedupe and "Do not auto-write back" guidance (Step 5 item 4, Step 7 item 2);
FS `/fetch_stock.json` (needs `inventory_management: true`; hourly full request; values = `on_hand`) [FS §Step 10];
the repo scope string at `shopify.app.toml:19`.

**Corrected / tightened in place:**
1. §9: the earlier derivation "a fulfillment triggers no inventory webhook" went too far. Only the `committed` component is
   documented as non-firing. Whether the accompanying `available`/`on_hand` changes fire is NOT DOCUMENTED.
2. §5 Idempotency: `IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED` ("retry with a new key") comes from the error enums, not from
   [IDEM2]. The guide recommends reusing the key after failures. Both sources are now cited and the conflict is flagged.
3. §4 Overselling: the earlier text "Adjust allows quantities down to −2,000,000,000" was an interpretation. The enum only says
   "The quantity can't be lower than -2,000,000,000" (delta vs result not stated). The set enum's NEGATIVE vs TOO_LOW pair is now noted.
4. §5 Common: the user-permission wording is now complete per mutation (added deactivate and item update).
5. §4 orderEditSetQuantity: "default false" appears only in the guide [EDIT], not on the reference page. Now labelled.

**Added (all verified in primary sources):** `InventoryItem.variants` connection plus deprecated `variant` (in tension with
the MQS 1:1 statement); deprecated-but-present `inventorySetOnHandQuantities`; `productVariantsBulkUpdate` CAS;
`refundCreate` `@idempotent` required from 2026-04; `orderCancel` preconditions; `Order.restockable`; only unfulfilled line
items are editable; the missing adjust/move error codes; the `InventoryMoveQuantityChange` description inconsistency;
`read_inventory_purchase_orders` (2026-10); the 60-day order window for `read_orders`/`write_orders`.

**Still NOT DOCUMENTED after re-check** (searched IMA, MQS, the build-fulfillment-solutions guide, the order-management-apps
guide, the FulfillmentOrder reference and the returns guide): which state receives restocked units on
cancel/refund/return; an explicit statement that fulfillment reduces `on_hand`; behaviour of untracked items; whether
`available` can go negative; the formula for `ProductVariant.inventoryQuantity`; which location's `committed` increases on order placement.
`fulfillmentCancel` lists no access scope on its reference page.
