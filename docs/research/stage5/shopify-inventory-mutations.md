# Shopify GraphQL Admin API 2026-10: inventory write mutations (fact sheet)

Researched 2026-11-27. Sources were fetched as `.md` from shopify.dev. Every reference page reports
`api_version: 2026-10` in its front matter, so "latest" is 2026-10. For InventorySetQuantitiesInput,
InventoryQuantityInput and InventoryChangeInput, the `/2026-10/` and `/latest/` pages were diffed and are identical.
"NOT DOCUMENTED" means none of the fetched pages state the fact.

Short source keys used below:
- [ADJ] https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventoryAdjustQuantities.md
- [SET] https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventorySetQuantities.md
- [MOVE] https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventoryMoveQuantities.md
- [ONHAND] https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventorySetOnHandQuantities.md
- [I-ADJ] .../input-objects/InventoryAdjustQuantitiesInput.md; [I-CHG] .../input-objects/InventoryChangeInput.md
- [I-SET] .../input-objects/InventorySetQuantitiesInput.md; [I-QTY] .../input-objects/InventoryQuantityInput.md
- [I-MOVE] .../input-objects/InventoryMoveQuantitiesInput.md; [I-MCHG] .../input-objects/InventoryMoveQuantityChange.md;
  [I-TERM] .../input-objects/InventoryMoveQuantityTerminalInput.md
- [I-ONHAND] .../input-objects/InventorySetOnHandQuantitiesInput.md; [I-SQ] .../input-objects/InventorySetQuantityInput.md
- [E-ADJ] .../enums/InventoryAdjustQuantitiesUserErrorCode.md; [E-SET] .../enums/InventorySetQuantitiesUserErrorCode.md;
  [E-MOVE] .../enums/InventoryMoveQuantitiesUserErrorCode.md; [E-ONHAND] .../enums/InventorySetOnHandQuantitiesUserErrorCode.md
- [O-GRP] .../objects/InventoryAdjustmentGroup.md; [O-CHG] .../objects/InventoryChange.md; [O-LVL] .../objects/InventoryLevel.md
  (`...` = https://shopify.dev/docs/api/admin-graphql/latest)
- [GUIDE] https://shopify.dev/docs/apps/build/inventory-management-apps/manage-quantities-states.md
  (the old `/docs/apps/build/orders-fulfillment/inventory-management-apps/manage-quantities-states.md` path, still linked from the reference pages, now returns 301 to this one)
- [STATES] https://shopify.dev/docs/apps/build/inventory-management-apps.md
  (the old `/docs/apps/build/orders-fulfillment/inventory-management-apps.md` path returns 301 to this one)
- [IDEM] https://shopify.dev/docs/api/usage/idempotent-requests.md
- [IDEM-IMPL] https://shopify.dev/docs/apps/build/apis/graphql-admin/implementing-idempotency.md
- [RL] https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits.md; [LIM] https://shopify.dev/docs/api/usage/limits.md
- [CL-*] Shopify changelog entries (URLs given inline), taken from https://shopify.dev/changelog/feed.xml

---

## 1. Common to all three mutations

| Fact | Source |
|---|---|
| Scope: `write_inventory` for each mutation. The user also needs inventory permission ("apply changes to inventory quantities" for adjust, "update an inventory" for set, "move an inventory" for move). | [ADJ], [SET], [MOVE] header |
| The guide lists both `read_inventory` and `write_inventory` as requirements. `InventoryAdjustmentGroup`, `InventoryChange` and `InventoryLevel` need `read_inventory`. | [GUIDE] Requirements; [O-GRP]; [O-CHG]; [O-LVL] |
| Signature: one argument `input: <Type>Input!`. The payload is `{ inventoryAdjustmentGroup: InventoryAdjustmentGroup, userErrors: [<Mutation>UserError!]! }`. | [ADJ], [SET], [MOVE] "Arguments" / "Payload returns" |
| A UserError has `code` (enum, nullable), `field: [String!]` (nullable) and `message: String!`. | .../objects/InventoryAdjustQuantitiesUserError.md, ...SetQuantitiesUserError.md, ...MoveQuantitiesUserError.md |
| **Idempotency:** the `@idempotent(key: String)` directive goes on the mutation field, for example `inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey)`. It is optional in 2026-01 and **required from 2026-04 on**, so it is required in 2026-10. It is not an input field or argument. | [ADJ]/[SET]/[MOVE]/[ONHAND] "Caution" box and examples; [CL] https://shopify.dev/changelog/making-idempotency-mandatory-for-inventory-adjustments-and-refund-mutations |
| The directive "doesn't show up as mandatory at the schema level". Calling these mutations without it "will result in an error at runtime". The exact error shape (top-level GraphQL error or userError, and its code) is **NOT DOCUMENTED**. | [CL] making-idempotency-mandatory... |
| The formal directive definition page (`.../directives/idempotent.md`) returns 404. The argument name `key` and its String type come only from the examples. A maximum key length or format is **NOT DOCUMENTED**. UUIDs are recommended (v4/v7 random, or v5 deterministic for job retries). | fetched 404; [IDEM] Tip; [IDEM-IMPL] "Generating idempotency keys" |
| Retention: keys are tracked for **24 hours** from the original request. After that, a retry counts as a new operation. | [IDEM-IMPL] "How idempotency protection is implemented..." |
| A duplicate sent while the original is still processing gets `IDEMPOTENCY_CONCURRENT_REQUEST`. The client should back off and retry with the SAME key. | [IDEM-IMPL]; enum text: "This request is currently in progress, please try again." |
| A duplicate sent after the original succeeded gets the cached GraphQL response and is not reprocessed. The cached response "is constructed from database records, which may have changed", so it can differ from the original response. | [IDEM-IMPL] "Successful request retries" |
| Reusing a key with different parameters gives `IDEMPOTENCY_KEY_PARAMETER_MISMATCH`. Shopify fingerprints all input fields by default, and "parameter order can affect fingerprinting", so input fields must be ordered consistently. | [IDEM-IMPL] "IDEMPOTENCY_KEY_PARAMETER_MISMATCH" |
| `IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED`: "A previous request with this idempotency key failed. Retry with a new idempotency key." This code is in all four enums. | [E-ADJ], [E-SET], [E-MOVE], [E-ONHAND] |
| Failed-request retries can return either `IDEMPOTENCY_CONCURRENT_REQUEST` (original stalled) or a suitable error message. | [IDEM-IMPL] "Failed request retries" |
| Recommendation: persist the key with the operation intent BEFORE sending, unless the key is derived deterministically. Use a new key for a new intent or changed parameters. Reuse the key after a network failure, timeout or backend failure. **Doc conflict:** the guide's Tip says to reuse the key after any failed response, but the enum text for `IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED` says "Retry with a new idempotency key". | [IDEM-IMPL] "Storing idempotency keys", "When to generate a new key"; [E-ADJ]/[E-SET]/[E-MOVE] |
| Idempotency errors come back in `userErrors` with a `code` and `field: null`. The guide shows this for `IDEMPOTENCY_KEY_PARAMETER_MISMATCH` and `IDEMPOTENCY_CONCURRENT_REQUEST`. They are not top-level GraphQL errors. | [IDEM-IMPL] "Understanding idempotency errors" |
| With bulk operations (`bulkOperationRunMutation`), idempotency applies per JSONL row, so each row needs its own key. | [IDEM-IMPL] "Using idempotency with bulk operations"; [IDEM] |
| **Compare-and-swap (CAS):** `changeFromQuantity: Int` is the expected current quantity. A mismatch makes the mutation fail with `CHANGE_FROM_QUANTITY_STALE`. Passing `null` opts out. The field was added as optional in 2026-01 and must be explicitly present from 2026-04, either a value or `null`, or the mutation returns an error. The schema still shows it as optional (`Int`, not `Int!`). The guide says `productVariantsBulkUpdate` also uses CAS. | [I-CHG], [I-QTY], [I-TERM], [I-SQ]; [GUIDE] "Compare and swap"; adjust/move/setOnHand: [CL] https://shopify.dev/changelog/compare-and-swap-for-inventory-mutations-with-change-from-quantity (2026-01) and https://shopify.dev/changelog/making-changefromquantity-field-required (2026-04); set: [CL] https://shopify.dev/changelog/compare-and-swap-redesign-for-inventory-set-quantities (2026-01) and https://shopify.dev/changelog/finalizing-compare-and-swap-redesign-for-inventory-set-quantities (2026-04) |
| The guide recommends always using CAS. Opting out is only for when "you're the source of truth". | [GUIDE] "Opting out of compare and swap" |
| The error code when `changeFromQuantity` is omitted entirely is **NOT DOCUMENTED**. | -- |
| Whether a CAS mismatch on one entry rejects the whole call (all-or-nothing) or only that entry is **NOT DOCUMENTED**. | -- |
| `referenceDocumentUri` explains why the change happened. A GID is preferred (`gid://<app>/<Entity>/<id>`). URLs and custom schemes are also accepted. It must be a valid URI with scheme and content. Shopify GIDs such as `gid://shopify/Order/…` are allowed here. It appears in the admin adjustment history and in Analytics reports. Query parameters are allowed (`gid://ns/Entity/id?location=west`). Guide regex: `/^gid:\/\/[^\/]+\/[^\/]+\/[^\/?]+(\?.*)?$/`. | [I-ADJ], [I-SET], [I-MOVE]; [GUIDE] "Using referenceDocumentUri for inventory traceability" |
| `ledgerDocumentUri` identifies the exact ledger entry or transaction. It must be a non-Shopify URI (`gid://shopify/*` is forbidden, error `INTERNAL_LEDGER_DOCUMENT`). It is **required for every quantity name except `available`** and **not allowed for `available`** (`INVALID_QUANTITY_DOCUMENT` / `INVALID_AVAILABLE_DOCUMENT`). | [I-CHG], [I-TERM]; [GUIDE] "Adjust inventory quantities" |
| `committed` cannot be adjusted or moved through the API. Shopify manages it through orders, draft-order reservations and transfers or shipments marked ready to ship. | [GUIDE] Step 3 Note; [STATES] Limitations |
| `on_hand` = available + committed + reserved + damaged + safety_stock + quality_control. `incoming` is not on hand. The listed states are mutually exclusive. | [STATES] "Inventory states"; [GUIDE] |
| From 2026-04, quantity mutations on an item not stocked at a location create an **inactive** InventoryLevel and store the quantity. The item is not sellable there until `inventoryActivate` / `inventoryBulkToggleActivation`. The guide says `ITEM_NOT_STOCKED_AT_LOCATION` was returned only before 2026-04. The enum value itself was still listed in the 2026-04 and 2026-07 enums and was removed in 2026-10. Also from 2026-04, deactivating a level no longer clears its quantities, and inactive levels "can be adjusted just like active ones". | [GUIDE] Step 3; [CL] https://shopify.dev/changelog/removal-of-itemnotstockedatlocation-error; .../2026-04 and .../2026-07 enums/InventoryAdjustQuantitiesUserErrorCode.md; [CL] https://shopify.dev/changelog/add-isactive-field-to-inventorylevel |
| Webhooks: changes to `committed`, `reserved`, `damaged`, `safety_stock` and `quality_control` **don't trigger webhooks**. Inventory-related topics are `inventory_levels/update`, `/connect`, `/disconnect` and `inventory_items/create`, `/update`, `/delete`. | [STATES] "Webhooks" |
| Change dated Aug 2026: draft-order and transfer/shipment holds moved from `reserved` to `committed` (one-time migration; available and on_hand unchanged). Apps that used `reserved` to detect those holds should read `committed`. | [CL] https://shopify.dev/changelog/draft-order-and-transfer-shipment-inventory-is-moving-from-reserved-to-committed |

### Allowed `reason` values (same list for all three; input type is `String!`, not an enum)
`correction`, `cycle_count_available`, `damaged`, `movement_created`, `movement_updated`, `movement_received`,
`movement_canceled`, `other`, `promotion`, `quality_control`, `received`, `reservation_created`,
`reservation_deleted`, `reservation_updated`, `restock`, `safety_stock`, `shrinkage`.
Source: [GUIDE] "Set inventory quantities on hand" (reason table). [I-ADJ], [I-SET] and [I-MOVE] link to this list as "possible reasons".
The output `InventoryAdjustmentGroup.reason` is a human label, for example `"correction"` becomes `"Inventory correction"` and `"damaged"` becomes `"Damaged"`
([ADJ]/[SET]/[MOVE] example responses). A full input-to-label mapping is **NOT DOCUMENTED**. An invalid reason gives `INVALID_REASON`.

---

## 2. inventoryAdjustQuantities (delta)

**InventoryAdjustQuantitiesInput** ([I-ADJ]):
- `name: String!` is the quantity name to adjust.
- `reason: String!`
- `referenceDocumentUri: String` is optional.
- `changes: [InventoryChangeInput!]!`

**InventoryChangeInput** ([I-CHG]):
- `inventoryItemId: ID!`
- `locationId: ID!`
- `delta: Int!`
- `changeFromQuantity: Int` must be passed, either a value or `null`, as described in section 1.
- `ledgerDocumentUri: String` is required unless `name` is `available`.
- There is NO `compareQuantity` or `ignoreCompareQuantity` field.

**Allowed names**: `available`, `damaged`, `incoming`, `quality_control`, `reserved`, `safety_stock` ([GUIDE] "Adjust inventory quantities"; [STATES]).
`on_hand` is not in the list. Whether adjusting `on_hand` directly is accepted is **NOT DOCUMENTED** (`committed` is explicitly forbidden).

**Ledger rules** ([GUIDE]):
- Every entry must use the same `ledgerDocumentUri`. Different values, or a URI on only some entries, give `MAX_ONE_LEDGER_DOCUMENT`.
- A missing URI for a non-available name gives `INVALID_QUANTITY_DOCUMENT`.
- Any URI for `available` gives `INVALID_AVAILABLE_DOCUMENT`.

**Response**: adjusting `available` by -4 returns two changes, `available -4` and `on_hand -4`, so Shopify adds the derived on_hand change ([ADJ] example response).

**userErrors codes** ([E-ADJ]):
- Request and data errors: ADJUST_QUANTITIES_FAILED ("Try again"), CHANGE_FROM_QUANTITY_STALE, INVALID_INVENTORY_ITEM, INVALID_LOCATION, INVALID_QUANTITY_NAME, INVALID_REASON, INVALID_REFERENCE_DOCUMENT, NON_MUTABLE_INVENTORY_ITEM (for example a parent bundle), SERVICE_UNAVAILABLE.
- Idempotency errors: IDEMPOTENCY_CONCURRENT_REQUEST, IDEMPOTENCY_KEY_PARAMETER_MISMATCH, IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED.
- Ledger document errors: INTERNAL_LEDGER_DOCUMENT, INVALID_AVAILABLE_DOCUMENT, INVALID_LEDGER_DOCUMENT, INVALID_QUANTITY_DOCUMENT, MAX_ONE_LEDGER_DOCUMENT.
- Quantity limits: INVALID_QUANTITY_TOO_HIGH ("can't be higher than 2,000,000,000"), INVALID_QUANTITY_TOO_LOW ("can't be lower than -2,000,000,000").

Whether an adjustment may drive `available` negative is **NOT DOCUMENTED** explicitly. The enum allows down to -2,000,000,000 and has no NEGATIVE code. The official [ADJ] example also hints at it: it sends `changeFromQuantity: 1` with `delta: -4` (a result of -3) and the shown response has empty `userErrors`. That is an example, not a stated rule.

---

## 3. inventorySetQuantities (absolute)

**InventorySetQuantitiesInput** ([I-SET], 2026-10):
- `name: String!` accepts only `available` or `on_hand` (anything else gives `INVALID_NAME`).
- `reason: String!`
- `referenceDocumentUri: String` is optional.
- `quantities: [InventoryQuantityInput!]!`
- `ignoreCompareQuantity` is **gone** in 2026-10. It was present but deprecated in 2026-01 (https://shopify.dev/docs/api/admin-graphql/2026-01/input-objects/InventorySetQuantitiesInput.md) and removed in 2026-04 ([CL] https://shopify.dev/changelog/finalizing-compare-and-swap-redesign-for-inventory-set-quantities).

**InventoryQuantityInput** ([I-QTY], 2026-10):
- `inventoryItemId: ID!`
- `locationId: ID!`
- `quantity: Int!`
- `changeFromQuantity: Int` must be passed, either a value or `null`.
- `compareQuantity` is **gone** in 2026-10. It was deprecated in 2026-01 and removed in 2026-04, per the same sources.
- There is no `ledgerDocumentUri` on this input.

**CAS** ([SET] description): "As of 2026-04, each quantity in `quantities` must include a `changeFromQuantity` value… otherwise returns a `CHANGE_FROM_QUANTITY_STALE` error… Omitting `changeFromQuantity` returns an error."
The mismatch code is CHANGE_FROM_QUANTITY_STALE. In 2026-01, passing any `changeFromQuantity` (including `null`) overrode `compareQuantity` and `ignoreCompareQuantity`
([CL] https://shopify.dev/changelog/compare-and-swap-redesign-for-inventory-set-quantities).

**Usage note**: "Only use this mutation if calling on behalf of a system that acts as the source of truth for inventory quantities, otherwise please consider using the inventoryAdjustQuantities mutation." ([SET] Note)

**Response**: setting `available` to 42 from 1 returns `available +41` and `on_hand +41`, with `quantityAfterChange: null` ([SET] example).

**userErrors codes** ([E-SET]):
- Compare-and-swap errors: CHANGE_FROM_QUANTITY_STALE, COMPARE_QUANTITY_REQUIRED, COMPARE_QUANTITY_STALE (the last two are still listed even though their fields were removed).
- Idempotency errors: IDEMPOTENCY_CONCURRENT_REQUEST, IDEMPOTENCY_KEY_PARAMETER_MISMATCH, IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED.
- Request and data errors: INVALID_INVENTORY_ITEM, INVALID_LOCATION, INVALID_NAME, INVALID_REASON, INVALID_REFERENCE_DOCUMENT, NON_MUTABLE_INVENTORY_ITEM.
- Quantity limits: INVALID_QUANTITY_NEGATIVE ("can't be negative"), INVALID_QUANTITY_TOO_HIGH ("total… 1,000,000,000"), INVALID_QUANTITY_TOO_LOW ("total… -1,000,000,000").
- Duplicates: NO_DUPLICATE_INVENTORY_ITEM_ID_GROUP_ID_PAIR, meaning each item+location pair may appear only once per call.

Unlike adjust and move, this enum has no SERVICE_UNAVAILABLE and no "…_FAILED" code.

---

## 4. inventoryMoveQuantities (state to state)

**InventoryMoveQuantitiesInput** ([I-MOVE]):
- `reason: String!`
- `referenceDocumentUri: String!` is **required** here, unlike adjust and set.
- `changes: [InventoryMoveQuantityChange!]!`

**InventoryMoveQuantityChange** ([I-MCHG]):
- `inventoryItemId: ID!`
- `quantity: Int!`
- `from: InventoryMoveQuantityTerminalInput!`
- `to: InventoryMoveQuantityTerminalInput!`

**InventoryMoveQuantityTerminalInput** ([I-TERM]):
- `locationId: ID!`
- `name: String!`
- `changeFromQuantity: Int` is checked separately for each side. The guide comments read "last known available quantity" for `from` and "last known reserved quantity" for `to`.
- `ledgerDocumentUri: String` is required unless the name is `available`, and forbidden for `available`.

**Allowed names**: `available`, `damaged`, `incoming`, `quality_control`, `reserved`, `safety_stock` ([GUIDE] "Move inventory quantities between states"; [STATES]).
Moving out of `incoming` increases `on_hand`, and moving into `incoming` decreases it ([GUIDE]).

**Same location only.** [MOVE] says "between different states at a single location", and the error enum has `DIFFERENT_LOCATIONS` and `SAME_QUANTITY_NAME`.
Doc inconsistency: [I-MCHG] says a change "can either involve the same quantity name between different locations, or involve different quantity names between the same location". The error enum and [GUIDE] contradict the cross-location case.

**Response**: moving 10 from available to reserved returns `available -10` and `reserved +10`. No on_hand change is shown ([MOVE] example).
`quantityAfterChange` "always returns `null` immediately after running the mutation" ([GUIDE] move response comments).

**userErrors codes** ([E-MOVE]):
- Location and name rules: DIFFERENT_LOCATIONS, SAME_QUANTITY_NAME.
- Request and data errors: CHANGE_FROM_QUANTITY_STALE, INVALID_INVENTORY_ITEM, INVALID_LOCATION, INVALID_QUANTITY_NAME, INVALID_REASON, INVALID_REFERENCE_DOCUMENT, MOVE_QUANTITIES_FAILED ("Try again"), NON_MUTABLE_INVENTORY_ITEM, SERVICE_UNAVAILABLE.
- Idempotency errors: IDEMPOTENCY_CONCURRENT_REQUEST, IDEMPOTENCY_KEY_PARAMETER_MISMATCH, IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED.
- Ledger document errors: INTERNAL_LEDGER_DOCUMENT, INVALID_AVAILABLE_DOCUMENT, INVALID_LEDGER_DOCUMENT, INVALID_QUANTITY_DOCUMENT, MAXIMUM_LEDGER_DOCUMENT_URIS ("maximum of 2 ledger document URIs across all changes").
- Quantity limits: INVALID_QUANTITY_NEGATIVE, INVALID_QUANTITY_TOO_HIGH (2,000,000,000).

---

## 5. inventorySetOnHandQuantities (deprecated)

- Status: "Deprecated. Use inventorySetQuantities to set on_hand or available quantities instead." It is still present in 2026-10 with the same `write_inventory` scope, and it still requires `@idempotent` from 2026-04 ([ONHAND]).
- **InventorySetOnHandQuantitiesInput** ([I-ONHAND]): `reason: String!`, `referenceDocumentUri: String`, `setQuantities: [InventorySetQuantityInput!]!`.
- **InventorySetQuantityInput** ([I-SQ]): `inventoryItemId: ID!`, `locationId: ID!`, `quantity: Int!`, `changeFromQuantity: Int`, which is mandatory to pass, even as `null`.
- userErrors codes ([E-ONHAND]):
  - Compare-and-swap errors: CHANGE_FROM_QUANTITY_STALE, COMPARE_QUANTITY_STALE.
  - Idempotency errors: IDEMPOTENCY_CONCURRENT_REQUEST, IDEMPOTENCY_KEY_PARAMETER_MISMATCH, IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED.
  - Request and data errors: INVALID_INVENTORY_ITEM, INVALID_LOCATION, INVALID_REASON, INVALID_REFERENCE_DOCUMENT, NON_MUTABLE_INVENTORY_ITEM, SERVICE_UNAVAILABLE, SET_ON_HAND_QUANTITIES_FAILED.
  - Quantity limits: INVALID_QUANTITY_NEGATIVE, INVALID_QUANTITY_TOO_HIGH (1,000,000,000).
- The removal version for this mutation is **NOT DOCUMENTED**.

---

## 6. Response objects

**InventoryAdjustmentGroup** ([O-GRP], needs `read_inventory`):
- `id: ID!`
- `createdAt: DateTime!`
- `reason: String!`, a human label
- `referenceDocumentUri: String`
- `app: App`
- `staffMember: StaffMember`
- `changes(inventoryItemIds: [ID!], locationIds: [ID!], quantityNames: [String!]): [InventoryChange!]!`

**InventoryChange** ([O-CHG]):
- `name: String!`
- `delta: Int!`
- `quantityAfterChange: Int` is null right after the mutation, per [GUIDE].
- `ledgerDocumentUri: String`
- `item: InventoryItem`
- `location: Location`

**Reading current quantities** for `changeFromQuantity` ([O-LVL]; [GUIDE] Step 2):
- `InventoryLevel.quantities(names: [String!]!)` returns `[InventoryQuantity!]!` with `{ id: ID!, name: String!, quantity: Int!, updatedAt: DateTime }`. `updatedAt` is nullable (.../objects/InventoryQuantity.md).
- Names: incoming, on_hand, available, committed, reserved, damaged, safety_stock, quality_control.
- Also on `InventoryLevel`: `isActive: Boolean!` (2026-04+). It is absent from the 2026-01 page and present from 2026-04 ([CL] https://shopify.dev/changelog/add-isactive-field-to-inventorylevel).
- `includeInactive` argument (optional, default false) on the `inventoryLevels` / `inventoryLevel` fields of `InventoryItem` and `Location` (2026-04+) ([CL] https://shopify.dev/changelog/add-includeinactive-argument-to-inventorylevels-and-inventorylevel-fields).
- `InventoryLevel.scheduledChanges` is deprecated. `inventorySetScheduledChanges` "isn't available in the 2026-07 Admin API", so expected dates for `incoming` cannot be stored in Shopify in 2026-10 ([GUIDE] "Schedule changes to inventory quantities"; [O-LVL]).

---

## 7. Rate limits, cost and input limits

| Fact | Source |
|---|---|
| Cost-based leaky bucket per app+store. Restore rate is 100 points/s (Standard), 200 (Advanced), 1000 (Plus), 2000 (Commerce Components). | [RL] |
| Default field cost: Mutation = 10, Object = 1, Scalar/Enum = 0. Shopify "reserves the right to set manual costs on fields". The actual costs of these three mutations are **NOT DOCUMENTED**. Read `extensions.cost` in the response, or send the `Shopify-GraphQL-Cost-Debug=1` header. | [RL] "Cost calculation", "GraphQL response" |
| A single query costs at most 1,000 points (checked against requested cost before execution). | [RL] "Single query limit" |
| Input arrays may hold at most **250 items** on every Shopify API. This applies to `changes` and `quantities`, and requests above that return an error. | [RL] "Input limits"; [LIM] "Input limits" |
| The recommended backoff after throttling is 1 second. | [LIM] "Avoiding rate limit errors" |
| A mutation-specific maximum for changes per call, beyond the generic 250, is **NOT DOCUMENTED**. | -- |

---

## 8. Gaps and inconsistencies to handle defensively

1. The runtime error returned when `@idempotent` or `changeFromQuantity` is omitted in 2026-04+ is NOT DOCUMENTED (format and code). The changelog only says "error at runtime".
2. Whether CAS failure or partial validation failure is atomic across a multi-entry `changes`/`quantities` array is NOT DOCUMENTED.
3. It is NOT DOCUMENTED whether a retry that reuses the key after `CHANGE_FROM_QUANTITY_STALE` returns `IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED` or the cached error. The enum says a key whose previous attempt failed must be replaced with a new key. A retry with an updated `changeFromQuantity` changes the parameters anyway, so it would hit `IDEMPOTENCY_KEY_PARAMETER_MISMATCH` with the old key and needs a new key.
4. The bulk-operation JSONL example in [IDEM-IMPL] omits `changeFromQuantity`, which conflicts with the 2026-04+ requirement. Follow the reference pages, not that example.
5. [I-MCHG] wording on cross-location moves conflicts with `DIFFERENT_LOCATIONS` and the guide. Treat moves as same-location only.
6. [E-SET] still lists COMPARE_QUANTITY_REQUIRED and COMPARE_QUANTITY_STALE although the fields were removed. Handle them as stale/conflict anyway.
7. [E-SET] lists both INVALID_QUANTITY_NEGATIVE and INVALID_QUANTITY_TOO_LOW (-1,000,000,000). It is NOT DOCUMENTED which one applies when.
8. Whether `inventoryAdjustQuantities` accepts `name: "on_hand"` is NOT DOCUMENTED (it is not in the allowed list).
9. Non-`available` state changes (reserved, damaged, quality_control, safety_stock, committed) fire no webhooks. External changes to those states can only be detected by polling `InventoryLevel.quantities`.

---

## Verification notes

Re-verified on 2026-11-27 by a second agent against the primary sources: every page listed above, the 2026-01, 2026-04, 2026-07 and 2026-10 versions of the key input objects and enums, and the changelog entries.

**Confirmed unchanged:**
- All input field names, types and nullability: `name`, `reason`, `referenceDocumentUri`, `changes`, `quantities`, `delta`, `quantity`, `changeFromQuantity`, `ledgerDocumentUri`, `from`/`to`, and `setQuantities`.
- `referenceDocumentUri` is `String!` only on move.
- All four userError enums, value for value, including the numeric limits.
- Scopes and user-permission wording.
- The `@idempotent` timeline: optional in 2026-01, required in 2026-04.
- Removal of `compareQuantity`/`ignoreCompareQuantity` in 2026-04. Both are marked "Deprecated (removal date set)" on the 2026-01 pages.
- The 17 reason values.
- The allowed quantity names per mutation.
- The example responses (adjust and set add an `on_hand` change; move does not).
- The 24h key retention, rate-limit figures, the 250-item input limit, and the webhook list.
- `/2026-10/` and `/latest/` are identical for the mutations, the input objects (adjust, change, set, quantity, move, terminal) and the 3 main enums. Only the example URLs differ.

**Corrections made in place:**
1. The [GUIDE] and [STATES] URLs were the old `orders-fulfillment/...` paths, which now 301-redirect. They are replaced with the canonical `/docs/apps/build/inventory-management-apps/...` paths.
2. CAS citation: `making-changefromquantity-field-required` covers adjust, move, setOnHand and productVariantsBulkUpdate only. It does NOT cover `inventorySetQuantities`, which is covered by `finalizing-compare-and-swap-redesign-for-inventory-set-quantities`. Added the 2026-01 introduction changelogs: the field was optional in 2026-01.
3. `ITEM_NOT_STOCKED_AT_LOCATION`: the guide says it stopped being returned from 2026-04. The enum value was still listed in 2026-04 and 2026-07 and was removed in 2026-10. Added that inactive levels keep quantities and can be adjusted (2026-04+).
4. `MAX_ONE_LEDGER_DOCUMENT` is also returned when only some entries carry a `ledgerDocumentUri`, per [GUIDE].
5. Added: idempotency errors are returned in `userErrors` (`field: null`), per [IDEM-IMPL].
6. Added doc conflict: [IDEM-IMPL] says to reuse the key after a failed response, while `IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED` says to use a new key. Safe reading: reuse the key on a timeout, network error or `IDEMPOTENCY_CONCURRENT_REQUEST`, and use a new key after `IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED` or when parameters change, such as a new `changeFromQuantity` after `CHANGE_FROM_QUANTITY_STALE`. This is an inference from the two texts, not a documented rule.
7. `isActive` now has its own changelog citation. `includeInactive` is scoped to the `InventoryItem`/`Location` fields. `InventoryQuantity.updatedAt` is nullable.
8. Added that `scheduledChanges` is deprecated and `inventorySetScheduledChanges` is unavailable from 2026-07.
9. Negative-available gap: noted that the official adjust example (`changeFromQuantity: 1`, `delta: -4`) succeeds. It is still NOT DOCUMENTED as a rule.

**Still NOT DOCUMENTED (unchanged after re-check):**
- The exact runtime error when `@idempotent` or `changeFromQuantity` is omitted.
- Whether a multi-entry call is atomic. No page mentions atomic, all-or-nothing or partial application.
- A maximum length or format for the key. `.../directives/idempotent.md` returns 404, and the `/2026-10/` variant returns 301 to that 404.
- The real query costs of these mutations, and the bucket size per plan (only restore rates are listed).
- Whether adjust accepts `name: "on_hand"`.
- A removal version for `inventorySetOnHandQuantities`.

**Out of scope for 2026-10:**
- The "Physical inventory" feature preview (bins, `inventoryCountCreate`, purchase orders) exists only in the `unstable` version, behind a dev-store preview (https://shopify.dev/changelog/physical-inventory-feature-preview). Do not use it.
