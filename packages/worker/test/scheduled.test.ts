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
import {
  appendAudit,
  claimDeviceSeat,
  insertLicense,
  setServices,
} from "../src/repo.js";
import { CONNECTOR_EVENT_RETENTION_SECONDS } from "../src/services/distribution/connectors/state.js";
import { portalAudit } from "../src/services/identity/portal/repo.js";
import { createHash } from "node:crypto";
import { asR2, R2Mock } from "./r2Mock.js";
import { enableServices } from "./releaseRoutesFixture.js";
import {
  BLOB_LOCK_AGE_SECONDS,
  DEFAULT_GC_GRACE_SECONDS,
  MIN_GC_GRACE_SECONDS,
  blobGcSettings,
} from "../src/core/blobGc.js";

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

  // P5-02 review: the connector poll reaches only live products with Distribution on, so the
  // 30-day retention of raw webhook payloads must not depend on it. Three products: one live with
  // Distribution on, one SOFT-DELETED, one with Distribution OFF — each holds a 31-day-old event
  // and a fresh one, and the sweep prunes exactly the old one from every product.
  it("prunes store-connector webhook events past 30 days for every product, deleted and Distribution-off ones included", async () => {
    const db = makeTestDb();
    const now = NOW + 40 * 86400;
    const old = now - CONNECTOR_EVENT_RETENTION_SECONDS - 86400;
    const fresh = now - 86400;
    for (const slug of ["live", "gone", "off"]) await seedProduct(db, slug);
    await setServices(
      db,
      "live",
      '{"distribution":{"enabled":true}}',
      "manifest",
      NOW,
    );
    await setServices(
      db,
      "off",
      '{"distribution":{"enabled":false}}',
      "manifest",
      NOW,
    );
    await db.run("UPDATE products SET status = 'deleted' WHERE slug = 'gone'");
    for (const slug of ["live", "gone", "off"]) {
      for (const [id, at] of [
        ["e-old", old],
        ["e-fresh", fresh],
      ] as const) {
        await db.run(
          `INSERT INTO dist_connector_events
             (product, connector, event_id, event_type, outcome, payload_json, received_at)
           VALUES (?, 'asc', ?, 'BETA_FEEDBACK_SCREENSHOT_SUBMISSION_CREATED', 'stored', '{}', ?)`,
          slug,
          id,
          at,
        );
      }
    }

    const report = await runScheduledMaintenance(db, now);

    expect(report.failures).toEqual({});
    for (const slug of ["live", "gone", "off"]) {
      expect(report.counts[`connectorEvents:${slug}`]).toBe(1);
      const rows = await db.all<{ event_id: string }>(
        "SELECT event_id FROM dist_connector_events WHERE product = ?",
        slug,
      );
      expect(rows.map((r) => r.event_id)).toEqual(["e-fresh"]);
    }
    // A second tick on the same clock removes nothing (idempotent like every other step).
    const again = await runScheduledMaintenance(db, now);
    expect(again.counts["connectorEvents:gone"]).toBe(0);
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

  // The deploy re-runs the assertion on every deploy, and each successor DELETEs then re-INSERTs
  // its own list — so a deploy that named an OLDER file would overwrite the newest row with a
  // shorter list and silently stop checking the indexes added since (0018 lacks
  // idx_release_metadata_seq). The step must select the newest file, never name one.
  it("the deploy re-runs the newest *_index_assertion.sql, not a pinned older one", () => {
    const deploy = readFileSync(
      join(HERE, "..", "..", "..", ".github", "workflows", "deploy.yml"),
      "utf8",
    );
    expect(deploy).toContain(
      'ASSERTION="$(ls migrations/*_index_assertion.sql | sort | tail -1)"',
    );
    expect(deploy).toMatch(/d1 execute[^\n]*--file "\$ASSERTION"/);
    const pinned = [
      ...deploy.matchAll(/--file\s+\S*?(\d+[a-z_]*_index_assertion\.sql)/g),
    ].map((m) => m[1]);
    expect(pinned).toEqual([]);
    // And the selection the shell makes is the file this suite treats as the contract.
    const newest = readdirSync(join(HERE, "..", "migrations"))
      .filter((f) => f.endsWith("_index_assertion.sql"))
      .sort()
      .at(-1);
    expect(newest).toBe(ASSERTION_FILE);
    expect(ASSERTION_FILE).not.toBe("0018_index_assertion.sql");
  });
});

// ── P4-14: the blob collector ─────────────────────────────────────────────────────────────────

describe("scheduled() blob collector (P4-14)", () => {
  const GRACE = DEFAULT_GC_GRACE_SECONDS;
  /** Objects are created at NOW; this tick is the first past the bucket lock. */
  const PAST_LOCK = NOW + BLOB_LOCK_AGE_SECONDS + 1;

  function hex(seed: string): string {
    return createHash("sha256").update(seed).digest("hex");
  }

  async function seedObject(
    db: Db,
    r2: R2Mock,
    key: string,
    o: { createdAt?: number; kind?: string; size?: number } = {},
  ): Promise<void> {
    const bytes = new TextEncoder().encode(key);
    await db.run(
      `INSERT INTO blob_objects (storage_key, sha256, size, kind, gated, verified_at, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
      key,
      hex(key),
      bytes.length,
      o.kind ?? "blob",
      o.createdAt ?? NOW,
      o.createdAt ?? NOW,
    );
    r2.seed(key, bytes);
  }

  async function gcWorld() {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await enableServices(db, true, "acme");
    const r2 = new R2Mock();
    const env = { BLOBS: asR2(r2) } as Env;
    return { db, r2, env };
  }

  const exists = (db: Db, key: string) =>
    count(
      db,
      "SELECT COUNT(*) AS n FROM blob_objects WHERE storage_key = ?",
      key,
    );

  it("keeps a referenced object, whatever its age", async () => {
    const { db, r2, env } = await gcWorld();
    const key = `blobs/sha256/${hex("kept")}`;
    await seedObject(db, r2, key);
    await db.run(
      `INSERT INTO blob_refs (product, storage_key, ref_kind, ref_id, created_at)
       VALUES ('acme', ?, 'artifact', 'r1/a1', ?)`,
      key,
      NOW,
    );
    for (const at of [PAST_LOCK, PAST_LOCK + GRACE, PAST_LOCK + 10 * GRACE])
      await runScheduledMaintenance(db, at, env);
    expect(await exists(db, key)).toBe(1);
    expect(r2.has(key)).toBe(true);
  });

  it("keeps an unreferenced object inside the grace period, deletes it from R2 and D1 past grace and lock, and a second run deletes nothing", async () => {
    const { db, r2, env } = await gcWorld();
    const key = `blobs/sha256/${hex("orphan")}`;
    await seedObject(db, r2, key);
    const first = await runScheduledMaintenance(db, PAST_LOCK, env);
    expect(first.failures).toEqual({});
    expect(first.counts.blobMark).toBe(1);
    expect(
      await db.first(
        "SELECT unreferenced_since FROM blob_objects WHERE storage_key = ?",
        key,
      ),
    ).toEqual({ unreferenced_since: PAST_LOCK });
    // One second short of the grace period: kept.
    const inside = await runScheduledMaintenance(
      db,
      PAST_LOCK + GRACE - 1,
      env,
    );
    expect(inside.counts.blobSweep).toBe(0);
    expect(r2.has(key)).toBe(true);
    // At the grace period: deleted from R2 and from D1, and logged.
    const past = await runScheduledMaintenance(db, PAST_LOCK + GRACE, env);
    expect(past.failures).toEqual({});
    expect(past.counts.blobSweep).toBe(1);
    expect(r2.has(key)).toBe(false);
    expect(await exists(db, key)).toBe(0);
    expect(
      await db.first(
        "SELECT action, storage_key FROM blob_gc_log WHERE action = 'deleted'",
      ),
    ).toEqual({ action: "deleted", storage_key: key });
    // Idempotent: the same clock again deletes, stamps and drops nothing.
    const again = await runScheduledMaintenance(db, PAST_LOCK + GRACE, env);
    expect(again.counts.blobSweep).toBe(0);
    expect(again.counts.blobMark).toBe(0);
    expect(again.counts["blobRefs:acme"]).toBe(0);
  });

  it("never deletes before the bucket lock's age, however long it was unreferenced", async () => {
    const { db, r2, env } = await gcWorld();
    const key = `blobs/sha256/${hex("young")}`;
    await seedObject(db, r2, key, { createdAt: NOW });
    await runScheduledMaintenance(db, NOW + 1, env);
    const r = await runScheduledMaintenance(db, NOW + 1 + GRACE, env);
    expect(r.counts.blobSweep).toBe(0);
    expect(r2.has(key)).toBe(true);
    expect(GRACE).toBeLessThan(BLOB_LOCK_AGE_SECONDS);
    const later = await runScheduledMaintenance(db, PAST_LOCK, env);
    expect(later.counts.blobSweep).toBe(1);
    expect(r2.has(key)).toBe(false);
  });

  it("a delta whose base is collectable (or collected) goes without waiting for its own grace period", async () => {
    const { db, r2, env } = await gcWorld();
    const base = hex("base");
    const target = hex("target");
    const baseKey = `blobs/sha256/${base}`;
    const deltaKey = `deltas/${base}/${target}.zstd-patch`;
    const delta2 = `deltas/${base}/${hex("other")}.zstd-patch`;
    await seedObject(db, r2, baseKey);
    await seedObject(db, r2, deltaKey, { kind: "delta" });
    await seedObject(db, r2, delta2, { kind: "delta" });
    // Both deltas are referenced until just before the base's grace period ends.
    for (const k of [deltaKey, delta2])
      await db.run(
        `INSERT INTO blob_refs (product, storage_key, ref_kind, ref_id, created_at)
         VALUES ('acme', ?, 'artifact', ?, ?)`,
        k,
        `r1/${k}`,
        NOW,
      );
    await runScheduledMaintenance(db, PAST_LOCK, env);
    // The base is collected at its grace period; one delta is still referenced then.
    await db.run("DELETE FROM blob_refs WHERE storage_key = ?", deltaKey);
    const r = await runScheduledMaintenance(db, PAST_LOCK + GRACE, env);
    expect(r.counts.blobSweep).toBe(1);
    expect(r2.has(baseKey)).toBe(false);
    expect(r2.has(deltaKey)).toBe(true); // stamped this tick, so not yet a candidate
    // The next tick, a day later and far inside the deltas' own grace period: the delta whose
    // base was collected goes; the still-referenced one stays.
    const next = await runScheduledMaintenance(
      db,
      PAST_LOCK + GRACE + 86400,
      env,
    );
    expect(next.counts.blobSweep).toBe(1);
    expect(r2.has(deltaKey)).toBe(false);
    expect(r2.has(delta2)).toBe(true);
  });

  it("an R2 failure releases the claims, logs it and fails the step; the next tick retries", async () => {
    const { db, r2, env } = await gcWorld();
    const key = `blobs/sha256/${hex("stuck")}`;
    await seedObject(db, r2, key);
    await runScheduledMaintenance(db, PAST_LOCK, env);
    const refusing = {
      ...asR2(r2),
      delete: async () => {
        throw new Error("object is locked");
      },
    } as unknown as R2Bucket;
    const r = await runScheduledMaintenance(db, PAST_LOCK + GRACE, {
      BLOBS: refusing,
    } as Env);
    expect(r.failures.blobSweep).toMatch(/object is locked/);
    expect(
      await db.first(
        "SELECT gc_claimed_at FROM blob_objects WHERE storage_key = ?",
        key,
      ),
    ).toEqual({ gc_claimed_at: null });
    expect(
      await count(
        db,
        "SELECT COUNT(*) AS n FROM blob_gc_log WHERE action = 'delete-failed'",
      ),
    ).toBe(1);
    const retry = await runScheduledMaintenance(db, PAST_LOCK + GRACE, env);
    expect(retry.counts.blobSweep).toBe(1);
    expect(r2.has(key)).toBe(false);
  });

  it("the gated/ prefix follows the same rules", async () => {
    const { db, r2, env } = await gcWorld();
    const kept = `gated/blobs/sha256/${hex("gated-kept")}`;
    const gone = `gated/blobs/sha256/${hex("gated-gone")}`;
    await seedObject(db, r2, kept);
    await seedObject(db, r2, gone);
    await db.run(
      `INSERT INTO blob_refs (product, storage_key, ref_kind, ref_id, created_at)
       VALUES ('acme', ?, 'pack-upload', 'acme.pack', ?)`,
      kept,
      NOW,
    );
    await runScheduledMaintenance(db, PAST_LOCK, env);
    await runScheduledMaintenance(db, PAST_LOCK + GRACE, env);
    expect(r2.has(kept)).toBe(true);
    expect(r2.has(gone)).toBe(false);
    expect(await exists(db, gone)).toBe(0);
  });

  it("finishes a claim a dead tick left behind, and releases one that gained a ref", async () => {
    const { db, r2, env } = await gcWorld();
    const orphan = `blobs/sha256/${hex("stale")}`;
    const reffed = `blobs/sha256/${hex("stale-reffed")}`;
    await seedObject(db, r2, orphan);
    await seedObject(db, r2, reffed);
    // Both claimed two hours ago by a tick that died; one has since gained a ref.
    const stale = (PAST_LOCK - 7200) * 1000;
    await db.run(
      "UPDATE blob_objects SET gc_claimed_at = ?, unreferenced_since = ?",
      stale,
      PAST_LOCK - 7200,
    );
    await db.run(
      `INSERT INTO blob_refs (product, storage_key, ref_kind, ref_id, created_at)
       VALUES ('acme', ?, 'artifact', 'r/z', ?)`,
      reffed,
      NOW,
    );
    const r = await runScheduledMaintenance(db, PAST_LOCK, env);
    expect(r.counts.blobSweep).toBe(1);
    expect(r2.has(orphan)).toBe(false);
    expect(await exists(db, orphan)).toBe(0);
    expect(r2.has(reffed)).toBe(true);
    expect(
      await db.first(
        "SELECT gc_claimed_at FROM blob_objects WHERE storage_key = ?",
        reffed,
      ),
    ).toEqual({ gc_claimed_at: null });
  });

  it("is off with BLOB_GC_MODE=off or without the BLOBS binding", async () => {
    const { db, r2 } = await gcWorld();
    const key = `blobs/sha256/${hex("off")}`;
    await seedObject(db, r2, key);
    const off = await runScheduledMaintenance(db, PAST_LOCK, {
      BLOBS: asR2(r2),
      BLOB_GC_MODE: "off",
    } as unknown as Env);
    expect(off.counts.blobMark).toBeUndefined();
    const none = await runScheduledMaintenance(db, PAST_LOCK, {} as Env);
    expect(none.counts.blobMark).toBeUndefined();
    expect(r2.has(key)).toBe(true);
  });

  it("one product's failure does not stop the others or the sweep", async () => {
    const { db, r2, env } = await gcWorld();
    await seedProduct(db, "other");
    await enableServices(db, true, "other");
    const key = `blobs/sha256/${hex("swept")}`;
    await seedObject(db, r2, key);
    await runScheduledMaintenance(db, PAST_LOCK, env);
    const failing: Db = {
      ...db,
      all: async (sql: string, ...params) => {
        if (/ref_kind = 'pack-object'/.test(sql) && params[0] === "acme")
          throw new Error("simulated D1 failure");
        return db.all(sql, ...params);
      },
      first: db.first.bind(db),
      run: db.run.bind(db),
      batch: db.batch.bind(db),
      runChanges: db.runChanges.bind(db),
    };
    const r = await runScheduledMaintenance(failing, PAST_LOCK + GRACE, env);
    expect(r.failures["blobRefs:acme"]).toMatch(/simulated D1 failure/);
    expect(r.counts["blobRefs:other"]).toBe(0);
    expect(r.counts.blobSweep).toBe(1);
    expect(r2.has(key)).toBe(false);
  });

  it("blobGcSettings: the grace period defaults to 30 days and is never under one day", () => {
    expect(blobGcSettings({} as Env)).toEqual({
      enabled: true,
      graceSeconds: DEFAULT_GC_GRACE_SECONDS,
    });
    expect(
      blobGcSettings({ BLOB_GC_GRACE_DAYS: "0.01" } as unknown as Env)
        .graceSeconds,
    ).toBe(MIN_GC_GRACE_SECONDS);
    expect(
      blobGcSettings({ BLOB_GC_GRACE_DAYS: "nope" } as unknown as Env)
        .graceSeconds,
    ).toBe(DEFAULT_GC_GRACE_SECONDS);
  });
});
