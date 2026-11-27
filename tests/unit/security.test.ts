import { afterEach, describe, expect, it } from "vitest";
import { redact } from "~/lib/logger.server";
import { isSameOrigin } from "~/server/http.server";
import { demoAccessToken } from "~/server/cookies.server";
import { resetEnvCache } from "~/lib/env.server";
import { openPglite } from "~/db/client.server";
import { claimWebhook, completeWebhook } from "~/modules/webhooks/dedupe.server";

describe("error logging never leaks query params", () => {
  it("drops SQL text and bound values of DB errors", () => {
    const err = new Error('Failed query: update "orders" set "ship_city" = $1\nparams: Musterstraße 12,Lena Hoffmann');
    (err as { cause?: unknown }).cause = { code: "22P05" };
    const out = JSON.stringify(redact({ error: err }));
    expect(out).not.toContain("Hoffmann");
    expect(out).not.toContain("Musterstraße");
    expect(out).toContain("Database query failed");
    expect(out).toContain("22P05");
  });
});

describe("origin check for resource routes", () => {
  const req = (origin?: string) =>
    new Request("https://demo.example.com/preferences", { method: "POST", headers: origin ? { Origin: origin } : {} });
  it("accepts same origin and requests without Origin, rejects foreign/opaque", () => {
    expect(isSameOrigin(req("https://demo.example.com"))).toBe(true);
    expect(isSameOrigin(req())).toBe(true);
    expect(isSameOrigin(req("https://evil.example.org"))).toBe(false);
    expect(isSameOrigin(req("null"))).toBe(false);
  });
});

describe("demo access token is bound to the password", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    resetEnvCache();
  });
  it("changes when DEMO_PASSWORD changes", () => {
    Object.assign(process.env, { DEMO_MODE: "true", DEMO_PASSWORD: "one", SESSION_SECRET: "s".repeat(32) });
    resetEnvCache();
    const a = demoAccessToken();
    process.env.DEMO_PASSWORD = "two";
    resetEnvCache();
    const b = demoAccessToken();
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });
});

describe("webhook retries after a failed processing", () => {
  it("reprocesses failed deliveries but not processed ones", async () => {
    const { db, close } = await openPglite();
    const ev = { webhookId: "w-9", topic: "app/uninstalled", shop: "x.myshopify.com" };
    expect(await claimWebhook(db, ev)).toBe(true);
    await completeWebhook(db, ev.webhookId, "processing_failed");
    expect(await claimWebhook(db, ev)).toBe(true);
    await completeWebhook(db, ev.webhookId);
    expect(await claimWebhook(db, ev)).toBe(false);
    await close();
  });
});

describe("redact keeps identifiers intact (stage 4)", () => {
  it("does not mask parts of UUIDs but still masks phones", () => {
    const id = "a0c8ef99-2560-4c1e-9b11-123456789012";
    expect(redact(`order ${id}`)).toBe(`order ${id}`);
    expect(redact("call +380 67 123 45 67 now")).toBe("call [phone] now");
    expect(redact("tel:0671234567")).toBe("tel:[phone]");
    expect(redact("(067) 123-45-67")).toBe("([phone]");
  });
});
