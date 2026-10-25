// Migration 0118 replayed on a populated licenses table: the column arrives, and the backfill
// stamps only the rows an OIDC sign-in minted, with the class their product resolves to today.
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_ROOT } from "../../paths.js";

const DIR = join(TEST_ROOT, "..", "migrations");
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const TARGET = FILES.find((f) => f.endsWith("_license_email_issuer.sql"))!;

/** Every migration before the target, applied to an empty database with the fixtures in place. */
function populated(): Database.Database {
  const db = new Database(":memory:");
  for (const f of FILES) {
    if (f >= TARGET) break;
    db.exec(readFileSync(join(DIR, f), "utf8"));
  }
  db.pragma("foreign_keys = OFF");
  const oidc = db.prepare(
    `INSERT INTO oidc_config (product, issuer, client_id, client_secret_secret,
       redirect_uris_json, group_role_map_json, provider) VALUES (?, ?, ?, NULL, NULL, '{}', ?)`,
  );
  oidc.run("custom-p", "https://idp.example", "client", "custom");
  oidc.run("platform-p", null, null, "platform");
  const license = db.prepare(
    `INSERT INTO licenses (product, id, status, activated_at, origin, modified_at)
     VALUES (?, ?, 'active', 1, ?, 1)`,
  );
  license.run("custom-p", "oidc-custom", "oidc");
  license.run("platform-p", "oidc-platform", "oidc");
  license.run("bare-p", "oidc-bare", "oidc");
  license.run("custom-p", "admin-custom", "admin");
  license.run("custom-p", "enroll-custom", "enroll");
  return db;
}

function classes(db: Database.Database): Record<string, string | null> {
  const rows = db
    .prepare("SELECT id, email_issuer_class AS c FROM licenses")
    .all() as { id: string; c: string | null }[];
  return Object.fromEntries(rows.map((r) => [r.id, r.c]));
}

describe("license email issuer migration", () => {
  it("stamps only OIDC-minted rows, with the class their product resolves to today", () => {
    const db = populated();
    db.exec(readFileSync(join(DIR, TARGET), "utf8"));
    expect(classes(db)).toEqual({
      "oidc-custom": "custom",
      "oidc-platform": "platform",
      // No oidc_config row: nothing resolved, so the live-provider fallback stays in force.
      "oidc-bare": null,
      // An operator-created or enrolled row's address was asserted by no issuer.
      "admin-custom": null,
      "enroll-custom": null,
    });
  });

  it("dies on its ALTER when replayed, before it reaches the backfill", () => {
    const db = populated();
    const sql = readFileSync(join(DIR, TARGET), "utf8");
    db.exec(sql);
    db.prepare(
      "UPDATE licenses SET email_issuer_class = 'platform' WHERE id = 'oidc-custom'",
    ).run();
    expect(() => db.exec(sql)).toThrow(/duplicate column name/);
    // The replay changed nothing: the stamp a sign-in wrote since is still there.
    expect(classes(db)["oidc-custom"]).toBe("platform");
  });
});
