// Migration 0145 (U-36.1): the three key ring tables, their keys, and the down script.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_ROOT } from "../../paths.js";
import { makeTestDb } from "../../helpers.js";

const down = readFileSync(
  join(TEST_ROOT, "..", "scripts/rollback/0145_keyrings.down.sql"),
  "utf8",
);

describe("key ring migration", () => {
  it("keys each table as the plan says", async () => {
    const db = makeTestDb();
    const pk = async (t: string) =>
      (
        await db.all<{ name: string; pk: number }>(
          `SELECT name, pk FROM pragma_table_info('${t}')`,
        )
      )
        .filter((c) => c.pk)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);
    expect(await pk("keyrings")).toEqual(["product", "subject"]);
    expect(await pk("keyring_wraps")).toEqual([
      "product",
      "subject",
      "device_id",
      "ring_id",
      "epoch",
    ]);
    expect(await pk("keyring_adopted")).toEqual([
      "product",
      "subject",
      "ring_id",
      "epoch",
    ]);
  });

  it("its down script drops them and is safe to run twice", async () => {
    const db = makeTestDb();
    const left = async () =>
      (
        await db.all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE name LIKE '%keyring%'",
        )
      ).map((r) => r.name);
    expect((await left()).length).toBeGreaterThan(0);
    for (let i = 0; i < 2; i++)
      for (const stmt of down.replace(/^--.*$/gm, "").split(";"))
        if (stmt.trim()) await db.run(stmt);
    expect(await left()).toEqual([]);
  });
});
