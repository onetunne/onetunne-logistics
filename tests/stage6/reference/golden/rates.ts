/**
 * Золоті випадки етапу 6 (WP12a → WP12b): таблиці курсів. Курси з §20.1 (G1, G3, G4); позначені «вигаданий» —
 * додані моделлю для повноти сценарію (не з §20.1), їхні похідні значення пораховано незалежно (Python Decimal).
 */
import type { RefRate } from "../model/fx";

/** G1/G1b/G10/G11/G11b: EUR 01.10 = 48,0000; 05.10 = 48,5000 (і 20.10 для G11b); 04.11–06.11 = 48,8000. */
export const G1_RATES: readonly RefRate[] = [
  { currency: "EUR", date: "2026-10-01", rate: "48.0000", source: "nbu" },
  { currency: "EUR", date: "2026-10-05", rate: "48.5000", source: "nbu" },
  { currency: "EUR", date: "2026-10-20", rate: "48.5000", source: "nbu" },
  /** вигаданий: курс справжньої дати пізнього повернення G11 (31.10). */
  { currency: "EUR", date: "2026-10-31", rate: "48.6000", source: "nbu" },
  { currency: "EUR", date: "2026-11-04", rate: "48.8000", source: "nbu" },
  { currency: "EUR", date: "2026-11-05", rate: "48.8000", source: "nbu" },
  { currency: "EUR", date: "2026-11-06", rate: "48.8000", source: "nbu" },
  /** вигаданий: дата chargeback G10 (12.11) і повернення G10c (15.11). */
  { currency: "EUR", date: "2026-11-12", rate: "48.9000", source: "nbu" },
  { currency: "EUR", date: "2026-11-15", rate: "48.9000", source: "nbu" },
];

/**
 * G11 (знімки): курси, відомі на момент закриття жовтня 05.11, — G1_RATES (EUR на 10.10 ще немає → запасний курс 05.10,
 * 48,5000). Пізніше (вигадані): курс НБУ EUR 10.10 = 48,6000, отриманий після закриття (знімка не змінює), і USD —
 * валюта, додана до показу 20.11 (05.10 = 41,5000, 10.10 = 41,6000, 31.10 = 41,7000).
 */
export const G11_RATES_LATER: readonly RefRate[] = [
  ...G1_RATES,
  { currency: "EUR", date: "2026-10-10", rate: "48.6000", source: "nbu" },
  { currency: "USD", date: "2026-10-05", rate: "41.5000", source: "nbu" },
  { currency: "USD", date: "2026-10-10", rate: "41.6000", source: "nbu" },
  { currency: "USD", date: "2026-10-31", rate: "41.7000", source: "nbu" },
];

/** G3: НБУ 20.11.2026 (з фактів) + субота 21.11 з курсом п'ятниці; KRW — вигаданий тестовий курс. */
export const G3_RATES: readonly RefRate[] = [
  { currency: "EUR", date: "2026-11-20", rate: "49.5335", units: 1, source: "nbu" },
  { currency: "USD", date: "2026-11-20", rate: "45.0532", units: 1, source: "nbu" },
  { currency: "HUF", date: "2026-11-20", rate: "13.4308", units: 100, source: "nbu" },
  { currency: "JPY", date: "2026-11-20", rate: "2.818", units: 10, source: "nbu" },
  { currency: "KRW", date: "2026-11-20", rate: "3.0812", units: 100, source: "nbu" },
  { currency: "EUR", date: "2026-11-21", rate: "49.5335", units: 1, source: "nbu" },
];

/** G3: ручна таблиця без 21.11 (є 20.11) і з розривом 8 днів (12.11 → 20.11). */
export const G3_MANUAL_RATES: readonly RefRate[] = [
  { currency: "EUR", date: "2026-11-20", rate: "49.5335", source: "manual", version: 1, isCurrent: true },
  { currency: "GBP", date: "2026-11-12", rate: "56.5000", source: "manual", version: 1, isCurrent: true },
];

/** G4: НБУ 27.11.2026 EUR 49,4942. */
export const G4_RATES: readonly RefRate[] = [{ currency: "EUR", date: "2026-11-27", rate: "49.4942", source: "nbu" }];

/** G9 (й): EUR 48,50 на дату послуги. */
export const G9_RATES: readonly RefRate[] = [{ currency: "EUR", date: "2026-10-05", rate: "48.5000", source: "nbu" }];
