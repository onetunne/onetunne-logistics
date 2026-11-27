import type { MessageModule } from "../types";

/**
 * Зведення складу (етап 5, R6): витрата пакувальних матеріалів за 30 днів і прогноз «на скільки вистачить»
 * (перелік «Пакувальні матеріали» і картка матеріалу).
 */
const messages: MessageModule = {
  uk: {
    "warehouseInsights.material.consumed": "Витрачено за {days, plural, one {# день} few {# дні} many {# днів} other {# дня}}",
    "warehouseInsights.material.daysLeft": "Вистачить на, днів",
    "warehouseInsights.material.daysLeftValue": "Вистачить на {days, plural, one {# день} few {# дні} many {# днів} other {# дня}}",
    "warehouseInsights.material.runOut": "Залишку немає",
    "warehouseInsights.material.noUsage": "Не витрачався",
    "warehouseInsights.material.noForecast": "Витрат не було — прогнозу немає",
    "warehouseInsights.material.forecastHint":
      "Прогноз — за середньою витратою при пакуванні за останні {days, plural, one {# день} few {# дні} many {# днів} other {# дня}}.",
  },
  en: {
    "warehouseInsights.material.consumed": "Used in the last {days, plural, one {# day} other {# days}}",
    "warehouseInsights.material.daysLeft": "Days of stock left",
    "warehouseInsights.material.daysLeftValue": "Enough for {days, plural, one {# day} other {# days}}",
    "warehouseInsights.material.runOut": "None left",
    "warehouseInsights.material.noUsage": "Not used",
    "warehouseInsights.material.noForecast": "No usage — no forecast",
    "warehouseInsights.material.forecastHint":
      "Forecast from the average packing usage over the last {days, plural, one {# day} other {# days}}.",
  },
};

export default messages;
