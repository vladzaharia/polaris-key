import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { NOW, seedProduct } from "./seed.js";

async function tableNames(): Promise<Set<string>> {
  const db = makeTestDb();
  const rows = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  );
  return new Set(rows.map((row) => row.name));
}

async function columnNames(table: string): Promise<Set<string>> {
  const db = makeTestDb();
  const rows = await db.all<{ name: string }>(`PRAGMA table_info(${table})`);
  return new Set(rows.map((row) => row.name));
}

describe("backend contract migrations", () => {
  it("creates first-class customers/devices and release portal tables", async () => {
    const tables = await tableNames();

    expect([...tables].sort()).toEqual(
      expect.arrayContaining([
        "customers",
        "devices",
        "release_metadata",
        "release_artifacts",
        "release_channels",
        "release_health",
        "release_download_tokens",
      ]),
    );
  });

  it("creates first-class device columns only", async () => {
    const deviceColumns = await columnNames("devices");

    expect([...deviceColumns]).toEqual(
      expect.arrayContaining([
        "device_id",
        "customer_id",
        "license_id",
        "token_hash",
      ]),
    );
  });

  it("defaults release config access to public metadata and artifacts", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await db.run("INSERT INTO release_config (product) VALUES (?)", "acme");

    const row = await db.first<{
      metadata_access: string;
      artifacts_access: string;
    }>(
      "SELECT metadata_access, artifacts_access FROM release_config WHERE product = ?",
      "acme",
    );

    expect(row).toEqual({
      metadata_access: "public",
      artifacts_access: "public",
    });
  });
});
