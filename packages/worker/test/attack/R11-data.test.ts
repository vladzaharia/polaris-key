// R11 — RED TEAM: data layer (schema, migrations, constraints, integrity).
// These tests are ADVERSARIAL: most of them assert the CURRENT (broken/weak) behaviour so a
// future fix makes them fail loudly. Nothing here modifies src/ or migrations/.

import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTestDb } from "../helpers.js";
import { NOW, seedProduct } from "../seed.js";
import {
  claimDeviceSeat,
  countActiveDevices,
  getActiveProductKey,
  insertKey,
  insertLicense,
  insertProductKey,
  listVerificationProductKeys,
  seatActiveSince,
  SEAT_DORMANCY_SECONDS,
  setDeviceStatus,
  upsertDevice,
  type DeviceRow,
  type LicenseRow,
} from "../../src/repo.js";
import { D1Db } from "../../src/db/d1.js";
import { deleteProfile, deleteTier } from "../../src/admin/repo.js";
import { licenseSummary } from "../../src/core/licensing/summary.js";
import {
  getOrCreateAccountByEmail,
  linkLicense,
  listPortalLicenses,
  purgeExpiredDownloadTokens,
  syncAccountLicenseLinks,
} from "../../src/services/identity/portal/repo.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "..", "migrations");
const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const sqlFor = (f: string) => readFileSync(join(MIGRATIONS_DIR, f), "utf8");

/** Fresh raw better-sqlite3 handle plus a bound multi-statement DDL runner. */
function rawSqlite(): {
  handle: Database.Database;
  runScript: (sql: string) => unknown;
} {
  const handle = new Database(":memory:");
  return { handle, runScript: handle.exec.bind(handle) };
}

const lic = (
  product: string,
  id: string,
  over: Partial<LicenseRow> = {},
): LicenseRow => ({
  product,
  id,
  status: "active",
  sub: null,
  name: null,
  email: null,
  groups_json: null,
  tier_id: null,
  activated_at: NOW,
  expires_at: null,
  max_offline_days: null,
  overrides_json: null,
  channels_json: null,
  min_version: null,
  max_version: null,
  modified_by: null,
  modified_at: NOW,
  ...over,
});

const dev = (
  product: string,
  deviceId: string,
  licenseId: string,
  over: Partial<DeviceRow> = {},
): DeviceRow => ({
  product,
  device_id: deviceId,
  customer_id: null,
  license_id: licenseId,
  status: "authorized",
  first_seen: NOW,
  last_seen: NOW,
  ua: null,
  label: null,
  overrides_json: null,
  reported_json: null,
  token_hash: null,
  ...over,
});

// ── R11-01 — FK coverage: child tables have NO FK to their logical parent ─────
describe("R11-01 missing foreign keys / no ON DELETE anywhere", () => {
  it("foreign_keys pragma IS on in the harness, so missing FKs are a schema gap not a pragma gap", async () => {
    const db = makeTestDb();
    const fk = await db.first<{ foreign_keys: number }>("PRAGMA foreign_keys");
    expect(fk?.foreign_keys).toBe(1);
  });

  // PARTIALLY FIXED (R11-01, residual 6): 0017_portal_fk_cascade.sql rebuilds the four portal
  // tables so their foreign keys declare `ON DELETE CASCADE` — the tables whose orphans would be
  // PII, and the ones `DELETE /api/me` depends on. The rest are UNCHANGED and deliberately so:
  // rebuilding `licenses`/`devices`/`keys_index`/`product_keys`/`products`/`tiers` would have to
  // reconstruct the sixteen RAISE(ABORT) triggers 0015 hangs off them (a DROP TABLE takes a
  // table's triggers with it), on D1, with no wrapping transaction. A half-landed rebuild leaves
  // a populated table with no constraints, which is worse than the missing ON DELETE.
  it("the portal tables now declare ON DELETE CASCADE; the product-scoped ones still do not", async () => {
    const db = makeTestDb();
    const cascading = [
      "portal_account_emails",
      "portal_account_identities",
      "portal_license_links",
      "portal_product_settings",
      // I-05 (0068_a): the account's child tables cascade from `accounts`, for the same reason
      // the portal ones do — an orphaned sign-in method or subject would be PII.
      "account_links",
      "account_product_subjects",
      "account_sessions",
      "account_product_grants",
      "account_passkeys",
      // PX-W15: terms acceptances are the account's too (an orphan would say what a deleted
      // person agreed to).
      "account_terms_acceptances",
      // HA-08: a release file's mirror job is meaningless without the file; a new table, so it
      // declares the cascade from the start (no rebuild, no triggers to reconstruct).
      "release_mirrors",
    ];
    for (const table of cascading) {
      const fks = await db.all<{ on_delete: string; table: string }>(
        `PRAGMA foreign_key_list(${table})`,
      );
      expect(fks.length).toBeGreaterThan(0);
      expect(fks.every((f) => f.on_delete === "CASCADE")).toBe(true);
    }

    // Everything else still has NO ON DELETE at all — reported, not fixed.
    const rows = await db.all<{ name: string; sql: string }>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL",
    );
    const rest = rows
      .filter((r) => !cascading.includes(r.name))
      .map((r) => r.sql)
      .join("\n");
    expect(rest).toContain("REFERENCES");
    expect(/ON\s+DELETE/i.test(rest)).toBe(false);
    // ON UPDATE is declared NOWHERE, including on the rebuilt tables: a product slug and a
    // portal account id are immutable primary keys, so there is no update to cascade.
    expect(/ON\s+UPDATE/i.test(rows.map((r) => r.sql).join("\n"))).toBe(false);
  });

  // FIXED (R11-09): erasing a portal account no longer depends on the application remembering
  // to walk its children — the schema does it. This is the property `DELETE /api/me` rests on.
  it("deleting a portal account CASCADEs its emails, identities and license links", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    // The pre-I-05 tables, as a Worker rolled back to before I-05 still writes them.
    await db.run(
      `INSERT INTO portal_accounts (id, status, created_at, modified_at)
       VALUES ('acct_legacy', 'active', ?, ?)`,
      NOW,
      NOW,
    );
    await db.run(
      `INSERT INTO portal_account_emails (email, account_id, verified_at, created_at)
       VALUES ('erase@example.com', 'acct_legacy', ?, ?)`,
      NOW,
      NOW,
    );
    await db.run(
      `INSERT INTO portal_license_links (account_id, product, license_id, source, created_at, last_seen_at)
       VALUES ('acct_legacy', 'acme', 'lic-1', 'admin', ?, ?)`,
      NOW,
      NOW,
    );
    await db.run(
      `INSERT INTO portal_account_identities (provider, subject, account_id, created_at, last_seen_at)
       VALUES ('https://id.example', 'sub-1', 'acct_legacy', ?, ?)`,
      NOW,
      NOW,
    );

    await db.run("DELETE FROM portal_accounts WHERE id = 'acct_legacy'");

    for (const table of [
      "portal_account_emails",
      "portal_account_identities",
      "portal_license_links",
    ]) {
      const n = await db.first<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE account_id = 'acct_legacy'`,
      );
      expect(n?.n).toBe(0);
    }
  });

  // I-05: the same property for the account model — deleting the `accounts` row takes its
  // sign-in methods and pairwise subjects with it.
  it("deleting an account CASCADEs its sign-in methods and pairwise subjects", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await insertLicense(db, lic("acme", "lic-1"));
    const acct = await getOrCreateAccountByEmail(db, "erase@example.com", NOW);
    await linkLicense(db, acct.id, "acme", "lic-1", "admin", NOW);

    await db.run("DELETE FROM accounts WHERE id = ?", acct.id);

    for (const table of ["account_links", "account_product_subjects"]) {
      const n = await db.first<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE account_id = ?`,
        acct.id,
      );
      expect(n?.n).toBe(0);
    }
  });

  // PARTIALLY FIXED (R11-13): `identity` is dropped by 0016_drop_dead_pii.sql, so it is no
  // longer in this list. The missing FKs on the surviving tables are UNCHANGED — adding them
  // needs a rebuild of five tables and is reported, not fixed, in this lane.
  it("keys_index / devices / license_profiles have NO FK to licenses at all", async () => {
    const db = makeTestDb();
    expect(
      await db.all("SELECT name FROM sqlite_master WHERE name = 'identity'"),
    ).toHaveLength(0);
    for (const table of ["keys_index", "devices", "license_profiles"]) {
      const fks = await db.all<{ from: string }>(
        `PRAGMA foreign_key_list(${table})`,
      );
      // The only FK any of them declares is `product -> products(slug)`.
      expect(fks.map((f) => f.from)).toEqual(["product"]);
    }
  });

  it("a live key row can be inserted for a license that does not exist", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await insertKey(db, {
      product: "acme",
      key_hash: "hash-of-a-live-key",
      license_id: "lic-that-never-existed",
      status: "active",
      label: null,
      created_at: NOW,
      created_by: null,
      last_used_at: null,
    });
    const n = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM keys_index WHERE license_id = 'lic-that-never-existed'",
    );
    expect(n?.n).toBe(1); // no FK rejected it
  });

  it("deleteProfile orphans license_profiles rows and dangles tiers.profile_id", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await db.run(
      "INSERT INTO profiles (product, id, name, description, payload_json, modified_by, modified_at) VALUES ('acme','p1','P1',NULL,'{}',NULL,?)",
      NOW,
    );
    await insertLicense(db, lic("acme", "lic-1", { tier_id: "t1" }));
    await db.run(
      "INSERT INTO license_profiles (product, license_id, profile_id, sort_order) VALUES ('acme','lic-1','p1',0)",
    );
    await db.run(
      "INSERT INTO tiers (product, id, label, profile_id, modified_at) VALUES ('acme','t1','T1','p1',?)",
      NOW,
    );

    await deleteProfile(db, "acme", "p1"); // admin/repo.ts:229 — a bare DELETE

    const orphanLinks = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM license_profiles WHERE product='acme' AND profile_id='p1'",
    );
    const danglingTier = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM tiers WHERE product='acme' AND profile_id='p1'",
    );
    expect(orphanLinks?.n).toBe(1); // orphaned
    expect(danglingTier?.n).toBe(1); // dangling
  });

  it("deleteTier leaves licenses.tier_id pointing at a tier that no longer exists", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await db.run(
      "INSERT INTO tiers (product, id, label, modified_at) VALUES ('acme','pro','Pro',?)",
      NOW,
    );
    await insertLicense(db, lic("acme", "lic-1", { tier_id: "pro" }));
    await deleteTier(db, "acme", "pro");
    const row = await db.first<{ tier_id: string | null }>(
      "SELECT tier_id FROM licenses WHERE product='acme' AND id='lic-1'",
    );
    expect(row?.tier_id).toBe("pro"); // dangling reference survives
  });

  // FIXED (I-05): the owner pointer is a column ON the licence (`licenses.account_id`), so a
  // link to a licence that does not exist cannot be written at all. (`portal_license_links`
  // still has no FK to licenses; it is the pre-I-05 copy and nothing writes it any more.)
  it("an account cannot be linked to a license that does not exist", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    const acct = await getOrCreateAccountByEmail(db, "a@example.com", NOW);
    await linkLicense(db, acct.id, "acme", "no-such-license", "admin", NOW);
    const n = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM portal_license_links WHERE license_id='no-such-license'",
    );
    expect(n?.n).toBe(0);
    expect(
      await db.first(
        "SELECT 1 FROM account_product_subjects WHERE account_id = ?",
        acct.id,
      ),
    ).toBeNull();
    expect(await listPortalLicenses(db, acct.id)).toHaveLength(0);
  });
});

// ── R11-02 — no CHECK constraints on the status columns that matter ───────────
describe("R11-02 status vocabulary drift", () => {
  // FIXED (R11-07 part A): 0015_data_integrity.sql constrains product_keys.status to the four
  // values the code actually writes, so a typo is refused at write time instead of producing a
  // row that silently disappears from every read path with no way to repair it via the API.
  it("product_keys.status now REJECTS a value that is in no code path", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await expect(
      insertProductKey(db, {
        product: "acme",
        kid: "typo-key",
        alg: "Ed25519",
        public_b64url: "AAAA",
        enc_private_json: "{}",
        status: "retiredd", // typo
        created_at: NOW,
        rotated_at: null,
        revoked_at: null,
      }),
    ).rejects.toThrow(/product_keys.status/);
    const rows = await listVerificationProductKeys(db, "acme");
    expect(rows.find((r) => r.kid === "typo-key")).toBeUndefined();
  });

  it("'retired' keys STILL verify, 'revoked' keys do not — the spellings mean different things", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    for (const [kid, status] of [
      ["k-retired", "retired"],
      ["k-revoked", "revoked"],
      ["k-staged", "staged"],
    ] as const) {
      await insertProductKey(db, {
        product: "acme",
        kid,
        alg: "Ed25519",
        public_b64url: `pub-${kid}`,
        enc_private_json: "{}",
        status,
        created_at: NOW,
        rotated_at: null,
        revoked_at: null,
      });
    }
    const kids = (await listVerificationProductKeys(db, "acme")).map(
      (r) => r.kid,
    );
    expect(kids).toContain("k-retired"); // still trusted by JWKS
    expect(kids).toContain("k-staged");
    expect(kids).not.toContain("k-revoked"); // revocation DOES work server-side
  });

  it("retiring/revoking the ACTIVE key bricks the product: no constraint keeps one active", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    const active = await getActiveProductKey(db, "acme");
    expect(active).not.toBeNull();
    // admin/handlers/products.ts:731-737 — the retire/revoke action has no `status` guard.
    await db.run(
      "UPDATE product_keys SET status = 'retired', rotated_at = ? WHERE product = ? AND kid = ?",
      NOW,
      "acme",
      active?.kid ?? "",
    );
    // loadProduct() returns null with no active key => every signed surface goes dark.
    expect(await getActiveProductKey(db, "acme")).toBeNull();
  });

  // FIXED (R11-07 part A): each of these used to insert cleanly and then fail closed at read
  // time in a way NO handler could repair, because no code path matches the value.
  it("licenses.status / keys_index.status / devices.status now reject arbitrary garbage", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await expect(
      insertLicense(db, lic("acme", "lic-1", { status: "aktive" })),
    ).rejects.toThrow(/licenses.status/);

    await insertLicense(db, lic("acme", "lic-1"));
    await expect(
      insertKey(db, {
        product: "acme",
        key_hash: "h1",
        license_id: "lic-1",
        status: "ACTIVE", // case differs => never equal to 'active'
        label: null,
        created_at: NOW,
        created_by: null,
        last_used_at: null,
      }),
    ).rejects.toThrow(/keys_index.status/);

    await expect(
      upsertDevice(db, dev("acme", "d1", "lic-1", { status: "authorised" })),
    ).rejects.toThrow(/devices.status/);

    expect(
      (
        await db.first<{ status: string }>(
          "SELECT status FROM licenses WHERE id='lic-1'",
        )
      )?.status,
    ).toBe("active");
    expect(await countActiveDevices(db, "acme", "lic-1")).toBe(0);
  });

  // FIXED (R11-07 part A): licenses.origin is constrained to admin | oidc | enroll.
  it("licenses.origin is now constrained to its documented 3-value vocabulary", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await expect(
      insertLicense(db, lic("acme", "lic-x", { origin: "whatever" })),
    ).rejects.toThrow(/licenses.origin/);
    for (const origin of ["admin", "oidc", "enroll"]) {
      await insertLicense(db, lic("acme", `lic-${origin}`, { origin }));
    }
  });
});

// ── R11-03 — seat consumption has no DB-level guard ──────────────────────────
describe("R11-03 seat-count race", () => {
  // FIXED (R11-02 / R3-02, DB half): 0014 adds devices.seat_no and 0015 adds the partial
  // unique index that arbitrates concurrent seat claims — the same pattern
  // idx_licenses_enroll_hwid already uses for enrolment. `claimDeviceSeat()` in repo.ts is the
  // atomic primitive built on it; wiring it into licenseCore.authorizeDevice belongs to the
  // licensing lane and is written up in the R11 audit findings § Remediation.
  it("a partial unique index now constrains authorized seats per license", async () => {
    const db = makeTestDb();
    const idx = await db.all<{ name: string; sql: string | null }>(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='devices'",
    );
    const seat = idx.find((i) => i.name === "idx_devices_seat");
    expect(seat).toBeDefined();
    expect(seat!.sql).toMatch(/UNIQUE/i);
    expect(seat!.sql).toMatch(/seat_no/);

    // …and it really refuses a duplicate ordinal on the same license.
    await seedProduct(db, "acme");
    await insertLicense(db, lic("acme", "lic-1"));
    await upsertDevice(db, dev("acme", "d1", "lic-1"));
    await upsertDevice(db, dev("acme", "d2", "lic-1"));
    await db.run(
      "UPDATE devices SET seat_no = 1 WHERE product='acme' AND device_id='d1'",
    );
    await expect(
      db.run(
        "UPDATE devices SET seat_no = 1 WHERE product='acme' AND device_id='d2'",
      ),
    ).rejects.toThrow(/UNIQUE/i);
  });

  it("claimDeviceSeat() refuses the (limit + 1)-th install and is idempotent per device", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await insertLicense(db, lic("acme", "lic-1"));
    expect(await claimDeviceSeat(db, "acme", "lic-1", "d1", 2, NOW)).toBe(true);
    expect(await claimDeviceSeat(db, "acme", "lic-1", "d2", 2, NOW)).toBe(true);
    expect(await claimDeviceSeat(db, "acme", "lic-1", "d3", 2, NOW)).toBe(
      false,
    );
    // A refresh of a device that already holds a seat consumes nothing.
    expect(await claimDeviceSeat(db, "acme", "lic-1", "d1", 2, NOW)).toBe(true);
    expect(await countActiveDevices(db, "acme", "lic-1")).toBe(2);
    // Deauthorizing frees the ordinal for the next install.
    await setDeviceStatus(db, "acme", "d1", "deauthorized");
    expect(await claimDeviceSeat(db, "acme", "lic-1", "d3", 2, NOW)).toBe(true);
  });

  it("check-then-act: countActiveDevices() then upsertDevice() overshoots the limit", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await insertLicense(db, lic("acme", "lic-1"));
    const LIMIT = 2;

    // Two concurrent requests both read the count BEFORE either writes — exactly what
    // licenseCore.ts:346-350 does, with no transaction, no row lock, no DB constraint.
    await upsertDevice(db, dev("acme", "d1", "lic-1"));
    const countA = await countActiveDevices(db, "acme", "lic-1");
    const countB = await countActiveDevices(db, "acme", "lic-1");
    expect(countA).toBeLessThan(LIMIT);
    expect(countB).toBeLessThan(LIMIT);
    await upsertDevice(db, dev("acme", "d2", "lic-1")); // A commits
    await upsertDevice(db, dev("acme", "d3", "lic-1")); // B commits

    expect(await countActiveDevices(db, "acme", "lic-1")).toBe(3); // limit was 2
  });

  // FIXED (business model): neither `countActiveDevices` nor `claimDeviceSeat`'s ordinal map
  // had a `last_seen` predicate, so a device that stopped checking in a year ago still held a
  // seat forever. On a 1- or 2-seat product a decommissioned laptop permanently consumed
  // capacity the customer had paid for.
  it("a dormant device's seat is reclaimed; the seat map and the count agree", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await insertLicense(db, lic("acme", "lic-1"));
    const LATER = NOW + SEAT_DORMANCY_SECONDS + 86400;

    expect(await claimDeviceSeat(db, "acme", "lic-1", "d1", 2, NOW)).toBe(true);
    expect(await claimDeviceSeat(db, "acme", "lic-1", "d2", 2, NOW)).toBe(true);
    expect(await claimDeviceSeat(db, "acme", "lic-1", "d3", 2, NOW)).toBe(
      false,
    );

    // d1 keeps checking in; d2 goes dark. Long after the dormancy window, d3 gets d2's seat.
    await db.run(
      "UPDATE devices SET last_seen = ? WHERE product='acme' AND device_id='d1'",
      LATER,
    );
    expect(await claimDeviceSeat(db, "acme", "lic-1", "d3", 2, LATER)).toBe(
      true,
    );

    // Both halves see the same world: d2 no longer counts and no longer holds an ordinal.
    expect(
      await countActiveDevices(db, "acme", "lic-1", seatActiveSince(LATER)),
    ).toBe(2);
    const d2 = await db.first<{ seat_no: number | null; status: string }>(
      "SELECT seat_no, status FROM devices WHERE product='acme' AND device_id='d2'",
    );
    expect(d2?.seat_no).toBeNull();
    // Reclaiming capacity does NOT delete or deauthorize the row — a device that comes back
    // simply re-claims a seat (or gets a clean device_limit error if the licence has filled).
    expect(d2?.status).toBe("authorized");
    expect(await claimDeviceSeat(db, "acme", "lic-1", "d2", 2, LATER)).toBe(
      false,
    );

    // Without the window, the unfiltered count still reports every authorized row, which is
    // what the admin/reporting views want.
    expect(await countActiveDevices(db, "acme", "lic-1")).toBe(3);
  });
});

// ── R11-04 — soft delete keeps PII; audit tables are unbounded ────────────────
describe("R11-04 erasure / retention", () => {
  it("product soft-delete keeps every licence email, name and OIDC subject", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await insertLicense(
      db,
      lic("acme", "lic-1", {
        email: "victim@example.com",
        name: "Victim Person",
        sub: "oidc|victim",
      }),
    );
    await db.run(
      "UPDATE products SET status='deleted', deleted_at=? WHERE slug='acme'",
      NOW,
    );
    const row = await db.first<{
      email: string;
      name: string;
      sub: string;
    }>(
      "SELECT email, name, sub FROM licenses WHERE product='acme' AND id='lic-1'",
    );
    expect(row?.email).toBe("victim@example.com");
    expect(row?.name).toBe("Victim Person");
    expect(row?.sub).toBe("oidc|victim");
  });

  // FIXED (R11-13 / R12-10): the `customers` table carried sub/name/email/groups_json behind
  // four indexes and a status CHECK with NO reader and NO writer in src/. 0016 drops it.
  it("the dead PII-bearing `customers` table no longer exists", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await expect(
      db.run(
        `INSERT INTO customers (product,id,status,sub,name,email,created_at,modified_at)
         VALUES ('acme','c1','deleted','oidc|c','Cust','c@example.com',?,?)`,
        NOW,
        NOW,
      ),
    ).rejects.toThrow(/no such table/i);
  });

  it("portal_account_emails.email is the PRIMARY KEY, so erasure means deleting the row", async () => {
    const db = makeTestDb();
    const cols = await db.all<{ name: string; pk: number }>(
      "PRAGMA table_info(portal_account_emails)",
    );
    expect(cols.find((c) => c.name === "email")?.pk).toBe(1);
  });

  it("audit and portal_audit have no retention column, index or cron", async () => {
    const db = makeTestDb();
    const cols = await db.all<{ name: string }>("PRAGMA table_info(audit)");
    expect(cols.map((c) => c.name)).not.toContain("expires_at");
    const pcols = await db.all<{ name: string }>(
      "PRAGMA table_info(portal_audit)",
    );
    expect(pcols.map((c) => c.name)).not.toContain("expires_at");
  });
});

// ── R11-05 — product scoping at the schema level ─────────────────────────────
describe("R11-05 product scoping", () => {
  it("every product-scoped table has `product` as PK column 1", async () => {
    const db = makeTestDb();
    const tables = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    );
    const globalByDesign = new Set([
      "products", // PK is `slug`
      "portal_accounts",
      "portal_account_emails",
      "portal_account_identities",
      "portal_license_links", // PK (account_id, product, license_id)
      "portal_audit", // PK id, `product` nullable
      // 0018_index_assertion.sql — a single-row deploy-time assertion about the SCHEMA, which
      // is platform-wide by definition. It holds no tenant data of any kind.
      "schema_index_assertion",
      // 0026_blob_store.sql — content-addressed objects are SHARED: one stored blob can be
      // referenced by several products, so the row is keyed by its storage key alone. Tenancy
      // lives in `blob_refs`, which IS product-first (checked below by this same loop), and
      // every byte route asks `hasRef(db, product, key)` before serving.
      "blob_objects",
      // 0048_a (P4-14) — the blob collector's trail. An object's deletion belongs to no product
      // (the object was shared), so the row is keyed by an autoincrement id with `product`
      // nullable; it is written only by the nightly collector and read by no tenant route.
      "blob_gc_log",
      // 0055 (A-16) — the platform's team-level store connection: one credential per store slot
      // and one setting per store key, belonging to no product. Per-product use is gated by
      // `platform_credential_pins`, which IS product-first (checked by this loop).
      "platform_credentials",
      "platform_store_settings",
      // 0054_a (A-11) — the deploy history. A row describes the whole deployment, written only
      // by deploy.yml's final step and read only by the platform-admin Deployment endpoint.
      "platform_deploys",
      // 0054_b (A-12) — the product-less audit trail: platform actions that belong to no
      // product (the KEK sweep, A-13's settings). Read only by the platform-admin activity
      // endpoint; product-scoped actions still go to `audit`, which is product-first.
      "platform_audit",
      // 0056 (A-13) — the platform settings store: instance-wide runtime values for the keys of
      // the typed `PLATFORM_SETTINGS` registry (background-job switches and tunables, no tenant
      // data). Written and read only by the platform-admin settings endpoint and the resolver.
      "platform_settings",
      // 0057 (A-14) — self-reported operations: one row per cron step family or failed step
      // (`platform_job_runs`) and one heartbeat per Worker script (`platform_heartbeats`). Both
      // describe the deployment's own background work, are written only by the cron and the
      // lazy-delta consumer, and are read only by the platform-admin Operations endpoint.
      "platform_job_runs",
      "platform_heartbeats",
      // 0059 (A-17a) — the App Store Connect operation ledger. A TEAM-scope step (a bundle id, a
      // capability) belongs to no product, so `product` is NULL there (a CHECK ties it to
      // `scope`) and the key is the derived `op_id`; product-scope reads always filter on
      // `product`. Written only by `core/storefront/ledger.ts` on a platform admin's behalf.
      "store_operations",
      // 0058_d (F-03) — the platform's per-ecosystem package-feed kill switch and size ceiling.
      // One row per ecosystem, above every owner's own settings; written only by a platform
      // admin. Each owner's settings live in `dist_registry_feeds`, which IS product-first.
      "dist_registry_policy",
      // 0062 (I-18) — the email suppression list. A bounce or a complaint hurts the ONE shared
      // sender whichever product's mail caused it, so an entry belongs to no product: it is keyed
      // by the recipient's peppered hash alone and read only by `core/emailDelivery.ts` before
      // every send. The per-product caps (`email_product_caps`) ARE product-first (this loop).
      "email_suppressions",
      // 0068_a (I-05) — the Polaris Key account is PLATFORM-level (owner, 2026-10-04): one
      // person across every product, so the account, its sign-in methods, sessions, passkeys,
      // tombstones and per-product grants are keyed by the account, never by a product. Product-
      // scoped reads of the pairwise subject go through UNIQUE (product, subject); the subject
      // aliases and the developer feed (`subject_events`) ARE product-first (this loop).
      "accounts",
      "account_links",
      "account_product_subjects",
      "account_tombstones",
      "account_erasures",
      "account_sessions",
      "account_product_grants",
      "account_passkeys",
      // PX-W15 — terms acceptances, keyed (account, product, version) like the grants beside
      // them: the account's record of what it agreed to. Product deletion clears a product's rows
      // through its own index; no tenant route lists them.
      "account_terms_acceptances",
      // 0093 (PX-W16) — the account's pictures: one row per re-encoded asset, keyed by the asset
      // (a hash of the account and the picture) and owned by the account, never by a
      // product. An app sees a picture only through the account's consent step.
      "account_avatars",
      // PS-04 — the storefront's library entries, keyed (account, product) like the grants: an
      // open product in one account's library, no licence behind it. Product deletion clears a
      // product's rows through `idx_library_entries_product`; no tenant route lists them. (The
      // storefront's aggregates and dedupe keys, `storefront_daily` and `storefront_seen`, ARE
      // product-first: this loop checks them.)
      "library_entries",
      // 0098 (PX-W12) — account joins and their 72-hour undo: one row per join of two accounts,
      // keyed by the join and owned by the surviving account, never by a product. Read only by
      // that account's own portal session; no developer route reads it.
      "account_merges",
      // 0070 (A-18e) — the Play edit lease: one row per (store, app) while a caller holds an edit
      // on that app. An app id belongs to the store account, not a product (the platform service
      // account serves every product pinned to it; A-16's lister is team-wide), and the row holds
      // no tenant data: a caller kind, an actor id and two timestamps.
      "store_edit_leases",
      // 0103 (U-03) — the licence-override migration's one state row: the run is ONE
      // platform-wide run (notes/S-17 §5.12), so its notice, run and inventory belong to no
      // product. The per-product data (`account_overrides`, `override_migration_report`) IS
      // product-first (this loop).
      "override_migration",
    ]);
    const offenders: string[] = [];
    for (const t of tables.map((r) => r.name)) {
      if (globalByDesign.has(t)) continue;
      const cols = await db.all<{ name: string; pk: number }>(
        `PRAGMA table_info(${t})`,
      );
      const first = cols.find((c) => c.pk === 1);
      if (first?.name !== "product") offenders.push(`${t}:${first?.name}`);
    }
    expect(offenders).toEqual([]);
  });

  // FIXED (R11-05 / R11-12 / R5-10): the route has no product in its URL, so the predicate
  // cannot be product-scoped. `idx_release_download_tokens_hash` (0015) instead makes the hash
  // GLOBALLY unique — the real invariant for a 256-bit secret — which removes both the
  // ambiguity and the full scan on an unauthenticated, unrate-limited endpoint.
  it("getPortalDownloadToken() is now a unique-index SEARCH, not a full scan", async () => {
    const db = makeTestDb();
    const plan = await db.all<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT * FROM release_download_tokens WHERE token_hash = ?",
      "x",
    );
    const detail = plan.map((p) => p.detail).join(" ");
    expect(detail).toMatch(/SEARCH/);
    expect(detail).toMatch(/idx_release_download_tokens_hash/);
    expect(detail).not.toMatch(/SCAN/);
  });

  // FIXED (R11-05, partially): `purgeExpiredDownloadTokens()` is now called from the download
  // path itself, so the table is bounded by the live token set rather than growing forever.
  // The worker still exports no `scheduled()` handler — that remains reported, not fixed.
  it("release_download_tokens now has a purge path", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await db.run(
      `INSERT INTO release_metadata (product, release_id, version, created_at, modified_at)
       VALUES ('acme', 'r1', '1.0.0', ?, ?)`,
      NOW,
      NOW,
    );
    await db.run(
      `INSERT INTO release_download_tokens
         (product, token_hash, release_id, expires_at, created_at)
       VALUES ('acme', 'EXPIRED', 'r1', ?, ?)`,
      NOW - 1,
      NOW - 301,
    );
    expect(await purgeExpiredDownloadTokens(db, NOW)).toBe(1);
    expect(await db.all("SELECT * FROM release_download_tokens")).toHaveLength(
      0,
    );
  });

  // FIXED (R11-12 / R5-10): a second tenant can no longer register the same hash, so the
  // unscoped read can no longer resolve to an attacker-chosen `row.product`.
  it("two products can NO LONGER hold the same download token_hash", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await seedProduct(db, "other");
    for (const p of ["acme", "other"]) {
      await db.run(
        `INSERT INTO release_metadata (product, release_id, version, created_at, modified_at)
         VALUES (?, 'r1', '1.0.0', ?, ?)`,
        p,
        NOW,
        NOW,
      );
    }
    const insert = (p: string) =>
      db.run(
        `INSERT INTO release_download_tokens (product, token_hash, release_id, artifact_id, device_id, scope_json, expires_at, used_at, created_at)
         VALUES (?, 'COLLIDING-HASH', 'r1', NULL, NULL, NULL, ?, NULL, ?)`,
        p,
        NOW + 300,
        NOW,
      );
    await insert("acme");
    await expect(insert("other")).rejects.toThrow(/UNIQUE/i);

    const all = await db.all<{ product: string }>(
      "SELECT * FROM release_download_tokens WHERE token_hash = ?",
      "COLLIDING-HASH",
    );
    expect(all).toHaveLength(1);
    expect(all[0]!.product).toBe("acme");
  });
});

// ── R11-06 — attacker-triggerable full table scans ───────────────────────────
describe("R11-06 unindexed hot queries", () => {
  // FIXED (R11-08 / R10-13): `idx_licenses_email_lower` is an expression index on
  // lower(email), so the per-portal-request sweep is a SEARCH instead of an O(all tenants'
  // licenses) scan billed as rows-read on every page load.
  it("the lower(email) sweep is now an indexed SEARCH", async () => {
    const db = makeTestDb();
    const plan = await db.all<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT product, id FROM licenses WHERE lower(email) = ?",
      "a@example.com",
    );
    const detail = plan.map((p) => p.detail).join(" ");
    expect(detail).toMatch(/SEARCH licenses/);
    expect(detail).toMatch(/idx_licenses_email_lower/);
    const idx = await db.all<{ sql: string | null }>(
      "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='licenses'",
    );
    expect(idx.some((i) => /email/i.test(i.sql ?? ""))).toBe(true);
  });

  // FIXED (R11-08): idx_licenses_sub is (product, sub) and cannot serve a bare `sub = ?`;
  // idx_licenses_sub_global can.
  it("the companion `WHERE sub = ?` sweep is now an indexed SEARCH", async () => {
    const db = makeTestDb();
    const plan = await db.all<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT product, id FROM licenses WHERE sub = ?",
      "oidc|x",
    );
    const detail = plan.map((p) => p.detail).join(" ");
    expect(detail).toMatch(/SEARCH licenses/);
    expect(detail).toMatch(/idx_licenses_sub_global/);
  });

  it("the email sweep is CROSS-TENANT: one verified email links licences in every product", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await seedProduct(db, "other");
    await insertLicense(db, lic("acme", "a1", { email: "shared@example.com" }));
    await insertLicense(
      db,
      lic("other", "o1", { email: "SHARED@example.com" }),
    );

    const acct = await getOrCreateAccountByEmail(db, "shared@example.com", NOW);
    await syncAccountLicenseLinks(db, acct.id, NOW);

    const links = await db.all<{ product: string; license_id: string }>(
      "SELECT product, id AS license_id FROM licenses WHERE account_id = ?",
      acct.id,
    );
    // `lower(email) = ?` matches the differently-cased row too: both products are linked.
    expect(links.map((l) => l.product).sort()).toEqual(["acme", "other"]);
  });

  it("the seat-count query cannot use idx_devices_license — it scans the product's whole authorized set", async () => {
    const db = makeTestDb();
    const plan = await db.all<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM devices WHERE product = ? AND license_id = ? AND status = 'authorized'",
      "acme",
      "lic-1",
    );
    const detail = plan.map((p) => p.detail).join(" ");
    // FIXED (R11-10): idx_devices_license_status(product, license_id, status) means the seat
    // count is a covering lookup instead of a scan of the product's whole authorized set.
    expect(detail).toMatch(/idx_devices_license_status/);
    expect(detail).toMatch(/license_id=\?/);
  });

  it("audit keyset pagination IS indexed (control)", async () => {
    const db = makeTestDb();
    const plan = await db.all<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT * FROM audit WHERE product = ? ORDER BY at DESC, id DESC LIMIT 50",
      "acme",
    );
    expect(plan.map((p) => p.detail).join(" ")).toMatch(/idx_audit_time/);
  });
});

// ── R11-07 — JSON.parse of DB columns with no try/catch ──────────────────────
describe("R11-07 corrupt JSON column throws out of the handler", () => {
  // FIXED (R11-06): every `_json` column on the admin surface now reads through the single
  // guarded helper in admin/lib/shape.ts. `licenseSummary` runs for EVERY row of the license
  // list, so one corrupt channels_json used to 500 the whole admin view — including the view an
  // operator would use to repair it. It now degrades to an empty channel list.
  it("licenseSummary() DEGRADES on a corrupt licenses.channels_json instead of throwing", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await insertLicense(db, lic("acme", "lic-1"));
    await db.run(
      "UPDATE licenses SET channels_json = ? WHERE product='acme' AND id='lic-1'",
      "{not json",
    );
    const row = await db.first<LicenseRow>(
      "SELECT * FROM licenses WHERE product='acme' AND id='lic-1'",
    );
    const summary = await licenseSummary(db, "acme", row!);
    expect(summary.channels).toEqual([]);
    expect(summary.id).toBe("lic-1");
  });

  it("the fingerprint parse is the CORRECT (guarded) pattern — contrast case", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await db.run(
      `INSERT INTO device_fingerprints (product, device_id, hwid, components_json, anchor_hash, status, first_seen, last_seen)
       VALUES ('acme','d1','h','{not json',NULL,'verified',?,?)`,
      NOW,
      NOW,
    );
    const row = await db.first<{ components_json: string }>(
      "SELECT components_json FROM device_fingerprints WHERE device_id='d1'",
    );
    expect(row?.components_json).toBe("{not json"); // DB happily stores it
  });
});

// ── R11-08 — migrations are not re-runnable ──────────────────────────────────
describe("R11-08 migration safety", () => {
  it("re-running any ALTER-TABLE migration on an already-migrated DB throws", () => {
    const { runScript } = rawSqlite();
    for (const f of MIGRATION_FILES) runScript(sqlFor(f));
    const failures: string[] = [];
    for (const f of MIGRATION_FILES) {
      try {
        runScript(sqlFor(f));
      } catch (e) {
        failures.push(`${f}: ${(e as Error).message}`);
      }
    }
    // PARTIALLY FIXED (R11-04). SQLite has no `ADD COLUMN IF NOT EXISTS` and no conditional
    // DDL, so a bare ALTER can never be made replay-safe in pure SQL — the remaining failures
    // are inherent, and full replay-idempotency is REPORTED, not fixed, in this lane. What IS
    // fixed is stranding: 0006/0007 now put their idempotent statements FIRST, every new
    // migration is `IF NOT EXISTS` or a single ALTER with nothing after it, and
    // 0012_replay_guard.sql re-asserts the security-critical indexes unconditionally.
    expect(failures.join("\n")).toMatch(/duplicate column name/);
    expect(failures.map((f) => f.split(":")[0])).not.toContain(
      "0012_replay_guard.sql",
    );
    expect(failures.map((f) => f.split(":")[0])).not.toContain(
      "0015_data_integrity.sql",
    );
    expect(failures.map((f) => f.split(":")[0])).not.toContain(
      "0016_drop_dead_pii.sql",
    );
  });

  it("a migration that fails PART WAY leaves the schema half-applied (no transaction)", () => {
    const { handle, runScript } = rawSqlite();
    for (const f of MIGRATION_FILES.slice(0, 10)) runScript(sqlFor(f));
    // Simulate: 0011 runs its first ALTER, then the run dies before the rest.
    runScript("ALTER TABLE products ADD COLUMN auto_issue_json TEXT");
    let replayError: string | null = null;
    try {
      runScript(sqlFor("0011_auto_issue.sql"));
    } catch (e) {
      replayError = (e as Error).message;
    }
    // The replay dies on statement 1 and NEVER reaches origin/enroll_hwid/the unique index.
    expect(replayError).toMatch(/duplicate column name: auto_issue_json/);
    const cols = handle.prepare("PRAGMA table_info(licenses)").all() as {
      name: string;
    }[];
    expect(cols.map((c) => c.name)).not.toContain("enroll_hwid");
    const idx = handle
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_licenses_enroll_hwid'",
      )
      .all();
    expect(idx).toHaveLength(0); // one-free-licence-per-machine is silently unenforced
  });

  it("migrations are additive only, so migrate-then-deploy ordering is forward-safe", () => {
    // FOUR deliberate exceptions, all create/copy/drop/rename rebuilds — the only shape SQLite
    // offers for changing a constraint in place:
    //   * 0016_drop_dead_pii.sql removes `customers`, `identity` and
    //     `release_download_tokens.customer_id`, none of which any code in src/ reads or writes
    //     (R11-13), so old code running against the new schema is unaffected.
    //   * 0017_portal_fk_cascade.sql rebuilds four portal tables to add `ON DELETE CASCADE`. It
    //     changes NO column and NO name, only the foreign-key clause, so old code reads and
    //     writes them exactly as before — the rebuild is invisible above the schema.
    //   * 0058_b_release_deliverables_kind.sql (F-03) rebuilds `release_deliverables` to widen its
    //     kind CHECK with `package` and add two NULLable columns. It renames and removes nothing an
    //     older Worker reads or writes, so the rebuild is invisible above the schema too; its
    //     child rows are set aside and restored around the drop (the file says why).
    //   * 0099_dist_listing_assets_manifest.sql (HA-07) rebuilds `dist_listing_assets` to widen its
    //     source CHECK with `manifest`. Every column is copied unchanged and nothing is renamed or
    //     removed above the schema; no table holds a foreign key into it.
    const REBUILDS = [
      "0016_drop_dead_pii.sql",
      "0017_portal_fk_cascade.sql",
      "0058_b_release_deliverables_kind.sql",
      "0099_dist_listing_assets_manifest.sql",
    ];
    const sql = MIGRATION_FILES.filter((f) => !REBUILDS.includes(f))
      .map(sqlFor)
      .join("\n")
      // Statements only — the migrations now carry prose explaining *why* a rebuild was
      // rejected, and prose is not DDL.
      .replace(/--[^\n]*/g, "");
    expect(/DROP\s+TABLE/i.test(sql)).toBe(false);
    expect(/DROP\s+COLUMN/i.test(sql)).toBe(false);
    expect(/RENAME/i.test(sql)).toBe(false);
    const notNullAdds = sql
      .split("\n")
      .filter((l) => /ALTER TABLE/i.test(l) && /NOT NULL/i.test(l));
    expect(notNullAdds.length).toBeGreaterThan(0);
    expect(notNullAdds.every((l) => /DEFAULT/i.test(l))).toBe(true);
  });

  it("the harness has no d1_migrations bookkeeping, so replay bugs are invisible to CI", async () => {
    const db = makeTestDb();
    const rows = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%migration%'",
    );
    // U-03's licence-override migration tables are product data (a data migration's state and
    // report), not schema-migration bookkeeping; every other name still counts.
    const dataMigrationTables = new Set([
      "override_migration",
      "override_migration_report",
    ]);
    expect(rows.filter((r) => !dataMigrationTables.has(r.name))).toHaveLength(
      0,
    );
  });
});

// ── R11-09 — SqliteDb vs D1Db divergence / no transaction primitive ──────────
describe("R11-09 test-vs-production DB divergence", () => {
  it("SqliteDb.batch IS a transaction; the Db interface has NO transaction primitive", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await insertLicense(db, lic("acme", "lic-1"));
    await expect(
      db.batch([
        {
          sql: "UPDATE licenses SET name = 'changed' WHERE product='acme' AND id='lic-1'",
          params: [],
        },
        {
          sql: "INSERT INTO licenses (product, id, activated_at, modified_at) VALUES ('acme','lic-1',0,0)",
          params: [],
        },
      ]),
    ).rejects.toThrow();
    const row = await db.first<{ name: string | null }>(
      "SELECT name FROM licenses WHERE product='acme' AND id='lic-1'",
    );
    expect(row?.name).toBeNull(); // rolled back
  });

  it("multi-step flows OUTSIDE batch() are not atomic — resync can strand a product with zero active schemas", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    // resync.ts:186-197 does deactivateSchemas() then insertSchema() as TWO db.run() calls.
    await db.run("UPDATE product_schema SET active = 0 WHERE product = 'acme'");
    const active = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM product_schema WHERE product='acme' AND active = 1",
    );
    expect(active?.n).toBe(0); // no catalog until the next successful resync
  });

  // FIXED (R11-02 part 2): licenseCore gates the seat check on `limit > 0`, so a 0/negative
  // limit meant UNLIMITED devices rather than zero — a sign error, or a fuzzed admin field,
  // silently removed the core commercial control. Both device-limit columns are now guarded at
  // the DB and rejected with 422 by the admin handlers.
  it("a non-positive device limit is now REJECTED on both products and tiers", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await expect(
      db.run(
        "UPDATE products SET default_device_limit = ? WHERE slug='acme'",
        -5,
      ),
    ).rejects.toThrow(/default_device_limit/);
    await expect(
      db.run("UPDATE products SET default_device_limit = 0 WHERE slug='acme'"),
    ).rejects.toThrow(/default_device_limit/);
    await expect(
      db.run(
        "INSERT INTO tiers (product, id, label, policy_device_limit, modified_at) VALUES ('acme','t','T',?,?)",
        -99,
        NOW,
      ),
    ).rejects.toThrow(/policy_device_limit/);

    // NULL still means "inherit the product default", and a real seat count still stores.
    await db.run(
      "INSERT INTO tiers (product, id, label, policy_device_limit, modified_at) VALUES ('acme','t2','T2',NULL,?)",
      NOW,
    );
    await db.run(
      "INSERT INTO tiers (product, id, label, policy_device_limit, modified_at) VALUES ('acme','t3','T3',3,?)",
      NOW,
    );

    // REPORTED, not fixed: default_max_offline_days and licenses.expires_at still take any
    // number — neither is an entitlement gate the way `limit > 0` is.
    await db.run(
      "UPDATE products SET default_max_offline_days = ? WHERE slug='acme'",
      -1,
    );
    await insertLicense(db, lic("acme", "lic-1", { expires_at: -1 }));
    const p = await db.first<{ a: number; b: number }>(
      "SELECT default_max_offline_days AS a, default_device_limit AS b FROM products WHERE slug='acme'",
    );
    expect(p?.a).toBe(-1);
    expect(p!.b > 0).toBe(true);
  });

  it("integers are stored as float64 with no bound — the harness matches D1, so CI cannot catch overflow", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await db.run(
      "UPDATE products SET default_device_limit = ? WHERE slug='acme'",
      Number.MAX_SAFE_INTEGER + 10,
    );
    const row = await db.first<{ v: number; t: string }>(
      "SELECT default_device_limit AS v, typeof(default_device_limit) AS t FROM products WHERE slug='acme'",
    );
    expect(row?.t).toBe("integer");
    // 9007199254740001 was already rounded to 9007199254741000 by JS before binding.
    expect(row?.v).toBe(9007199254741000);
  });

  it("empty batch: SqliteDb accepts it, D1 rejects it (`No SQL statements detected`)", async () => {
    const db = makeTestDb();
    await expect(db.batch([])).resolves.toBeUndefined();
    // Every current caller guards on length, but the abstraction does not — a future
    // `db.batch(items.map(...))` over an empty list passes CI and 500s in production.
  });

  it("DbParam allows ArrayBuffer, which better-sqlite3 CANNOT bind but D1 can", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await expect(
      db.run(
        "UPDATE products SET branding_json = ? WHERE slug='acme'",
        new ArrayBuffer(4),
      ),
    ).rejects.toThrow(/can only bind/i);
    // The reverse trap of the empty-batch case: the type says it is legal, prod accepts it,
    // and any test touching it fails for a reason unrelated to the code under test.
  });

  it("normParam maps undefined -> NULL, so a forgotten field silently NULLs a column", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await insertLicense(db, lic("acme", "lic-1", { email: "a@example.com" }));
    await db.run(
      "UPDATE licenses SET email = ? WHERE product='acme' AND id='lic-1'",
      undefined,
    );
    const row = await db.first<{ email: string | null }>(
      "SELECT email FROM licenses WHERE product='acme' AND id='lic-1'",
    );
    expect(row?.email).toBeNull(); // an accidental `undefined` is a destructive write
  });

  it("SQLite type affinity accepts a TEXT value in an INTEGER column (no strict tables)", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await db.run(
      "UPDATE products SET default_device_limit = ? WHERE slug='acme'",
      "not-a-number",
    );
    const row = await db.first<{ default_device_limit: unknown }>(
      "SELECT default_device_limit FROM products WHERE slug='acme'",
    );
    expect(typeof row?.default_device_limit).toBe("string");
  });

  it("the harness DOES enforce CHECK constraints, so the CHECKs the schema has are tested", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    // portal_accounts.status carries an inline CHECK (0008_portal.sql:12).
    await expect(
      db.run(
        `INSERT INTO portal_accounts (id, status, created_at, modified_at) VALUES ('a9','bogus',?,?)`,
        NOW,
        NOW,
      ),
    ).rejects.toThrow(/CHECK constraint/i);
    // …and the trigger-expressed constraints from 0015 abort exactly the same way.
    await expect(
      db.run("UPDATE products SET status = 'bogus' WHERE slug = 'acme'"),
    ).rejects.toThrow(/products.status/);
  });

  // FIXED (R11-11 part 3): `D1Db.all` returned `r.results ?? []` and never looked at
  // `r.success`, so a D1 statement that reports failure WITHOUT throwing became an empty
  // result set. Through `countActiveDevices`'s `?? 0` that is a seat count of ZERO — the
  // device limit fails OPEN in the exact query that decides whether to grant a seat.
  // `D1Db` now raises `D1QueryError` on any unsuccessful result.
  it("a failed D1 result now THROWS instead of degrading to an empty read", async () => {
    const failing = failingD1(); // every statement reports success:false, no throw
    const db = new D1Db(failing);

    await expect(db.all("SELECT 1")).rejects.toThrow(/D1 query failed/);
    await expect(db.run("UPDATE products SET name = 'x'")).rejects.toThrow(
      /D1 query failed/,
    );
    await expect(
      db.runChanges("UPDATE products SET name = 'x'"),
    ).rejects.toThrow(/D1 query failed/);
    await expect(
      db.batch([{ sql: "UPDATE products SET name = 'x'", params: [] }]),
    ).rejects.toThrow(/D1 query failed/);

    // The security consequence, end to end. `first()` has no result envelope to inspect, so
    // the seat count is made fail-closed at the caller instead: `COUNT(*)` always returns a
    // row, so "no row" now refuses rather than reading as zero devices.
    await expect(countActiveDevices(db, "acme", "lic-1")).rejects.toThrow(
      /seat-count read returned no row/,
    );
  });

  it("a successful D1 result still returns rows, and success:true is not disturbed", async () => {
    const db = new D1Db(okD1([{ n: 3 }]));
    expect(await countActiveDevices(db, "acme", "lic-1")).toBe(3);
    expect(await db.all("SELECT 1")).toEqual([{ n: 3 }]);
    expect(await db.runChanges("UPDATE x SET y = 1")).toBe(1);
    await expect(
      db.batch([{ sql: "UPDATE x SET y = 1", params: [] }]),
    ).resolves.toBeUndefined();
  });
});

/** Minimal D1Database stand-in: `success` and the returned rows are both caller-chosen. */
function stubD1(success: boolean, rows: Record<string, unknown>[]): D1Database {
  const result = {
    success,
    error: success ? undefined : "no such table: devices",
    results: rows,
    meta: { changes: 1 },
  };
  const stmt = {
    bind: () => stmt,
    all: async () => result,
    first: async () => rows[0] ?? null,
    run: async () => result,
  };
  return {
    prepare: () => stmt,
    batch: async (stmts: unknown[]) => stmts.map(() => result),
  } as unknown as D1Database;
}
const failingD1 = () => stubD1(false, []);
const okD1 = (rows: Record<string, unknown>[]) => stubD1(true, rows);

// ── R11-10 — the enroll uniqueness index is the ONE thing done right ─────────
describe("R11-10 control: enroll uniqueness IS enforced by the DB", () => {
  it("two enrolments for the same hwid cannot both mint a licence", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await insertLicense(
      db,
      lic("acme", "e1", { origin: "enroll", enroll_hwid: "HW1" }),
    );
    await expect(
      insertLicense(
        db,
        lic("acme", "e2", { origin: "enroll", enroll_hwid: "HW1" }),
      ),
    ).rejects.toThrow(/UNIQUE constraint/i);
  });

  it("…but only per product: the same machine gets one free licence per product (by design)", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await seedProduct(db, "other");
    await insertLicense(
      db,
      lic("acme", "e1", { origin: "enroll", enroll_hwid: "HW1" }),
    );
    await insertLicense(
      db,
      lic("other", "e1", { origin: "enroll", enroll_hwid: "HW1" }),
    );
    const n = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM licenses WHERE enroll_hwid='HW1'",
    );
    expect(n?.n).toBe(2);
  });
});
