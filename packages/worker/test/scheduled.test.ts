// Scheduled maintenance — retention, seat reclamation, and the deploy-time index assertion.
//
// The three properties `src/scheduled.ts` claims responsibility for (product scoping,
// idempotency, fault isolation) each get a test that FAILS if the property is lost, rather than
// a test that merely exercises the happy path.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTestDb } from "./helpers.js";
import { NOW, seedProduct } from "./seed.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import {
  AUDIT_RETENTION_SECONDS,
  PRUNE_BATCH_ROWS,
  REQUIRED_INDEXES,
  assertRequiredIndexes,
  handleScheduled,
  missingRequiredIndexes,
  runScheduledMaintenance,
} from "../src/scheduled.js";
import { appendAudit, claimDeviceSeat, insertLicense } from "../src/repo.js";
import { portalAudit } from "../src/services/identity/portal/repo.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// The NEWEST index assertion is the live one: each successor (0018, then 0027_i) re-runs the
// DELETE-then-INSERT with the full list, so an older file's list is history, not the contract.
const ASSERTION_FILE = readdirSync(join(HERE, "..", "migrations"))
  .filter((f) => f.endsWith("_index_assertion.sql"))
  .sort()
  .at(-1)!;
const ASSERTION_SQL = readFileSync(
  join(HERE, "..", "migrations", ASSERTION_FILE),
  "utf8",
);

/** Well past the retention window — everything stamped at `NOW` is now prunable. */
const LATER = NOW + AUDIT_RETENTION_SECONDS + 86400;

async function seedAudit(
  db: Db,
  product: string,
  id: string,
  at: number,
): Promise<void> {
  await appendAudit(db, {
    product,
    id,
    at,
    actor_sub: null,
    actor_name: "Ada Lovelace",
    actor_email: "ada@example.com",
    action: "license.update",
    target_kind: "license",
    target_id: "lic-1",
    parent_id: null,
    summary: null,
  });
}

async function seedRelease(db: Db, product: string): Promise<void> {
  await db.run(
    `INSERT INTO release_metadata (product, release_id, version, created_at, modified_at)
     VALUES (?, 'r1', '1.0.0', ?, ?)`,
    product,
    NOW,
    NOW,
  );
}

async function seedToken(
  db: Db,
  product: string,
  hash: string,
  opts: { expiresAt: number; usedAt?: number | null },
): Promise<void> {
  await db.run(
    `INSERT INTO release_download_tokens
       (product, token_hash, release_id, artifact_id, device_id, scope_json,
        expires_at, used_at, created_at)
     VALUES (?, ?, 'r1', NULL, NULL, NULL, ?, ?, ?)`,
    product,
    hash,
    opts.expiresAt,
    opts.usedAt ?? null,
    NOW,
  );
}

async function count(
  db: Db,
  sql: string,
  ...params: string[]
): Promise<number> {
  const row = await db.first<{ n: number }>(sql, ...params);
  return row?.n ?? -1;
}

describe("scheduled() retention", () => {
  it("prunes audit and portal_audit past the retention window and keeps everything inside it", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await seedAudit(db, "acme", "old", NOW);
    await seedAudit(db, "acme", "fresh", LATER - 60);
    await portalAudit(db, {
      accountId: "acct_1",
      action: "portal.license.claim",
      product: "acme",
      now: NOW,
    });
    await portalAudit(db, {
      accountId: "acct_1",
      action: "portal.license.claim",
      product: "acme",
      now: LATER - 60,
    });

    const report = await runScheduledMaintenance(db, LATER);

    expect(report.failures).toEqual({});
    expect(report.counts["audit:acme"]).toBe(1);
    expect(report.counts["portalAudit:acme"]).toBe(1);
    const remaining = await db.all<{ id: string }>("SELECT id FROM audit");
    expect(remaining.map((r) => r.id)).toEqual(["fresh"]);
    expect(await count(db, "SELECT COUNT(*) AS n FROM portal_audit")).toBe(1);
  });

  it("180 days is the boundary: a row one second younger than the cutoff survives", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    const cutoff = LATER - AUDIT_RETENTION_SECONDS;
    await seedAudit(db, "acme", "just-inside", cutoff);
    await seedAudit(db, "acme", "just-outside", cutoff - 1);

    await runScheduledMaintenance(db, LATER);

    const remaining = await db.all<{ id: string }>("SELECT id FROM audit");
    expect(remaining.map((r) => r.id)).toEqual(["just-inside"]);
  });

  it("is PRODUCT-SCOPED: pruning one tenant's backlog cannot reach another tenant's rows", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await seedProduct(db, "other");
    await seedAudit(db, "acme", "a-old", NOW);
    await seedAudit(db, "other", "o-old", NOW);
    await seedAudit(db, "other", "o-fresh", LATER - 60);

    // Only `acme` exists as far as this sweep is concerned…
    const report = await runScheduledMaintenance(db, LATER);
    expect(report.counts["audit:acme"]).toBe(1);
    expect(report.counts["audit:other"]).toBe(1);

    // …and every surviving row still belongs to the tenant that wrote it.
    const rows = await db.all<{ product: string; id: string }>(
      "SELECT product, id FROM audit ORDER BY id",
    );
    expect(rows).toEqual([{ product: "other", id: "o-fresh" }]);
  });

  it("prunes the platform-level portal_audit rows that name no product", async () => {
    const db = makeTestDb();
    await portalAudit(db, { action: "portal.magic.start", now: NOW });
    await portalAudit(db, { action: "portal.magic.start", now: LATER - 60 });

    const report = await runScheduledMaintenance(db, LATER);

    // No products exist at all, so ONLY the null pass can have removed this row.
    expect(report.counts["portalAudit:_platform"]).toBe(1);
    expect(await count(db, "SELECT COUNT(*) AS n FROM portal_audit")).toBe(1);
  });

  it("is IDEMPOTENT: a duplicate cron delivery on the same clock removes nothing", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await seedAudit(db, "acme", "old", NOW);
    await seedRelease(db, "acme");
    await seedToken(db, "acme", "EXPIRED", { expiresAt: NOW + 300 });

    const first = await runScheduledMaintenance(db, LATER);
    const second = await runScheduledMaintenance(db, LATER);

    expect(first.counts["audit:acme"]).toBe(1);
    expect(first.counts["downloadTokens:acme"]).toBe(1);
    expect(second.failures).toEqual({});
    for (const [step, n] of Object.entries(second.counts)) {
      expect(`${step}=${n}`).toBe(`${step}=0`);
    }
  });

  it("drains a backlog larger than one batch in a single invocation", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    const total = PRUNE_BATCH_ROWS + 7;
    for (let i = 0; i < total; i++) {
      await seedAudit(db, "acme", `old-${i}`, NOW);
    }

    const report = await runScheduledMaintenance(db, LATER);

    expect(report.counts["audit:acme"]).toBe(total);
    expect(await count(db, "SELECT COUNT(*) AS n FROM audit")).toBe(0);
  });

  it("includes SOFT-DELETED products, whose rows are the ones most in need of pruning", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await seedAudit(db, "acme", "old", NOW);
    await db.run("UPDATE products SET status = 'deleted' WHERE slug = 'acme'");

    const report = await runScheduledMaintenance(db, LATER);

    expect(report.counts["audit:acme"]).toBe(1);
    expect(await count(db, "SELECT COUNT(*) AS n FROM audit")).toBe(0);
  });
});

describe("scheduled() download-token purge", () => {
  it("removes expired AND spent tokens, and leaves a live unspent one alone", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await seedRelease(db, "acme");
    await seedToken(db, "acme", "EXPIRED", { expiresAt: NOW - 1 });
    await seedToken(db, "acme", "SPENT", {
      expiresAt: NOW + 300,
      usedAt: NOW + 1,
    });
    await seedToken(db, "acme", "LIVE", { expiresAt: NOW + 300 });

    const report = await runScheduledMaintenance(db, NOW);

    expect(report.counts["downloadTokens:acme"]).toBe(2);
    const rows = await db.all<{ token_hash: string }>(
      "SELECT token_hash FROM release_download_tokens",
    );
    expect(rows.map((r) => r.token_hash)).toEqual(["LIVE"]);
  });

  it("cannot reach another product's tokens", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await seedProduct(db, "other");
    await seedRelease(db, "acme");
    await seedRelease(db, "other");
    await seedToken(db, "acme", "ACME-EXPIRED", { expiresAt: NOW - 1 });
    await seedToken(db, "other", "OTHER-LIVE", { expiresAt: NOW + 300 });

    const report = await runScheduledMaintenance(db, NOW);

    expect(report.counts["downloadTokens:acme"]).toBe(1);
    expect(report.counts["downloadTokens:other"]).toBe(0);
    const rows = await db.all<{ token_hash: string }>(
      "SELECT token_hash FROM release_download_tokens",
    );
    expect(rows.map((r) => r.token_hash)).toEqual(["OTHER-LIVE"]);
  });
});

describe("scheduled() dormant-seat reclamation", () => {
  // The just-in-time reclamation inside `claimDeviceSeat` only frees capacity for whoever is
  // ALREADY activating. Without the sweep, a licence whose devices all went dark reads as full
  // in the portal and the admin console until somebody tries to activate a new one.
  it("frees the seats of devices that stopped checking in, without touching the rows", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await insertLicense(db, {
      product: "acme",
      id: "lic-1",
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
    });
    expect(await claimDeviceSeat(db, "acme", "lic-1", "d1", 2, NOW)).toBe(true);
    expect(await claimDeviceSeat(db, "acme", "lic-1", "d2", 2, NOW)).toBe(true);

    const report = await runScheduledMaintenance(db, LATER);

    expect(report.counts["seats:acme"]).toBe(2);
    const rows = await db.all<{ seat_no: number | null; status: string }>(
      "SELECT seat_no, status FROM devices WHERE product = 'acme' ORDER BY device_id",
    );
    expect(rows.map((r) => r.seat_no)).toEqual([null, null]);
    // Capacity comes back; the device rows, their status and their token hashes do not change.
    expect(rows.map((r) => r.status)).toEqual(["authorized", "authorized"]);
    // And the freed ordinals are immediately claimable again.
    expect(await claimDeviceSeat(db, "acme", "lic-1", "d3", 2, LATER)).toBe(
      true,
    );
  });

  it("leaves a device that is still checking in exactly where it was", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await insertLicense(db, {
      product: "acme",
      id: "lic-1",
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
    });
    expect(await claimDeviceSeat(db, "acme", "lic-1", "d1", 2, NOW)).toBe(true);

    const report = await runScheduledMaintenance(db, NOW + 60);

    expect(report.counts["seats:acme"]).toBe(0);
    const row = await db.first<{ seat_no: number | null }>(
      "SELECT seat_no FROM devices WHERE product = 'acme' AND device_id = 'd1'",
    );
    expect(row?.seat_no).toBe(1);
  });
});

describe("scheduled() fault isolation", () => {
  // The whole point of `step()`. A poisoned first product must not cost every later product its
  // retention pass — that is how a table stops being pruned and nobody finds out.
  it("one failing step does not abort the rest, and every failure is reported", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await seedProduct(db, "other");
    await seedAudit(db, "acme", "a-old", NOW);
    await seedAudit(db, "other", "o-old", NOW);

    // Fail exactly one statement: the `audit` prune for the alphabetically-first product.
    const failing: Db = {
      ...db,
      all: db.all.bind(db),
      first: db.first.bind(db),
      run: db.run.bind(db),
      batch: db.batch.bind(db),
      runChanges: async (sql: string, ...params) => {
        if (/DELETE FROM audit/.test(sql) && params[0] === "acme") {
          throw new Error("simulated D1 failure");
        }
        return db.runChanges(sql, ...params);
      },
    };

    const report = await runScheduledMaintenance(failing, LATER);

    expect(report.failures["audit:acme"]).toMatch(/simulated D1 failure/);
    // Every LATER step still ran…
    expect(report.counts["audit:other"]).toBe(1);
    expect(report.counts["portalAudit:acme"]).toBe(0);
    expect(report.counts["seats:other"]).toBe(0);
    // …and the row the failing step should have removed is still there, not silently lost.
    expect(await count(db, "SELECT COUNT(*) AS n FROM audit")).toBe(1);
  });

  // A cron whose failures resolve green is a cron nobody maintains. The handler must surface a
  // failed step as a failed INVOCATION, and the message is the only diagnostic it emits.
  it("handleScheduled rethrows one aggregate naming every failed step", async () => {
    const db = makeTestDb();
    await db.run("DROP INDEX idx_devices_seat");
    await db.run("DROP INDEX idx_licenses_enroll_hwid");
    const env = {} as Env;

    await expect(handleScheduled(env, db)).rejects.toThrow(
      /idx_devices_seat.*idx_licenses_enroll_hwid|idx_licenses_enroll_hwid.*idx_devices_seat/s,
    );
  });

  it("handleScheduled resolves with the report when every step succeeds", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await seedAudit(db, "acme", "old", 1);

    const report = await handleScheduled({} as Env, db);

    expect(report.failures).toEqual({});
    expect(report.counts["audit:acme"]).toBe(1);
  });
});

describe("required-index assertion", () => {
  it("passes against a fully-migrated database", async () => {
    const db = makeTestDb();
    expect(await missingRequiredIndexes(db)).toEqual([]);
    await expect(assertRequiredIndexes(db)).resolves.toBeUndefined();
  });

  it("fails loudly, naming the absentee, when a security index is missing", async () => {
    const db = makeTestDb();
    await db.run("DROP INDEX idx_product_keys_one_active");
    expect(await missingRequiredIndexes(db)).toEqual([
      "idx_product_keys_one_active",
    ]);
    await expect(assertRequiredIndexes(db)).rejects.toThrow(
      /idx_product_keys_one_active/,
    );
  });

  // R11-04: the migration-time half of the same check. `makeTestDb()` applies 0018 and 0027_i, so the
  // suite passing at all is a standing proof that the assertion does not false-positive.
  it("the migration records the assertion it made", async () => {
    const db = makeTestDb();
    const row = await db.first<{
      expected: number;
      found: number;
      missing: string;
    }>("SELECT expected, found, missing FROM schema_index_assertion");
    expect(row?.expected).toBe(REQUIRED_INDEXES.length);
    expect(row?.found).toBe(REQUIRED_INDEXES.length);
    expect(row?.missing).toBe("");
  });

  // The runtime list and the migration list are the same claim in two languages, so the only
  // way they stay true is if nothing can change one without the other.
  it("REQUIRED_INDEXES and the newest *_index_assertion.sql name the same set", () => {
    // Statements only — the file's header carries a worked example of the same VALUES list.
    const statements = ASSERTION_SQL.replace(/--[^\n]*/g, "");
    const inSql = [...statements.matchAll(/\('(idx_[a-z0-9_]+)'\)/g)].map(
      (m) => m[1],
    );
    expect(inSql.length).toBeGreaterThan(0);
    expect([...inSql].sort()).toEqual([...REQUIRED_INDEXES].sort());
  });
});
