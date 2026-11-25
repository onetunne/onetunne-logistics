# Етап 2: тестовий сервер Shopify — інструкція налаштування

Застосунок у Dev Dashboard: **ONE TUNNE Logistics**, Client ID `373b834cb8858965b5eba33eb9234c7b`.
Демо-сервіс на Render **не змінюється**. Робочий магазин onetunne.com **не підключається**.
Секрети (Client secret, Internal Database URL) вносите лише ви — у змінні середовища Render.

Порядок: 1 → 2 → 3 → 4 → 5 → 6 → 7.

## 1. Render: новий Web Service (тестовий сервер Shopify)
Render → **New → Web Service** → репозиторій `onetunne-logistics`:

| Поле | Значення |
|---|---|
| Name | `onetunne-logistics-shopify-test` |
| Branch | `claude/stage-2-shopify-integration` (після злиття PR — `main`) |
| Region | **Oregon (US West)** — той самий, що в бази (інакше Internal Database URL не працює) |
| Runtime | Node |
| Build Command | `npm ci --include=dev && npm run build` |
| Start Command | `npm start` |
| Instance Type | Free |
| Health Check Path | `/healthz` (Advanced) |

`--include=dev` обов'язковий: через змінну `NODE_ENV=production` npm інакше не встановлює інструменти збірки.

Після створення Render покаже адресу виду `https://onetunne-logistics-shopify-test.onrender.com` — це **APP_URL** нижче.

## 2. Render: Environment Variables (вкладка Environment)
| Ключ | Значення |
|---|---|
| `NODE_VERSION` | `22` |
| `NODE_ENV` | `production` |
| `TRUST_PROXY` | `1` |
| `SHOPIFY_API_KEY` | `373b834cb8858965b5eba33eb9234c7b` |
| `SHOPIFY_API_SECRET` | *Client secret з Dev Dashboard → Settings (вносите самі)* |
| `SHOPIFY_APP_URL` | `https://onetunne-logistics-shopify-test.onrender.com` (ваша адреса, без `/` у кінці) |
| `SCOPES` | `write_orders,read_products,read_inventory` |
| `DATABASE_URL` | *Internal Database URL бази `onetunne-logistics-test-db` (вносите самі)* |
| `SESSION_SECRET` | кнопка **Generate** |
| `OWNER_SHOPIFY_USER_IDS` | спочатку порожньо (див. крок 7) |

`DEMO_MODE` **не додавайте**. Міграції БД застосовуються автоматично під час першого запуску.

## 3. Dev Dashboard: нова версія застосунку
dev.shopify.com → Apps → ONE TUNNE Logistics → **Versions → Create version**:

| Поле | Значення |
|---|---|
| App URL | `https://onetunne-logistics-shopify-test.onrender.com` |
| Embed app in Shopify admin | увімкнено |
| Webhooks API version | `2026-10` |
| Scopes | `write_orders,read_products,read_inventory` |
| Redirect URLs | `https://onetunne-logistics-shopify-test.onrender.com/auth/callback` |
| Use legacy install flow | вимкнено |

Натисніть **Release**. Підписки на події (замовлення, товари, залишки, видалення застосунку) застосунок
створює сам через API одразу після встановлення — налаштовувати їх у Dev Dashboard не потрібно.

## 4. Спосіб розповсюдження (лише якщо на Home застосунку є картка **Distribution**)
- Shopify: спосіб **не можна змінити** після вибору; якщо є окремі застосунки для розробки й робочого магазину,
  вибір робиться окремо для кожного.
- Для цього тестового застосунку: **Select distribution method → Custom distribution** → домен вашого тестового магазину
  `xxx.myshopify.com` → **Generate link**.
- Цей застосунок залишиться тестовим. Для onetunne.com пізніше створимо **окремий** застосунок (найкраще — в організації
  магазину onetunne.com: тоді не потрібні вибір розповсюдження й схвалення `read_all_orders`).
- Якщо картки Distribution немає — застосунок створено в організації магазину, крок пропускається.

## 5. Захищені дані клієнтів (Protected customer data)
Dev Dashboard → застосунок → **Settings → Access requests → Protected customer data → Manage**:
1. **Customer data** → причина: «Обробка й доставка замовлень: створення накладних і митних документів».
2. Поля: **Name, Address, Phone, Email** → причина: «Дані одержувача для міжнародної доставки й зв’язку щодо доставки».
3. **Data protection details**: дані лише для виконання замовлення; зберігання в захищеній БД; доступ за ролями; журнали без ПД;
   видалення за запитом.
4. Для тестового (development) магазину відправляти на перевірку **не потрібно**.

Без цього кроку Shopify приховує ім’я/адресу/телефон/email у замовленнях — перевірка даних покаже їх як відсутні.

## 6. Встановлення в тестовий магазин
Dev Dashboard → застосунок → картка **Installs → Install app** → оберіть тестовий магазин → **Install**
(або відкрийте custom install link з кроку 4). Після встановлення застосунок відкриється в адмінці тестового магазину;
перше відкриття безкоштовного сервера може тривати до хвилини.

Одразу після встановлення автоматично:
- реєструються підписки на webhooks;
- у фоні синхронізуються всі товари (сторінка **Налаштування → Синхронізація Shopify**).

## 7. Стати власником
1. У застосунку відкрийте **Працівники** — там «Ваш Shopify User ID».
2. Render → Environment → `OWNER_SHOPIFY_USER_IDS` = цей ID → **Save** (сервіс перезапуститься).
3. Оновіть сторінку застосунку — у вас роль «Власник»; інші користувачі — «Працівник», ролі змінюєте в розділі «Працівники».

## 8. Замовлення, старші за 60 днів (необов'язково)
Без дозволу `read_all_orders` Shopify повертає лише замовлення за останні 60 днів (і застосунок про це попереджає).
1. Якщо застосунок створено в організації магазину — схвалення не потрібне. Якщо в Partner-організації:
   Dev Dashboard → застосунок → **Settings → Access requests → Read all orders → Request access** і дочекайтеся схвалення.
2. Нова версія застосунку: Scopes `write_orders,read_products,read_inventory,read_all_orders` → **Release**.
3. Render: `SCOPES` = `write_orders,read_products,read_inventory,read_all_orders` → Save.
4. Відкрийте застосунок у магазині та підтвердьте нові дозволи. На сторінці «Синхронізація Shopify» в полі «Дозволи»
   з'явиться `read_all_orders`; запустіть імпорт з потрібної дати.

## Перевірка на тестовому магазині (чекліст)
1. Синхронізація Shopify: «Товари синхронізовано» має дату; у фонових завданнях немає «Не виконано».
2. Створіть тестове оплачене замовлення (Bogus Gateway / тестові платежі) → за ~5–30 с воно з’являється в «Замовлення».
3. Змініть адресу замовлення в Shopify → зміна з’являється в історії замовлення (джерело Shopify).
4. Виправте адресу в застосунку → «Shopify: зміни поставлено в чергу» → адреса оновилася в Shopify.
5. Скасуйте замовлення в Shopify → статус «Скасовано».
6. «Імпортувати старі замовлення» з датою → лічильник імпорту зростає, дублікатів немає.
7. Змініть залишок товару в Shopify → кількість оновилася.

## Як працює синхронізація адреси з Shopify
- У Shopify надсилаються **всі** поля адреси (порожні — як порожні). Регіон передається лише кодом (напр. `TX`, `ON`);
  назва регіону без коду очищує регіон у Shopify. Це усуває відхилення країни/індексу при зміні країни.
- Якщо в застосунку адреса має помилки перевірки, у Shopify вона не надсилається («Shopify не оновлено: спершу виправте поля»).
- Якщо Shopify відхиляє дані, його текст помилки з'являється біля відповідного поля замовлення і в «Проблемах».
  Після успішного виправлення ця проблема й невдале завдання закриваються автоматично.

## Відомі обмеження тестового сервера
- Безкоштовний сервер «засинає» після простою: перше відкриття ~1 хв; webhooks під час сну Shopify доставляє повторно,
  фонові завдання продовжуються після пробудження.
- Безкоштовна база Render має обмежений термін дії (див. попередження в Render) — для робочої версії потрібен платний план
  (лише з вашого дозволу).
- Митний опис товару береться з метаполя товару `logistics.customs_description` (Shopify → Settings → Custom data →
  Products → Add definition: namespace `logistics`, key `customs_description`, тип «Single line text»). Без нього перевірка
  даних покаже «немає митного опису».
- Накладні в робочому режимі не створюються до інтеграції Nova Global (етап 3).
- IP allowlist (Shopify): обов’язковий лише для custom-застосунків, встановлених у магазини **поза** вашою організацією.
