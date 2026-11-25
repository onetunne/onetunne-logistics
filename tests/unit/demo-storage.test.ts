import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { openPglite } from "~/db/client.server";

describe("demo storage on a fresh checkout", () => {
  it("creates missing parent folders for the PGlite data directory", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "ot-demo-"));
    const dir = path.join(base, ".data", "nested", "demo-db");
    const handle = await openPglite(dir);
    await handle.db.execute(sql`select 1`);
    await handle.close();
    expect(fs.existsSync(dir)).toBe(true);
    fs.rmSync(base, { recursive: true, force: true });
  });
});
