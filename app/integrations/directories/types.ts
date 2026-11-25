/**
 * ЗАПЛАНОВАНО: довідники для перевірки адрес (етап 4) та курси валют (етап 6). Лише типи, без реалізації.
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
 * Етап 6. Курси валют для фінансових розрахунків.
 * rate — десятковий рядок (без float), напр. "41.2350"; source — джерело курсу; date — дата курсу.
 */
export interface FxRateProvider {
  getRate(from: string, to: string, date: Date): Promise<{ rate: string; source: string; date: Date }>;
}
