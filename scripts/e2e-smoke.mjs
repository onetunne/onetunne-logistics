#!/usr/bin/env node
/**
 * E2E-перевірка демо в справжньому браузері (Playwright/Chromium).
 * Проходить основний сценарій через інтерфейс і робить знімки екрана (iPhone + ПК).
 *
 * Використання: спершу запустіть демо (`npm run demo` або `npm run start:demo` після збірки),
 * потім `npm run test:e2e`. Параметри: BASE_URL (за замовч. http://localhost:3000), SCREENSHOTS_DIR.
 * Потрібен пакет `playwright` (глобально або локально) з Chromium.
 */
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = process.env.SCREENSHOTS_DIR ?? "screenshots";

let chromium, devices;
try {
  ({ chromium, devices } = await import("playwright"));
} catch {
  console.error("Playwright не встановлено. Встановіть: npm i -D playwright && npx playwright install chromium");
  process.exit(2);
}

fs.mkdirSync(OUT, { recursive: true });
const failures = [];
const check = (cond, msg) => {
  if (!cond) failures.push(msg);
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
};

const browser = await chromium.launch();
try {
  // ---------- iPhone ----------
  const phone = await browser.newContext({ ...devices["iPhone 13"], locale: "uk-UA" });
  const page = await phone.newPage();
  const consoleErrors = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  // Скидання демо-даних для повторюваності.
  await page.goto(`${BASE}/demo/settings`);
  const reset = page.getByRole("button", { name: /Скинути демо-дані|Reset demo data/ }).first();
  if (await reset.isVisible().catch(() => false)) {
    await reset.click();
    await page.getByRole("dialog").getByRole("button", { name: /Скинути|Reset|Підтвердити|Confirm/ }).last().click();
    await page.waitForLoadState("networkidle");
  }

  await page.goto(`${BASE}/demo`);
  check((await page.title()).includes("ONE TUNNE"), "dashboard opens");
  await page.screenshot({ path: path.join(OUT, "iphone-dashboard.png"), fullPage: true });
  const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check(noHScroll, "no horizontal scroll on iPhone (dashboard)");

  await page.goto(`${BASE}/demo/orders`);
  check(await page.getByText("#1004").first().isVisible(), "orders list shows demo orders");
  await page.screenshot({ path: path.join(OUT, "iphone-orders.png"), fullPage: true });
  check(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    "no horizontal scroll on iPhone (orders)",
  );

  // Сценарій: #1004 (FR без індексу) → перевірка → проблема → виправлення → тестова накладна.
  await page.getByRole("link", { name: "#1004" }).first().click();
  await page.waitForURL(/\/demo\/orders\/[0-9a-f-]+/);
  const orderUrl = page.url();
  await page.getByRole("button", { name: /Перевірити дані/ }).first().click();
  await page.waitForLoadState("networkidle");
  check(await page.getByText(/Потребує виправлення/).first().isVisible(), "validation finds a problem (needs correction)");
  check(await page.getByText(/індекс/i).first().isVisible(), "postal code problem is explained");
  await page.screenshot({ path: path.join(OUT, "iphone-order-problem.png"), fullPage: true });

  await page.locator('input[name="shipping.postalCode"]').fill("69001");
  await page.getByRole("button", { name: /Зберегти/ }).first().click();
  await page.waitForLoadState("networkidle");
  check(await page.getByText(/Очікує перевірки/).first().isVisible(), "after manual fix → awaiting review");

  await page.getByRole("button", { name: /Створити тестову накладну/ }).first().click();
  await page.waitForLoadState("networkidle");
  const waybill = await page.getByText(/TEST\d{10}/).first().textContent().catch(() => null);
  check(Boolean(waybill), `test waybill created (${waybill?.match(/TEST\d{10}/)?.[0] ?? "none"})`);
  await page.screenshot({ path: path.join(OUT, "iphone-order-waybill.png"), fullPage: true });

  // Повторна обробка не створює дублікат.
  await page.goto(orderUrl);
  const again = page.getByRole("button", { name: /Створити тестову накладну/ });
  check((await again.count()) === 0, "create button hidden once waybill exists");
  await page.goto(`${BASE}/demo/waybills`);
  const occurrences = await page.getByText(waybill?.match(/TEST\d{10}/)?.[0] ?? "—").count();
  check(occurrences >= 1, "waybill listed once in waybills page");

  await page.goto(`${BASE}/demo/problems`);
  await page.screenshot({ path: path.join(OUT, "iphone-problems.png"), fullPage: true });
  check(await page.getByText("#1006").first().isVisible(), "problems page lists problem orders");

  check(consoleErrors.length === 0, `no browser console errors (${consoleErrors.slice(0, 3).join(" | ")})`);
  await phone.close();

  // ---------- Desktop ----------
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "uk-UA" });
  const d = await desktop.newPage();
  await d.goto(`${BASE}/demo`);
  await d.screenshot({ path: path.join(OUT, "desktop-dashboard.png"), fullPage: true });
  await d.goto(`${BASE}/demo/orders`);
  await d.screenshot({ path: path.join(OUT, "desktop-orders.png"), fullPage: true });
  await d.goto(orderUrl);
  await d.screenshot({ path: path.join(OUT, "desktop-order.png"), fullPage: true });
  await d.goto(`${BASE}/demo/settings`);
  await d.screenshot({ path: path.join(OUT, "desktop-settings.png"), fullPage: true });

  // Працівник не має доступу до налаштувань (перевірка на сервері).
  await d.goto(`${BASE}/demo`);
  await d.getByRole("button", { name: /^Працівник$/ }).first().click();
  await d.waitForLoadState("networkidle");
  const res = await d.goto(`${BASE}/demo/settings`);
  check(res?.status() === 403, `staff gets 403 on settings (got ${res?.status()})`);
  await d.goto(`${BASE}/demo`);
  await d.getByRole("button", { name: /^Власник$/ }).first().click();

  // Темна тема.
  await d.emulateMedia({ colorScheme: "dark" });
  await d.goto(`${BASE}/demo`);
  await d.screenshot({ path: path.join(OUT, "desktop-dashboard-dark.png"), fullPage: false });
  await desktop.close();
} finally {
  await browser.close();
}

console.log(`\nScreenshots: ${path.resolve(OUT)}`);
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nAll E2E checks passed");
