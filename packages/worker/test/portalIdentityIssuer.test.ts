// I-01 (S-16 G14): migrations/0059 keys portal identities by issuer. The migration itself only
// guards new rows (D1 SQL cannot read the platform issuer, a Worker secret); the backfill is
// `rekeyLegacyPortalIdentities`. Driven here against a database migrated to just before 0059, so
// the legacy row is written exactly as production holds it.

import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SqliteDb } from "../src/db/sqlite.js";
import { rekeyLegacyPortalIdentities } from "../src/services/identity/portal/repo.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const MIGRATION = "0059_portal_identity_issuer.sql";
const ISSUER = "https://id.example";
const NOW = 1_700_000_000;

function migratedTo(stopBefore: string): Database.Database {
  const sqlite = new Database(":memory:");
  const runScript = sqlite.exec.bind(sqlite);
  for (const f of readdirSync(DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    if (f >= stopBefore) break;
    runScript(readFileSync(join(DIR, f), "utf8"));
  }
  return sqlite;
}

function apply(sqlite: Database.Database, file: string): void {
  sqlite.exec.bind(sqlite)(readFileSync(join(DIR, file), "utf8"));
}

function seedLegacy(sqlite: Database.Database): void {
  sqlite
    .prepare(
      "INSERT INTO portal_accounts (id, status, created_at, modified_at) VALUES ('pa_1', 'active', ?, ?)",
    )
    .run(NOW, NOW);
  sqlite
    .prepare(
      `INSERT INTO portal_account_identities (provider, subject, account_id, created_at, last_seen_at)
       VALUES ('oidc', 'sub-1', 'pa_1', ?, ?)`,
    )
    .run(NOW, NOW);
}

describe("migrations/0059 portal identities keyed by issuer", () => {
  it("leaves existing rows untouched and refuses new issuer-less rows", () => {
    const sqlite = migratedTo(MIGRATION);
    seedLegacy(sqlite);
    apply(sqlite, MIGRATION);

    expect(
      sqlite
        .prepare("SELECT provider, subject FROM portal_account_identities")
        .all(),
    ).toEqual([{ provider: "oidc", subject: "sub-1" }]);
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO portal_account_identities (provider, subject, account_id, created_at, last_seen_at)
           VALUES ('oidc', 'sub-2', 'pa_1', ?, ?)`,
        )
        .run(NOW, NOW),
    ).toThrow(/portal_account_identities\.provider/);
    sqlite
      .prepare(
        `INSERT INTO portal_account_identities (provider, subject, account_id, created_at, last_seen_at)
         VALUES (?, 'sub-2', 'pa_1', ?, ?)`,
      )
      .run(ISSUER, NOW, NOW);
  });

  it("is idempotent when re-applied", () => {
    const sqlite = migratedTo(MIGRATION);
    apply(sqlite, MIGRATION);
    expect(() => apply(sqlite, MIGRATION)).not.toThrow();
  });

  it("the Worker backfill re-keys legacy rows to the configured issuer, idempotently", async () => {
    const sqlite = migratedTo(MIGRATION);
    seedLegacy(sqlite);
    apply(sqlite, MIGRATION);
    const db = new SqliteDb(sqlite);

    await rekeyLegacyPortalIdentities(db, ISSUER);
    await rekeyLegacyPortalIdentities(db, ISSUER);
    expect(
      await db.all(
        "SELECT provider, subject, account_id FROM portal_account_identities",
      ),
    ).toEqual([{ provider: ISSUER, subject: "sub-1", account_id: "pa_1" }]);
  });

  it("the rollback statements restore the pre-0059 shape", async () => {
    const sqlite = migratedTo(MIGRATION);
    seedLegacy(sqlite);
    apply(sqlite, MIGRATION);
    await rekeyLegacyPortalIdentities(new SqliteDb(sqlite), ISSUER);

    sqlite.exec.bind(sqlite)(
      `DROP TRIGGER IF EXISTS trg_portal_identities_issuer_ins;
       UPDATE OR IGNORE portal_account_identities SET provider = 'oidc' WHERE provider = '${ISSUER}';`,
    );
    expect(
      sqlite.prepare("SELECT provider FROM portal_account_identities").all(),
    ).toEqual([{ provider: "oidc" }]);
  });
});
