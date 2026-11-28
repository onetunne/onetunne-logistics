/**
 * Еталонна модель етапу 6 (WP12a) — публічний вхід для WP12b (золоті G1–G19 проти застосунку, інваріант I5 на
 * випадкових наборах). Модель НЕЗАЛЕЖНА: жоден файл tests/stage6/reference/** не імпортує app/ (тест
 * reference-independence). Дані й очікування золотих випадків — ../golden/.
 *
 * Три рівні:
 *  1) факти → журнал: postOrder (order-posting.ts), postExpense / postBatchWriteOff / allocateDaily / allocatePeriodSum /
 *     fxConversionEntry (journal.ts), saveImport / matchImportLine (invoice-import.ts: реєстр рахунків перевізника →
 *     записи shipping_unallocated + факти рядків замовлень для postOrder), runCosting (costing.ts), partnerLedger
 *     (partners.ts);
 *  2) журнал → показники: pnlReport, averageCheck, averageOrderProfit, profitByStates, compareValues (pnl.ts),
 *     orderCard (order-card.ts), productRanking / countryRanking / modelColorRanking / modelStockCost (rankings.ts),
 *     shippingStats (shipping.ts), forecast / forecastInputsFromJournal (forecast.ts), stockValueAt (costing.ts);
 *  3) закриття місяця й знімки: closeMonth / monthReport / rangeReport (snapshots.ts) — звіт закритого місяця = його
 *     знімок у валюті показу, валюта без знімка — «Живий перерахунок, не знімок», діапазон = Σ місяців (I15).
 * Рівень 2 приймає сирі рядки журналу застосунку, перетворені в RefEntry / RefOrderMeta / RefForecast:
 *  - finance_entries → RefEntry: key = idempotency_key; orderId = order_id; lineId = order_line_item_id; productId —
 *    ключ групування рейтингу (variant_id або stock_item_id); amount/currency/recognized_on/fx_on/original_on/is_late/
 *    is_late_completion як є; reversesKey — ключ запису reverses_entry_id (або будь-яке не-null значення); details —
 *    lineType (продажі), quantity (з колонки quantity), partnerId (з колонки partner_id), event (accrual / adjustment /
 *    cancellation для partner_commission), taxPart, kind.
 *  - order_finance → RefOrderMeta: state = profit_state для state = recognized, інакше state (open / closed_unrecognized /
 *    excluded); recognizedOn; components = components jsonb ({state, reason, basis}); missing — обов'язкові складники без
 *    значення й без прогнозу; country — країна призначення.
 *  - order_finance_forecasts → RefForecast: amount — зі знаком впливу на прибуток (витрата «−»); fxOn — дата визнання
 *    (виручка й комісії — дата курсу виручки за політикою D-25); recognizedOn — order_finance.recognized_on.
 * Порівняння записів — за кортежем (orderId, category, amount, currency, recognizedOn, fxOn); ключі моделі ілюстративні.
 */
export * from "./money";
export * from "./dates";
export * from "./fx";
export * from "./categories";
export * from "./journal";
export * from "./order-posting";
export * from "./pnl";
export * from "./order-card";
export * from "./shipping";
export * from "./invoice-import";
export * from "./snapshots";
export * from "./rankings";
export * from "./forecast";
export * from "./costing";
export * from "./partners";
export * from "./scenario";
export * from "./dynamics";
