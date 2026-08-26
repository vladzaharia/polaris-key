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
  it("creates first-class devices and release portal tables", async () => {
    const tables = await tableNames();

    expect([...tables].sort()).toEqual(
      expect.arrayContaining([
        "devices",
        "release_metadata",
        "release_artifacts",
        "release_channels",
        "release_health",
        "release_download_tokens",
      ]),
    );
  });

  // FIXED (R11-13 / R12-10): `customers` and `identity` carried sub/name/email/groups_json with
  // NO reader and NO writer anywhere in src/ — latent PII stores with no owner, no erasure path
  // and no retention story. 0016_drop_dead_pii.sql removes both, along with
  // release_download_tokens.customer_id (always written NULL, read nowhere).
  it("no longer carries the dead PII-bearing tables", async () => {
    const tables = await tableNames();

    expect(tables.has("customers")).toBe(false);
    expect(tables.has("identity")).toBe(false);
    expect(await columnNames("release_download_tokens")).not.toContain(
      "customer_id",
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
