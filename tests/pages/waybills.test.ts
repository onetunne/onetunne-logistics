import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "~/lib/env.server";

/**
 * Накладні (/demo/waybills): перелік лише з потрібними полями, чесні дані про перевізників,
 * підсумок за станом. Справжні запити до демо-середовища (PGlite у пам'яті, окреме для файлу).
 */
const saved = { DEMO_MODE: process.env.DEMO_MODE, DEMO_DATA_DIR: process.env.DEMO_DATA_DIR, DEMO_PASSWORD: process.env.DEMO_PASSWORD };

let page: typeof import("~/pages/waybills");

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  process.env.DEMO_DATA_DIR = "memory";
  delete process.env.DEMO_PASSWORD;
  resetEnvCache();
  page = await import("~/pages/waybills");
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
});

async function load() {
  return page.loader({ request: new Request("http://localhost/demo/waybills"), params: {}, context: {} } as never);
}

describe("waybills loader", () => {
  it("lists only test waybills in the demo with the fields the table needs", async () => {
    const data = await load();
    expect(data.shipments.length).toBeGreaterThan(0);
    for (const s of data.shipments) {
      expect(s.mode).toBe("test");
      expect(s.orderNumber).toMatch(/^#\d+$/);
      expect(s.reference).toBeTruthy();
      expect(s.createdAt).toBeInstanceOf(Date);
      // Знімок запиту до перевізника містить персональні дані — у браузер не передається.
      expect(Object.keys(s)).not.toContain("requestSnapshot");
      expect(Object.keys(s)).not.toContain("lastError");
    }
    const total = Object.values(data.statusCounts).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(data.shipments.length);
    expect(data.statusCounts.created).toBeGreaterThan(0);
    expect(data.truncated).toBe(false);
  });

  it("describes carriers honestly: only the sandbox carrier in the demo", async () => {
    const data = await load();
    expect(data.novaGlobalRegistered).toBe(false);
    expect(data.carriers).toHaveLength(1);
    const [carrier] = data.carriers;
    expect(carrier).toMatchObject({ code: "test", mode: "test", isDefault: true, configured: true });
    const available = carrier!.capabilities.filter((c) => c.available).map((c) => c.key);
    expect(available).toContain("createShipment");
    // Етап 5: тестовий перевізник видає зразок етикетки з позначкою TEST (перевірка друку етикеток у демо).
    expect(available).toContain("documents");
  });
});

describe("waybills loader: re-issued generations (stage 4)", () => {
  it("exposes the generation of each waybill (1 for the demo seed)", async () => {
    const data = await load();
    for (const s of data.shipments) expect(s.generation).toBeGreaterThanOrEqual(1);
    expect(data.shipments.some((s) => s.generation === 1)).toBe(true);
  });
});
