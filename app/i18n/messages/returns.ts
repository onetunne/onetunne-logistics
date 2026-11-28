/**
 * Етап 6: модуль i18n пакета WP9 — розділ «Повернення» (docs/stage6-design.md §18.10, §21.3).
 * Ключі з префіксом «returns.». Модуль належить пакету WP9; ядро (WP0) лише зареєструвало його (app/i18n/index.ts) і
 * додало до перевірки «без зайвих ключів» (tests/i18n/completeness.test.ts). Спільні підписи (категорії, стани,
 * причини, розбіжності, вкладки, глосарій) — у модулі finance (financeLabelKeys), не тут.
 */
import type { MessageModule } from "../types";

const messages: MessageModule = {
  uk: {},
  en: {},
};

export default messages;
