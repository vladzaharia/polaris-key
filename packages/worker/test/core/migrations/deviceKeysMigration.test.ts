// Migration 0143_a (CC-03.1): `device_keys`, its unique agreeKey index, the index assertion that
// names it, and the down script. Runs against the fully migrated test database.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_ROOT } from "../../paths.js";
import { makeTestDb } from "../../helpers.js";

const ROOT = join(TEST_ROOT, "..");
const sqlFile = (dir: string, suffix: string): string =>
  readFileSync(
    join(
      ROOT,
      dir,
      readdirSync(join(ROOT, dir)).find((f) => f.endsWith(suffix))!,
    ),
    "utf8",
  );

describe("device keys migration", () => {
  it("has a composite key and a unique agree key per product", async () => {
    const db = makeTestDb();
    const cols = await db.all<{ name: string; pk: number }>(
      "SELECT name, pk FROM pragma_table_info('device_keys')",
    );
    expect(cols.map((c) => c.name)).toEqual([
      "product",
      "device_id",
      "sign_key",
      "agree_key",
      "key_seq",
      "created_at",
      "rotated_at",
    ]);
    expect(cols.filter((c) => c.pk).map((c) => c.name)).toEqual([
      "product",
      "device_id",
    ]);
    const ins = (p: string, d: string) =>
      db.run(
        "INSERT INTO device_keys (product, device_id, sign_key, agree_key, created_at) VALUES (?, ?, 's', 'a', 1)",
        p,
        d,
      );
    await ins("p", "d1");
    await expect(ins("p", "d2")).rejects.toThrow(/UNIQUE/);
    await ins("q", "d2");
  });

  it("the index assertion names the index and the deployed schema satisfies it", async () => {
    const files = readdirSync(join(ROOT, "migrations"))
      .filter((f) => f.endsWith("_index_assertion.sql"))
      .sort();
    expect(
      readFileSync(join(ROOT, "migrations", files.at(-1)!), "utf8"),
    ).toContain("idx_device_keys_agree");
    const row = await makeTestDb().first<{ ok: number }>(
      "SELECT expected = found AS ok FROM schema_index_assertion",
    );
    expect(row).toEqual({ ok: 1 });
  });

  it("its down script drops the table and is safe to run twice", async () => {
    const db = makeTestDb();
    const down = sqlFile("scripts/rollback", "_device_keys.down.sql");
    const left = async () =>
      (
        await db.all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE name LIKE '%device_keys%'",
        )
      ).map((r) => r.name);
    expect(await left()).toContain("device_keys");
    for (let i = 0; i < 2; i++) {
      for (const stmt of down.replace(/^--.*$/gm, "").split(";")) {
        if (stmt.trim()) await db.run(stmt);
      }
    }
    expect(await left()).toEqual([]);
  });
});
