# CLAUDE.md — контекст і правила розробки ONE TUNNE Logistics

Приватна ERP-система (Embedded Shopify App) для логістики магазину onetunne.com.
Повна кінцева концепція — `REQUIREMENTS.md`. Прогрес і наступні кроки — `ROADMAP.md`.
Не повторюй повний аналіз проєкту: спирайся на ці файли.

## Правила роботи
- Власник не програміст. Спілкування українською, коротко, з покроковими інструкціями, коли потрібна його дія.
- Виконуй лише поточний етап (див. ROADMAP.md). Не переходь до наступного без команди власника.
- Не об'єднуй з основною гілкою без підтвердження. Не підключай робочий магазин, не створюй справжніх накладних,
  не надсилай реальних повідомлень, не підключай платні сервіси без дозволу.
- Не вигадуй методи/параметри зовнішніх API. Nova Global — лише після офіційної документації й ключів.
  Внутрішній український API Nova Post не є заміною міжнародному без підтвердженої сумісності.
- Не вважай функцію готовою, якщо є лише інтерфейс. Чітко розрізняй: реалізовано / демо / заплановано.
- Не заявляй про успішні тести, якщо їх не запускали. Не приховуй помилок і обмежень.
- Жодних реальних персональних даних і секретів у коді, журналах, GitHub, Telegram, запитах до ШІ.

## Стек (етап 1)
- TypeScript (strict, `noUncheckedIndexedAccess`), React 18, React Router 7 (framework mode, SSR), Vite 7.
- Офіційний `@shopify/shopify-app-react-router` (Embedded App, App Bridge, GraphQL Admin API `2026-10`).
- PostgreSQL через Drizzle ORM. Демо й тести — PGlite (справжній Postgres у процесі, без сервера).
- Перевірка даних: `libphonenumber-js/max`, zod.
- Власний UI-кит `app/ui` (чорно-білий, адаптивний, світла/темна тема, без CDN).
  Причина: Polaris web components вантажаться з cdn.shopify.com — недоступно в середовищі розробки
  і порушує автономність демо. У вбудованому режимі `AppProvider` додатково підключає App Bridge і Polaris.
- Тести: Vitest. E2E-перевірка: `scripts/e2e-smoke.mjs` (Playwright, якщо встановлено).

## Архітектура
```
app/
  domain/         чисті правила: статуси замовлень і переходи, ролі/дозволи, розділи навігації
  modules/        бізнес-логіка (без React/HTTP)
    validation/   перевірка даних (чиста функція validateOrder), правила країн за замовчуванням
    orders/       репозиторій, обробка: перевірка → автовиправлення з історією → проблеми → статус, ручні зміни
    shipments/    накладні з ідемпотентністю, звірка після збою, ручне прив'язування, скасування; вага
    settings/     схеми (zod) і версіоновані налаштування; audit/ — журнал; webhooks/ — дедуплікація
    inventory/    етап 5: журнал руху (ledger), баланси, резерви, відкриття обліку, ключі ідемпотентності, попередження
    inventory-sync/ етап 5: звірка й передача залишків у Shopify, розбіжності, планова звірка, повернення
    production/   етап 5: виробничі партії, надходження й брак, собівартість, статистика
    packaging/    етап 5: пакувальні матеріали, шаблони комплектації, підбір коробки, вага/габарити посилки
    packing/      етап 5: черга пакування, сканування, «Запаковано», друк, лист комплектації, список передачі
    warehouse/    етап 5: операції складу (надходження, брак, інвентаризація), команди для Telegram/ШІ
    warehouse-analytics/ етап 5: аналітика складу, прогноз і рекомендації партій, CSV-експорт
  integrations/   адаптери зовнішніх API за інтерфейсами
    carriers/     CarrierAdapter + тестовий перевізник (sandbox) + заглушка Nova Global
    shopify/      ShopifyGateway (демо-шлюз нічого не надсилає; робочий — етап 2)
    llm/ notifications/ messaging/ directories/  — лише інтерфейси (етапи 4–10)
  db/             схема Drizzle, клієнти (pg/PGlite), міграції, демо-дані
  server/         контекст запиту, середовища demo/production, cookie, shell
  pages/          сторінки (монтуються двічі: /demo/* і /app/*)
  routes/         макети, авторизація, webhooks, healthz, preferences
  ui/             UI-кит (компоненти + styles.css)
  components/     спільні компоненти застосунку (shell, бейджі, банер дій)
  i18n/           переклади uk (за замовч.) / en, по модулю на розділ; localize.ts — статуси/коди в повідомленнях
drizzle/          SQL-міграції (генеруються `npm run db:generate`, застосовуються при старті)
tests/            unit + інтеграційні тести (PGlite)
```

### Ключові інваріанти
- `/app/*` ЗАВЖДИ проходить `authenticate.admin`. Демо (`/demo/*`) працює лише при `DEMO_MODE=true`,
  має окрему базу PGlite і не може обійти авторизацію. `DEMO_MODE` + ключі Shopify у production → помилка старту
  (`getEnv()` викликається при завантаженні entry.server).
- Тестовий перевізник реєструється ЛИШЕ в демо. У робочому режимі перевізник за замовчуванням — Nova Global (поки `not_configured`).
- Накладні: одне активне відправлення на замовлення (частковий унікальний індекс), стабільний `carrierReference`,
  запис `creating` до виклику перевізника, невідомий результат → звірка за reference → інакше ручний розгляд.
- Створення накладної ≠ відправлення. Статус «Передано перевізнику» — лише після фактичної передачі.
- Автовиправлення — лише однозначні (формат телефону/індексу, копіювання наявного телефону). Неоднозначне → «Проблеми».
- Історія змін (`order_changes`): початкове/нове значення, джерело, правило/причина, актор.
- `audit_log` — без персональних даних. Логер маскує телефони/email/адреси.
- Гроші — `numeric(14,2)` + валюта, арифметика через BigInt (`app/lib/money.ts`).
- Дозволи перевіряються на сервері (`requirePermission`). Фінанси/ключі/критичні налаштування — лише власник.
- Час в інтерфейсі — Europe/Kyiv (`app/lib/format.ts`).
- Стани відправлення змінюються лише compare-and-set (`WHERE status IN (...)`); поки накладна `creating/unknown/created`,
  дані замовлення не редагуються. Відмова перевізника скасувати → накладна лишається активною.
- Сервер — `server.mjs` (Express). На хостингу за HTTPS-проксі обов'язково `TRUST_PROXY=1`, інакше перевірка Origin
  React Router відхиляє форми. Локально проксі не довіряємо (за замовчуванням).
- Демо-база: `npm run build` створює `build/demo-db-template` (міграції); новий каталог даних копіюється з нього
  (initdb PGlite потребує ~700 МБ пам'яті). Телефони: країна відправника (налаштування) — альтернативне тлумачення
  місцевих номерів (неоднозначність → менеджер).
  Ресурсні маршрути (без компонента) перевіряють Origin самі (`isSameOrigin`).
- Помилки логуються без тексту SQL і параметрів (`redact` для Error).

## Команди
- `npm run dev` — розробка (демо: `DEMO_MODE=true` у `.env`).
- `npm run demo` — збірка + запуск демо на http://localhost:3000/demo.
- `npm run check` — перевірка типів + тести + збірка. `npm test`, `npm run typecheck`, `npm run build`.
- `npm run db:generate` — нова міграція після зміни `app/db/schema.ts`.
- `npm run test:e2e` — E2E-перевірка демо (потрібен Playwright і запущений сервер).
- `npm run test:e2e:stage5` — E2E етапу 5 (scripts/e2e-stage5.mjs: власник/працівник, ПК і телефони 320/375/390, англійська;
  потрібен Playwright і запущене демо; BASE_URL, SCREENSHOTS_DIR). На початку скидає демо-дані. Для налагодження:
  `E2E_SKIP_PHONES=1`, `E2E_SKIP_EN=1`, `E2E_TIMEOUT` (мс на дію).

## Етап 2 (Shopify)
- Інструкція налаштування тестового сервера: `docs/shopify-test-server.md`. Документацію Shopify читати як
  `https://shopify.dev/docs/....md` (хост shopify.dev дозволено в середовищі `onetunne-logistics`).
- Потік: webhook (`/webhooks/shopify`, HMAC) → `webhook_events` (дедуплікація) → `jobs` → обробник
  (`modules/shopify-sync/handlers.server.ts`) перечитує дані через GraphQL (`integrations/shopify/graphql.ts`).
- Обробник черги стартує з сервером (`ensureJobWorker` в entry.server) лише за наявності ключів Shopify і DATABASE_URL.
- Зміни з Shopify не перезаписують замовлення з накладною або з неперенесеними підтвердженими змінами → проблема SHOPIFY_ORDER_CHANGED.
- Тести етапу 2 — `tests/stage2` з імітацією Admin API (`fixtures.ts`); реальний API перевіряє власник на тестовому магазині.

## Етап 3 (перевізник)
- Аналіз API: `docs/carrier-api-analysis.md`; архітектура перевізників: `docs/carrier-architecture.md`.
  Документація: nova.global/partners_api (розділи `_<name>_en.html`), api-portal.novapost.com (`.md`-версії, `llms.txt`),
  shopify.dev (`.md`). Хости дозволено в середовищі `onetunne-logistics`.
- Nova Post API v1.0: `integrations/carriers/nova-post/` — `client.server.ts` (JWT, таймаути, маскування секретів),
  `mapping.ts` (чисте відображення запитів/відповідей), `tracking-codes.ts`, `adapter.server.ts` (NovaPostAdapter).
  Реєструється в production лише з `NOVA_POSHTA_API_KEY`; РЕАЛЬНЕ створення накладних — лише з
  `NOVA_POST_SHIPMENTS_ENABLED=true` (окремий дозвіл власника), інакше `not_configured` без мережевого запиту.
- Класифікація помилок створення критична для дублікатів: сумнівне → `unknown_outcome` (звірка/ручний розгляд),
  `rejected` — лише коли перевізник точно відхилив дані. Пошук за `clientOrder` неавторитетний.
- Митниця: `modules/customs/invoice.ts` (інвойс, митні позиції), `address-parts.ts` (вулиця/будинок — лише однозначно).
  Nova Post: HS 8–10 цифр, вага позицій = вага посилки, адреса реєстрації для DE/SK/HU/FR — лише з налаштування власника.
- Тарифи Checkout: `modules/rates/*` + `routes/carrier-service.tsx` (CarrierService; запит Shopify не підписаний →
  секретний токен у шляху, маскується в журналах). Підключення до магазину — лише кнопкою власника.
- Відстеження: `modules/tracking/tracking.server.ts` (завдання `tracking.poll`), статус «Передано перевізнику» — лише за
  фактом. Трек-номер у Shopify: `modules/shopify-sync/fulfillment.server.ts` (fulfillmentCreate, звірка за трек-номером,
  `notifyCustomer` за замовчуванням false).
- Документи: `pages/order-document.tsx` (PDF перевізника через fetch), `pages/order-invoice.tsx` (друк інвойсу).
- Nova Global Partners API: Basic auth + company_id за договором; поки `not_configured`.

## Етап 4 (перевірка даних, проблеми, підготовка ШІ)
- Валідатор: `modules/validation/` — regions.ts (ISO 3166-2), postal-region.ts, city-postal.ts, categories.ts (категорія для
  кожного коду; новий код без категорії не компілюється). Шаблони індексів власника — лише безпечні (`isSafePostalPattern`).
- Пропозиції застосовуються лише з збережених кандидатів (`acceptSuggestion`, MAX_CANDIDATE_LENGTH у validation/types.ts).
- Переоформлення: `modules/shipments/reissue.server.ts` (перевірка даних до скасування, CAS, одна активна накладна).
- «Проблеми»: `modules/problems/`; правила країн: `modules/country-rules/` (історія `country_rules_history`).
- ШІ/WhatsApp — лише підготовка: `modules/assistant/tools.server.ts` (права, підтвердження, режими, аудит),
  `modules/privacy/redact.ts`, `integrations/knowledge/`, `modules/customer-requests/`. Опис — `docs/ai-whatsapp-readiness.md`.
- Прапорці форм: сервер читає `form.has(name)`; Checkbox без value (браузер надсилає "on").

## Етап 5 (склад і виробництво)
- Проєкт і інваріанти: `docs/stage5-design.md`; аналітика, CSV, команди для Telegram — `docs/telegram-warehouse-readiness.md`;
  тестовий магазин — `docs/shopify-test-server.md` («Етап 5»); покрокова перевірка власником (демо + тестовий магазин) —
  `docs/stage5-testing.md`. НІЧОГО з етапу 5 не перевірено на реальному Shopify Admin API, Nova Post чи основному
  магазині: лише автотести (імітація Admin API) і демо.
- Облік (`modules/inventory/`): журнал `inventory_movements` + баланси `inventory_balances` (кошики on_hand, reserved,
  defective, in_production; доступно = on_hand − reserved). `applyMovements` (ledger.server.ts) — ЄДИНИЙ шлях змінити залишок
  (FOR UPDATE у порядку stock_item_id; правила кошиків — movement-types.ts). Ключі ідемпотентності — лише `inventoryKeys`
  з `modules/inventory/keys.ts` (одна бізнес-подія = один ключ; форми й команди — `manual:<uuid>`).
- Резерви: `syncOrderReservations` — у транзакції кожної зміни замовлення (бажаний стан → лише різниця; кількість —
  `effectiveLineQuantity`). Списання `consume_sale` — лише при фактичній передачі перевізнику (не накладна, не пакування).
  Відкриття: `initializeInventory` (opening.server.ts, `warehouse.adjust`): on_hand = H + max(0, S + Σ відкритих оплачених
  замовлень до T); H ≠ 0 → розбіжність `opened_with_internal_history`. Невідкритий товар — без резервів.
- Shopify ↔ склад (`modules/inventory-sync/`): передача за замовчуванням ВИМКНЕНА (`warehouse.shopifyPush = off`); `deltas` —
  лише внутрішні події дельтою (`inventory.push`, `@idempotent` `ot-mv-<id руху>`); у демо передачі немає (`movementOptionsFor`).
  Звірка: доступно складу ↔ Shopify `available` (пояснена частина `expectedDiff` — не конфлікт; стійка різниця →
  `inventory_conflicts`, рішення власника); `externalShopifyChanges = apply` — лише з `deltas` + `write_inventory`
  (`autoApplyEffective`, `autoApplyBlockers`); `inventory.reconcile_scheduled` — повна звірка кожні 6 год (лише читання).
  Точка згоди — `audit_log` `inventory_sync.in_sync` (не очищати).
- Вартість запитів Admin API: кожен експорт `#graphql` з `integrations/shopify/*.ts` має рядок у `SIZES`
  (`tests/stage5/shopify-query-cost.test.ts`, оцінка — `tests/helpers/shopify-query-cost.ts`) і ≤ 950 балів (ліміт — 1000).
  Розміри сторінок — експортовані константи (`ORDERS_PAGE_SIZE`, `PRODUCT_VARIANTS_PAGE_SIZE`, …); `readAllVariants` /
  `readAllLineItems` дочитують сторінки й не обрізають. Журнал: `shopify.query_cost_high` (> 800), `shopify.query_cost_exceeded`.
- Зміни в модулях етапів 2–4 (ЛИШЕ в гілці етапу 5, не в PR #2/#3/#4): `product_variants.removed_at`;
  `shopify.fulfillment_refresh` (fulfillment-refresh.server.ts; `syncOrder` режиму `refresh` застосовує лише новіші дані);
  `orders.shopify_contact_snapshot` (SHOPIFY_ORDER_CHANGED — лише поля, змінені самим Shopify);
  `order_line_items.discounted_unit_price` (митна вартість одиниці); розміри сторінок GraphQL; `concurrent` у переоформленні;
  `orders/shipped-outside.server.ts` (SHOPIFY_FULFILLED_OUTSIDE_APP → «Відправлено поза застосунком»);
  `shopify-sync/pending-lines.server.ts` (`orders.shopify_lines_pending_at`: позиції з Shopify при активній накладній).
- Пакування (`modules/packing/`): черга `queue.server.ts` (накладна є, до передачі; `orders.priority` 0/1/2); сканування:
  чисте зіставлення `scan.ts` + `recordScan` (packing.server.ts; спільний штрихкод живого варіанта — `catalogVariantLive`,
  `removed_at` — → «неоднозначно»); «Запаковано» — повний комплект або рішення власника з причиною; матеріали — один раз
  (`material:<packing>:<material>`). Вага < 90 % ваги товарів (`isManualWeightPlausible`) — не в накладну без
  `confirmParcelWeight` (лише власник). `PACKING_ISSUE_CODES` (lifecycle.server.ts) — категорія `warehouse` («Склад») у
  problems/categories.ts. Лист комплектації й список передачі — лише друк; «Передано перевізнику» — відстеження або
  `waybills.manage`.
- Шаблони комплектації (`modules/packaging/`): усі товари / вибрані / колекції Shopify (`KIT_SCOPES`) + фільтр моделі й кольору;
  діють усі, що підходять (`kit-resolution.ts`, `kit-options.ts`); колекції — `shopify-sync/collections.server.ts`. Коробка —
  чиста `selectBox` (box-selection.ts): найменша, що вміщує (повороти, вага); автоматично — лише коли габарити є в усіх
  товарів (`fits`, `defaultBoxFor`), інакше (`partial_dimensions` / `weight_only`) — лише підказка за вагою. Сторінка —
  «Шаблони комплектації» (`/warehouse/kits`); пункт меню «Комплектація» — черга пакування.
- Виробництво (`modules/production/`): planned → in_production → partially_received → received → closed / cancelled (CAS за
  `version`); часткові надходження з браком (`receiveProduction`); номер `PB-<рік за Києвом>-NNNN` під `pg_advisory_xact_lock`
  року; собівартість — `batchCostSummary` (calc.ts, BigInt через `app/lib/money.ts`), лише `finance.view`; статистика — stats.ts.
- Аналітика (`modules/warehouse-analytics/`): `calc.ts` (швидкість, днів запасу, ризик, рекомендація), `queries.server.ts`
  (`computeWarehouseAnalytics`; `loadRecommendationSummary` — головна); CSV `export.server.ts`, набір `production` — лише
  `finance.view` (`EXPORT_DATASET_PERMISSIONS`). Без персональних даних.
- Telegram/ШІ — лише підготовка: `modules/warehouse/commands.server.ts` (`WAREHOUSE_COMMAND_NAMES`, zod, дозвіл, preview →
  `confirmed`). Один operationId — одна операція: перевірка й запис в одній транзакції під `pg_advisory_xact_lock`
  (`withOperationLock`). Асистент — `warehouse_<команда>`; `assistantRisk: "critical"` (receive_production) — підтвердження
  людиною навіть у auto. Бота немає. Нова команда чи набір CSV → рядок у таблиці docs/telegram-warehouse-readiness.md
  (тест `tests/stage5/readiness-docs-scripts.test.ts`).
- Демо-історії (вигадані, ідемпотентні): `seedDemoSalesHistory` (seed.server.ts), `seedDemoWarehouseHistory`
  (db/seed/demo-history.server.ts); кінцеві залишки ті самі, `initializeInventory` не змінено — docs/stage5-design.md §13.
- Тести: `tests/stage5`, `tests/pages` (PGlite; PostgreSQL — `TEST_DATABASE_URL`, тести блокувань лише там); імітація
  Admin API — `tests/stage5/inventory-sync-fixtures.ts`. E2E — `npm run test:e2e:stage5`, лише демо.

## Нотатки для наступних етапів
- Етап 2: Dev Dashboard → Custom Distribution, `shopify app config link`, мінімальні scopes (план у `shopify.app.toml`),
  запит Protected Customer Data, робочий ShopifyGateway (GraphQL Admin API), webhooks orders/*, імпорт старих замовлень,
  ролі через `sessionToken.sub` + `OWNER_SHOPIFY_USER_IDS`, фонова черга на таблиці `jobs`.
- Перевірити `AppDistribution` (зараз `AppStore`, як у шаблоні) для Custom Distribution.
- npm: у `.npmrc` `legacy-peer-deps=true` (обхід бага npm з необов'язковими peer-залежностями vitest).
