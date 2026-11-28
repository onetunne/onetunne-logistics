/**
 * Етап 6, WP1: спільне для тестів курсів. Фікстури — сирі відповіді НБУ з фактів (tests/fixtures/nbu, без змін байтів:
 * CRLF, кирилиця, порядок полів): exchange_site усі валюти 20.11.2026 (45 рядків: 40 валют + XDR + 4 метали) і EUR
 * 18–30.11.2026 (вихідні 21–22.11 і 28–29.11 з курсом п'ятниці); помилки «Wrong date format» (невалідний JSON, HTTP 200),
 * `[{"message":"Wrong parameters format"}]`, порожня `[]`. `reconstructed-usd-2019-scale-change.json` — відтворено з
 * задокументованих спостережень (USD 01.06.2019 2687,2573 за 100, calcdate " "; 28.12.2019 23,6862 за 1);
 * `reconstructed-eur-new-year-2026.json` — відтворено з переліку «exchangedate calcdate rate» фактів (EUR 29.12.2025–05.01.2026).
 */
import fs from "node:fs";
import path from "node:path";
import { financePeriods } from "~/db/schema";
import type { Actor } from "~/domain/permissions";
import type { OfficialFxRate, OfficialFxRateSource } from "~/integrations/directories/types";
import type { Db } from "~/db/client.server";
import type { ServiceContext } from "~/server/types";
import { parseNbuExchangeSite } from "~/modules/fx/nbu-parse";
import { OWNER, type TestEnv } from "../../helpers";

export const FIXTURES = path.resolve("tests/fixtures/nbu");
export const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");
export const ALL_20261120 = "exchange-site-all-20261120.json";
export const EUR_RANGE = "exchange-site-eur-20261118-20261130.json";

/** Рядки фікстури (через справжній розбір). */
export function fixtureRows(name: string, window: { from: string; to: string }): OfficialFxRate[] {
  return parseNbuExchangeSite(fixture(name), window).rows;
}

/** Контекст робочого режиму (автоматичне джерело — НБУ) з фіксованим «зараз». */
export function prodCtx(env: TestEnv, actor: Actor = OWNER, now = new Date("2026-11-28T10:00:00Z")): ServiceContext {
  return { ...env.ctx(actor), mode: "production", now: () => now };
}

/** Джерело-фікстура (без мережі): повертає рядки, обрізані до запитаного вікна; лічить виклики. */
export function fixtureSource(rows: readonly OfficialFxRate[]): OfficialFxRateSource & { calls: Array<{ from: string; to: string; currency?: string }> } {
  const calls: Array<{ from: string; to: string; currency?: string }> = [];
  return {
    source: "nbu",
    calls,
    async fetchRates(input) {
      calls.push(input);
      return rows.filter((r) => r.effectiveDate >= input.from && r.effectiveDate <= input.to && (!input.currency || r.currency === input.currency));
    },
  };
}

export async function closeMonth(db: Db, month: string): Promise<void> {
  await db.insert(financePeriods).values({ month, status: "closed", closedAt: new Date(), closedBy: "test" }).onConflictDoUpdate({
    target: [financePeriods.storeId, financePeriods.month],
    set: { status: "closed" },
  });
}
