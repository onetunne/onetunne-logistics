# Етап 5 — склад, виробництво, упаковка, підготовка замовлень (проєкт)

Документ для розробників (і короткий огляд для власника). Інваріанти тут — обов'язкові.

## 1. Принципи
- **Журнал руху (ledger) — єдине джерело внутрішнього обліку.** Кожна зміна залишку — рядок `inventory_movements`
  з дельтами по «кошиках» і **унікальним ключем ідемпотентності** (`idempotency_key`). Повтор тієї самої бізнес-події
  (повторний webhook, подвійне натискання, повтор завдання) не створює другого руху → **немає подвійного списання чи
  резервування**.
- **Баланси** (`inventory_balances`) змінюються ЛИШЕ разом із вставкою руху, в одній транзакції, з блокуванням рядків
  балансу (`FOR UPDATE`, у порядку `stock_item_id`, щоб уникнути взаємоблокувань).
- Кошики: `on_hand` (фізично на складі, включно з зарезервованими й запакованими), `reserved` (під оплачені
  незавершені замовлення), `defective` (брак/пошкоджені, не продаються), `in_production` (замовлено у виробництві).
  **Доступно для продажу = on_hand − reserved** (брак окремо, не входить в on_hand).
- Обмеження БД: `reserved ≥ 0`, `defective ≥ 0`, `in_production ≥ 0`. `on_hand < 0` допускається лише для подій,
  що вже фізично відбулися (передача перевізнику, зміна в Shopify) — тоді створюється попередження про розбіжність.
- Позиція обліку — `stock_items`: варіант товару (`variant_id`) або пакувальний матеріал (`material_id`), рівно одне.
- Склад — таблиця `warehouses` (одна «Основний склад» за замовчуванням; `warehouse_id` у всіх таблицях — для кількох
  складів у майбутньому; `shopify_location_id` — відповідність локації Shopify).

## 2. Резервування й списання (замовлення)
- `syncOrderReservations(tx, orderId)` обчислює **бажаний стан** з замовлення й застосовує лише різницю:
  оплачене, не скасоване, не передане → зарезервовано кількість до відправлення кожної позиції (Shopify
  `currentQuantity` — без повернених і видалених одиниць; `order_line_items.current_quantity`, `effectiveLineQuantity`);
  передано перевізнику → списано (`on_hand −q`, `reserved −q`); скасовано до передачі → резерв знято.
- Резервуються лише **відкриті** товари (`inventory_balances.opened_at`, див. §11): невідстежувані в Shopify варіанти
  й нові, ще не відкриті, — без резервів і хибних попереджень.
- Перша поява позиції порівнюється з часом знімка Shopify товару (`opening_snapshot_at`) за `orders.placed_at`:
  замовлення, створене до знімка, уже вилучене з «доступно» знімка → при першому резерві корекція `on_hand +q`
  (`opening_line:<lineItemId>`), а вперше побачене вже переданим — не списується (історичне); створене після знімка —
  звичайний продаж (уперше побачене переданим → списання без резерву).
- Ключі: `reserve:<lineItemId>:<seq>` / `release:<lineItemId>:<seq>` / `consume:<lineItemId>` (списання — один раз на позицію).
- Викликається після кожної зміни замовлення: синхронізація з Shopify (нове/оновлене/скасоване), скасування в застосунку,
  передача перевізнику (відстеження або менеджер). Зміна позицій у Shopify (лише кількість/видалення/заміна, без зміни
  контактів) → оновлення позицій і різниця резерву; з активною накладною — проблема `SHOPIFY_ORDER_CHANGED` (`lineItems`).
  Виконання в Shopify не застосунком (до передачі) → проблема `SHOPIFY_FULFILLED_OUTSIDE_APP` (резерв лишається).
- **Списання — при фактичній передачі перевізнику**, не при створенні накладної й не при пакуванні: саме тоді Shopify
  теж зменшує свій `on_hand` (виконання з трек-номером, етап 3) → обидві системи узгоджені без подвійного списання.

## 3. Синхронізація з Shopify (див. факти в розділі 9)
- Зміни, які Shopify робить сам (продаж → committed, виконання → on_hand), у Shopify **не надсилаються** — у застосунку
  їм відповідають резерв/списання.
- Внутрішні події, яких Shopify не знає (надходження з виробництва, брак, ручні коригування), надсилаються в Shopify
  **дельтою** через чергу завдань з ідемпотентністю (якщо власник увімкнув і є дозвіл `write_inventory`).
- Зміни, зроблені в Shopify вручну (не застосунком), не перезаписуються мовчки: **розбіжність** (`inventory_conflicts`)
  → власник обирає «прийняти значення Shopify» (рух `shopify_external`) або «надіслати значення складу».
- Звірка: порівняння `on_hand` застосунку й Shopify по кожному варіанту з поясненням очікуваних різниць.

## 4. Виробництво
- Партії (`production_batches`) → позиції (`production_batch_lines`: варіант, замовлено, отримано, брак, собівартість
  одиниці — лише власник) → надходження (`production_receipts` + рядки: якісні й браковані).
- Статуси: заплановано → у виробництві → частково отримано → отримано → закрито; скасовано.
- Рухи: запуск (`in_production +`), надходження (`in_production −`, `on_hand +` якісні, `defective +` брак), закриття
  залишку (`in_production −`). Ключі — за id позиції/рядка надходження.

## 5. Упаковка
- Матеріали (`packaging_materials`: коробки з внутрішніми габаритами, макс. вагою й вагою тари; наклейки, інструкції,
  візитки, болти тощо) — облік через той самий журнал.
- Шаблони комплектації (`kit_templates` + рядки + товари): що додається до замовлення/до кожної одиниці товару.
- Підбір коробки — чиста функція за габаритами й вагою товарів (найменша, що вміщує); ручне коригування ваги й
  габаритів посилки на рівні замовлення; ці параметри використовує створення накладної.
- Витрати матеріалів списуються при підтвердженні пакування (ключ `material:<packingId>:<materialId>`).

## 6. Підготовка замовлень
- Черга пакування: замовлення з накладною (накладна створена / очікує комплектації / запаковано), пріоритет
  (`orders.priority`), сортування за пріоритетом і датою.
- Контроль комплектації: чекліст позицій, сканування штрихкоду/SKU (сканер або ручне введення; камера — де підтримується),
  невідповідність → помилка; підтвердити «Запаковано» можна лише з повним комплектом.
- Фіксація працівника (хто почав, хто запакував, коли), історія замовлення.
- Масові дії: почати пакування, друк пакувальних листів / інвойсів / етикеток.

## 7. Аналітика складу
- Продажі за період за товарами/кольорами/моделями; швидкість продажів (30/90 днів); днів запасу; дата вичерпання;
  рекомендація партії = швидкість × (термін виробництва + цільовий запас) − (доступно + у виробництві).
- Експорт CSV; дані для майбутнього фінансового модуля (собівартість — лише власник) і ШІ (інструменти асистента).

## 8. Telegram (підготовка)
- Сервісний шар команд складу з перевіркою прав (`modules/warehouse/commands.server.ts`) і реєстрацією в інструментах
  асистента (етап 4); попередження про низькі залишки (`stock_alerts`) — джерело для майбутніх сповіщень.

## 9. Факти Shopify API (перевірено за shopify.dev, версія 2026-10)
Повні таблиці з посиланнями — `docs/research/stage5/`.
- Стани: `available`, `committed`, `reserved`, `damaged`, `safety_stock`, `quality_control`, `incoming`, `on_hand`;
  `on_hand = available + committed + reserved + damaged + safety_stock + quality_control`.
- Замовлення: `available −n`, `committed +n`. Виконання: `committed −n` (отже `on_hand −n`) — **Shopify сам**.
  `committed` через API змінити не можна.
- Запис: `inventoryAdjustQuantities` (дельта; `available` та інші, крім `on_hand`/`committed`), `inventorySetQuantities`
  (лише `available`/`on_hand`, абсолютне значення), `inventoryMoveQuantities` (між станами однієї локації).
  Обов'язково: директива `@idempotent(key:)` (ключі живуть 24 год) і `changeFromQuantity` (число або явний `null`);
  розбіжність → `CHANGE_FROM_QUANTITY_STALE`. Для станів, крім `available`, потрібен `ledgerDocumentUri` (не `gid://`).
- Дозволи: читання — `read_inventory`; запис — `write_inventory` (+ дозвіл працівника в Shopify).
- Webhook `inventory_levels/update`: лише `available` (немає `on_hand`/`committed`, немає автора зміни); зміни
  committed/reserved/damaged/... webhooks не викликають; порядок і доставка не гарантовані → потрібна періодична звірка.
- Камера: BarcodeDetector у Safari iOS вимкнено за замовчуванням; доступ до камери в iframe адмінки Shopify не
  задокументовано; App Bridge Scanner — для мобільних застосунків Shopify/POS.

## 10. Рішення для синхронізації з Shopify
- Порівнюємо **доступну** кількість: застосунок `on_hand − reserved` ↔ Shopify `available` (резерв застосунку відповідає
  `committed` Shopify). Брак застосунку в Shopify не існує як окремий стан (знімається з `available`).
- Надсилання (лише якщо `warehouse.shopifyPush = 'deltas'` і є `write_inventory`): для внутрішніх подій
  (надходження, ручне коригування, брак, ремонт браку) — завдання черги `inventory.push` → `inventoryAdjustQuantities`
  `name: "available"`, `delta`, `changeFromQuantity: null` (дельти комутативні, перезапису немає),
  `@idempotent(key: "ot-mv-<movementId>")`, `referenceDocumentUri` = посилання на рух у застосунку.
  Стан руху: pending → pushed / failed. Повтор після 24 год без підтвердження — лише після звірки (ручний розгляд).
- Webhook `inventory_levels/update` → не застосовується одразу: через ~10 хв планується звірка цієї позиції (щоб замовлення
  встигло синхронізуватися й зарезервуватися). Стійка розбіжність → `inventory_conflicts` (або автоматичне прийняття,
  якщо власник обрав `externalShopifyChanges = 'apply'`).
- Розв'язання розбіжності: «прийняти Shopify» → рух `shopify_external` (on_hand += різниця); «надіслати склад» →
  `inventoryAdjustQuantities` з `changeFromQuantity` = побачене значення Shopify (CAS; застаріле → нова звірка).
- Сканування: поле введення (сканер-клавіатура або вручну), камера через BarcodeDetector лише там, де підтримується.
- Масовий друк етикеток перевізника: об'єднання PDF на сервері (`pdf-lib`, MIT); зашифровані PDF — по одному.

## 11. Ядро обліку (реалізовано) — для розробників модулів етапу 5
Міграція `drizzle/0005_warehouse_production.sql`; таблиці — `app/db/schema.ts` (розділ «Етап 5»).
- `modules/inventory/ledger.server.ts`: `applyMovements(tx, actor, inputs[])` — ЄДИНИЙ спосіб змінити залишок
  (точка збереження, блокування FOR UPDATE за `(stock_item_id, warehouse_id)`, ключ ідемпотентності, перевірка кошиків,
  попередження). Одна логічна операція → один виклик. `lockBalances` — для операцій «встановити значення»
  (інвентаризація): заблокувати → дельта від поточного → `applyMovements` у тій самій транзакції.
  Читання: `getBalances`, `getBalance`, `movementHistory` (собівартість лише з `includeCosts` = `finance.view`),
  `listOpenAlerts`, `evaluateStockAlerts`, `setLowStockThreshold`, `ensureStockItemForVariant(s)/ForMaterial`.
- `modules/inventory/movement-types.ts`: типи руху й правила кошиків (напр. `reserved` змінюють лише reserve/release/
  consume_sale; ручне коригування — лише on_hand/defective; матеріали — без резервів). `defaultShopifySyncState`:
  внутрішні зміни on_hand товару → `pending` (push = deltas) або `skipped` (push = off); решта — `none`.
- `modules/inventory/keys.ts`: ключі ідемпотентності (`reserve/release:<line>:<seq>`, `consume:<line>`,
  `production_start:<line>:<version>`, `receipt_production:<receiptLine>`, `production_close:<line>`,
  `material:<packing>:<material>`, `shopify_external:<conflict>`, `manual:<uuid форми/команди>`, `opening:<w>:<item>`).
- `modules/inventory/reservations.server.ts`: `syncOrderReservations(tx, orderId, actor)` викликається в транзакції
  зміни замовлення: синхронізація Shopify (`upsertOrder`), `cancelOrder`, передача (`applyTrackingSnapshot`,
  `markHandedOver`), демо-замовлення — ДО інших `applyMovements` цієї транзакції (порядок: замовлення → склад → баланси).
  Правила першої появи позиції — §2. `effectiveLineQuantitySql`/`effectiveLineQuantity` (`quantities.ts`) — кількість для
  складу, черги пакування й аналітики продажів; `loadOrderReservations`, `loadOpenedVariants`.
- `modules/inventory/opening.server.ts`: `initializeInventory(ctx)` (лише `warehouse.adjust`) відкриває кожен
  відстежуваний варіант один раз: on_hand = H + max(0, S + Σ відкритих оплачених замовлень, створених до T), де S —
  `inventory_available`, T — `product_variants.inventory_synced_at` (час знімка) або момент відкриття, H — внутрішні рухи до
  відкриття (додаються; H ≠ 0 → `inventory_conflicts` `opened_with_internal_history` для перевірки власником). Знімок,
  позначки відкриття й резерви всіх відкритих замовлень — ОДНА транзакція (склад FOR NO KEY UPDATE; замовлення не
  блокуються); повтор при взаємоблокуванні. Повторний виклик відкриває лише нові варіанти. `getInventoryOpeningStatus`,
  `syncAllOpenOrderReservations` (відновлення; `{ synced, failed }`).
- Невідкритий товар: `reserve/release/consume_sale/shopify_external` → `inventory.notOpened` (409); внутрішні зміни on_hand
  → `skipped` (не надсилаються в Shopify до відкриття).
- Блокування: рядок замовлення — лише FOR NO KEY UPDATE (`loadOrderRow({ forUpdate })`, `upsertOrder`): FOR UPDATE
  конфліктує з перевіркою зовнішніх ключів (KEY SHARE) під час вставки рухів/резервів замовлення в ініціалізації.
- `modules/inventory/warehouse.server.ts`: `getDefaultWarehouse` («Основний склад», рівно один — `is_default`; у базах до
  етапу 5 — наявний склад приймається за замовчуванням, міграція 0005 робить те саме).
- Позиції замовлень Shopify оновлюються зі збереженням id (`replaceLineItems`) — на них посилаються резерви й чекліст.
- `orders.parcel_*` (ручні вага/габарити посилки) уже враховуються в `buildShipmentRequest`.
- Налаштування `warehouse` (власник): поріг, термін виробництва, цільовий запас, округлення партії, `shopifyPush`,
  `externalShopifyChanges`, `allowNegativeOnHand` (лише для shopify_external; передача перевізнику — завжди).
- Дозволи: `warehouse.view|receive|adjust`, `production.manage`, `packing.perform`; працівник типово —
  view, receive, perform; собівартість — `finance.view` (лише власник).
