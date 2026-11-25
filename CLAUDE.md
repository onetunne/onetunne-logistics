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

## Етап 2 (Shopify)
- Інструкція налаштування тестового сервера: `docs/shopify-test-server.md`. Документацію Shopify читати як
  `https://shopify.dev/docs/....md` (хост shopify.dev дозволено в середовищі `onetunne-logistics`).
- Потік: webhook (`/webhooks/shopify`, HMAC) → `webhook_events` (дедуплікація) → `jobs` → обробник
  (`modules/shopify-sync/handlers.server.ts`) перечитує дані через GraphQL (`integrations/shopify/graphql.ts`).
- Обробник черги стартує з сервером (`ensureJobWorker` в entry.server) лише за наявності ключів Shopify і DATABASE_URL.
- Зміни з Shopify не перезаписують замовлення з накладною або з неперенесеними підтвердженими змінами → проблема SHOPIFY_ORDER_CHANGED.
- Тести етапу 2 — `tests/stage2` з імітацією Admin API (`fixtures.ts`); реальний API перевіряє власник на тестовому магазині.

## Нотатки для наступних етапів
- Етап 2: Dev Dashboard → Custom Distribution, `shopify app config link`, мінімальні scopes (план у `shopify.app.toml`),
  запит Protected Customer Data, робочий ShopifyGateway (GraphQL Admin API), webhooks orders/*, імпорт старих замовлень,
  ролі через `sessionToken.sub` + `OWNER_SHOPIFY_USER_IDS`, фонова черга на таблиці `jobs`.
- Перевірити `AppDistribution` (зараз `AppStore`, як у шаблоні) для Custom Distribution.
- npm: у `.npmrc` `legacy-peer-deps=true` (обхід бага npm з необов'язковими peer-залежностями vitest).
