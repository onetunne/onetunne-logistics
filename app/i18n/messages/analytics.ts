/**
 * Етап 6: модуль i18n пакета WP8 — аналітика бізнесу (/analytics) (docs/stage6-design.md §18.10, §21.3).
 * Ключі з префіксом «analytics.». Модуль належить пакету WP8; ядро (WP0) лише зареєструвало його (app/i18n/index.ts) і
 * додало до перевірки «без зайвих ключів» (tests/i18n/completeness.test.ts). Спільні підписи (категорії, стани,
 * причини, розбіжності, вкладки, глосарій) — у модулі finance (financeLabelKeys), не тут.
 */
import type { MessageModule } from "../types";

const messages: MessageModule = {
  uk: {},
  en: {},
};

export default messages;
