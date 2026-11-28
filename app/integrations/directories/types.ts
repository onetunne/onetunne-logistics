/**
 * Довідники для перевірки адрес (етап 4) та офіційні курси валют (етап 6). Лише типи; реалізація НБУ — WP1.
 */

/**
 * Етап 4. Пошук поштового індексу за адресою.
 * Лише перевірені (офіційні/ліцензовані) довідники. Якщо кандидатів кілька — індекс НЕ підставляється
 * автоматично, потрібне підтвердження менеджера.
 */
export interface AddressDirectory {
  lookupPostalCode(q: {
    countryCode: string;
    city: string;
    address1: string;
  }): Promise<{ candidates: string[]; source: string }>;
}

/**
 * @deprecated Етап 6: не використовується. Одна пара без масштабу НБУ й дати встановлення підштовхувала до заокругленого
 * кросс-курсу. Замінено на OfficialFxRateSource (docs/stage6-design.md §5.6).
 */
export interface FxRateProvider {
  getRate(from: string, to: string, date: Date): Promise<{ rate: string; source: string; date: Date }>;
}

/** Етап 6: рядок офіційного курсу як опубліковано (десяткові рядки; без float). */
export interface OfficialFxRate {
  /** ISO 4217 (`^[A-Z]{3}$`), напр. "EUR" (НБУ: поле cc, не r030). */
  currency: string;
  /** Дата дії курсу YYYY-MM-DD (НБУ: exchangedate). */
  effectiveDate: string;
  /** Курс за `units` одиниць валюти в гривнях, з сирого тексту відповіді (не Number). */
  rate: string;
  /** Масштаб (1, 10, 100, 1000, 10000). */
  units: number;
  /** Дата встановлення YYYY-MM-DD (НБУ: calcdate) або null (пробіл до 05.07.2019). */
  setOn: string | null;
}

/**
 * Етап 6: джерело офіційних курсів (НБУ — app/integrations/fx/nbu.server.ts, WP1). Діапазон дат включно; currency —
 * одна валюта (довантаження історії), інакше всі. Порожній результат — «ще не встановлено», не помилка. Кожен запит —
 * лише з увімкненим finance.fx.nbuEnabled (перевіряє викликач і обробник завдання, I18).
 */
export interface OfficialFxRateSource {
  readonly source: "nbu";
  fetchRates(input: { from: string; to: string; currency?: string }): Promise<OfficialFxRate[]>;
}
