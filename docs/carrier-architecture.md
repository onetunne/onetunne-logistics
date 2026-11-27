# Архітектура перевізників (етап 3)

Мета: Nova Post, Nova Global, DHL, UPS та інші перевізники підключаються **окремими адаптерами** без змін
у бізнес-логіці (накладні, митниця, тарифи Checkout, відстеження, Shopify).

## Шари
```
modules/shipments/waybill.server.ts   ── створення/звірка/скасування накладних (не знає про конкретного перевізника)
modules/customs/invoice.ts            ── комерційний інвойс і митні позиції (чистий модуль)
modules/rates/*                       ── тарифи Shopify Checkout (CarrierService) через quoteRates
modules/tracking/tracking.server.ts   ── опитування статусів, статуси замовлення, проблеми доставки
modules/shopify-sync/fulfillment.*    ── трек-номер у Shopify після фактичної передачі
            │  лише через інтерфейс CarrierAdapter
integrations/carriers/types.ts        ── контракт: CarrierAdapter, capabilities, CarrierError
integrations/carriers/<carrier>/      ── адаптер: відображення полів, коди статусів, помилки API
```

## Контракт `CarrierAdapter`
| Метод | Можливість (`capabilities`) | Призначення |
|---|---|---|
| `createShipment(req)` | `createShipment` | накладна з митними даними (`customs`, `customsItems`) |
| `findShipmentByReference(ref)` | `findByReference`, `referenceLookupAuthoritative` | звірка після збою (без дублікатів) |
| `cancelShipment(number)` | `cancelShipment` | скасування до передачі |
| `getDocument(ref, kind)` | `documents`, `documentKinds` | PDF: `label`, `invoice`, `customs_declaration` |
| `getTracking(numbers[])` | `tracking` | пакетне відстеження → `TrackingSnapshot` |
| `quoteRates(req)` | `rates` | вартість доставки (Checkout, попередній розрахунок) |
| `trackingInfo(number)` | — | назва перевізника й посилання для Shopify |

Класифікація помилок (`CarrierError.kind`) однакова для всіх: `rejected` (точно не створено, помилка даних),
`unavailable` (запит не дійшов), `unknown_outcome` (могло бути створено → звірка/ручний розгляд),
`auth`, `not_configured`, `not_supported`. Від правильної класифікації залежить захист від дублікатів.

Статуси відстеження нормалізовані (`TrackingStatus`: created, accepted, in_transit, customs, out_for_delivery,
delivered, failed_attempt, returned, lost, exception, cancelled, unknown). Таблицю кодів конкретного перевізника
тримає адаптер (напр. `nova-post/tracking-codes.ts`). Бізнес-логіка працює лише з нормалізованими статусами.

## Як додати перевізника (напр. DHL Express)
1. Отримати офіційну документацію й тестові ключі; записати перевірені факти в `docs/` (без вигаданих полів).
2. Створити `app/integrations/carriers/dhl/`: клієнт (автентифікація, таймаути, маскування секретів),
   `mapping.ts` (CreateShipmentRequest → запит DHL; помилки → `CarrierErrorDetail` з полями форми),
   `tracking-codes.ts`, `adapter.server.ts` з чесними `capabilities` (чого немає в API — `false`).
3. Тести з імітацією API за зразком `tests/stage3/nova-post-*.test.ts` (класифікація кожного HTTP-статусу).
4. Зареєструвати адаптер у `app/server/production-runtime.server.ts` (лише за наявності ключів у змінних середовища)
   і, за потреби, додати розділ налаштувань (`modules/settings/schema.ts`) для параметрів договору.
5. Нічого не змінювати в модулях накладних, митниці, тарифів, відстеження й Shopify.

## Безпека
- Реальне створення накладних Nova Post вимкнене, доки власник не встановить `NOVA_POST_SHIPMENTS_ENABLED=true`.
- Тестовий перевізник реєструється лише в демо.
- Ключі — лише в змінних середовища; у журналах — без ключів/JWT і персональних даних.
