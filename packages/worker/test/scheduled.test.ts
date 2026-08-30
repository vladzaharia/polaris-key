// Scheduled maintenance — retention, seat reclamation, and the deploy-time index assertion.
//
// The four properties `src/scheduled.ts` claims responsibility for (product scoping,
// idempotency, fault isolation, and fairness-with-an-honest-stop) each get a test that FAILS if
// the property is lost, rather than a test that merely exercises the happy path.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import {
  AUDIT_RETENTION_SECONDS,
  PRUNE_BATCH_ROWS,
  PRUNE_MAX_BATCHES,
  REQUIRED_INDEXES,
  SWEEP_MAX_PRODUCTS,
  SWEEP_STATE_KEY,
  assertRequiredIndexes,
  handleScheduled,
  missingRequiredIndexes,
  runScheduledMaintenance,
  type SweepState,
} from "../src/scheduled.js";
import { appendAudit, claimDeviceSeat, insertLicense } from "../src/repo.js";
import { portalAudit } from "../src/services/identity/portal/repo.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * The migration-time index assertion, read from the NEWEST migration that carries one.
 *
 * 0018 introduced the mechanism; 0026 re-asserts with `idx_product_keys_one_active_anchor` added.
 * The re-assertion has to be a new file rather than an edit to 0018 because D1 records 0018 as
 * applied and will never re-run it — editing it would assert the new index on fresh databases
 * only, which is everywhere except production.
 */
const ASSERTION_SQL = readFileSync(
  join(HERE, "..", "migrations", "0026_trust_anchor_keys.sql"),
  "utf8",
);
const ORIGINAL_ASSERTION_SQL = readFileSync(
  join(HERE, "..", "migrations", "0018_index_assertion.sql"),
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

/** An env whose only binding that matters here is `HOT`, where the sweep cursor lives. */
function sweepEnv(): { env: Env; kv: KvMock } {
  const kv = new KvMock();
  return { env: makeEnv(kv, []), kv };
}

/** The `SweepState` record `handleScheduled` writes on every tick. */
async function sweepState(kv: KvMock): Promise<SweepState | null> {
  const raw = await kv.get(SWEEP_STATE_KEY);
  return raw ? (JSON.parse(raw) as SweepState) : null;
}

/**
 * A `Db` whose deletes against `table` always come back FULL, so `drain()` spends every one of
 * its `PRUNE_MAX_BATCHES` passes and exits on the budget rather than on a short pass.
 *
 * Cheaper and more exact than seeding `PRUNE_MAX_BATCHES * PRUNE_BATCH_ROWS` real rows: the
 * property under test is which of `drain()`'s two exits was taken, and this pins that exit
 * without making the assertion depend on how fast SQLite inserts ten thousand rows.
 */
function bottomlessTable(db: Db, table: string): Db {
  return {
    ...db,
    all: db.all.bind(db),
    first: db.first.bind(db),
    run: db.run.bind(db),
    batch: db.batch.bind(db),
    runChanges: async (sql: string, ...params) => {
      if (sql.includes(`DELETE FROM ${table}`)) return PRUNE_BATCH_ROWS;
      return db.runChanges(sql, ...params);
    },
  };
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

  // B5-08 / BLUE-01. This step was the only one not wrapped in `drain()`, so it removed at most
  // PRUNE_BATCH_ROWS per NIGHT. A product minting download tokens faster than that accumulated
  // them for ever while the report showed a healthy-looking count every single night — the
  // retention promise quietly false, and nothing anywhere saying so.
  it("REFUTED: a download-token backlog outlives the sweep at one batch per night", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await seedRelease(db, "acme");
    const total = PRUNE_BATCH_ROWS + 7;
    for (let i = 0; i < total; i++) {
      await seedToken(db, "acme", `EXPIRED-${i}`, { expiresAt: NOW - 1 });
    }
    // One live token, to prove the drain loop still stops at the cutoff rather than at the end
    // of the table once it is allowed to run more than once.
    await seedToken(db, "acme", "LIVE", { expiresAt: NOW + 300 });

    const report = await runScheduledMaintenance(db, NOW);

    expect(report.counts["downloadTokens:acme"]).toBe(total);
    expect(report.truncated["downloadTokens:acme"]).toBeUndefined();
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
    const { env } = sweepEnv();

    await expect(handleScheduled(env, db)).rejects.toThrow(
      /idx_devices_seat.*idx_licenses_enroll_hwid|idx_licenses_enroll_hwid.*idx_devices_seat/s,
    );
  });

  it("handleScheduled resolves with the report when every step succeeds", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await seedAudit(db, "acme", "old", 1);
    const { env } = sweepEnv();

    const report = await handleScheduled(env, db);

    expect(report.failures).toEqual({});
    expect(report.counts["audit:acme"]).toBe(1);
    expect(report.complete).toBe(true);
  });

  // The cursor is the whole of B5-10's fix, so a cursor that silently fails to persist is the
  // defect back again — every run would restart at the top of the slug list and the tail would
  // starve for ever, with a green cron dashboard the entire time.
  it("REFUTED: a cursor that cannot be persisted fails silently", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    const { env } = sweepEnv();
    const broken = {
      ...env,
      HOT: {
        get: async () => null,
        put: async () => {
          throw new Error("KV is having a day");
        },
      },
    } as unknown as Env;

    await expect(handleScheduled(broken, db)).rejects.toThrow(
      /sweepState: write: KV is having a day/,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────
// B5-10 — the sweep is FAIR. Every product gets its retention pass within a bounded number of
// nights, whatever the list length and wherever the budget runs out.
// ───────────────────────────────────────────────────────────────────────────────────────────

describe("scheduled() resume cursor", () => {
  const FIVE = ["p1", "p2", "p3", "p4", "p5"];

  /** Five products, each holding exactly one prunable audit row. */
  async function seedFive(): Promise<Db> {
    const db = makeTestDb();
    for (const slug of FIVE) {
      await seedProduct(db, slug);
      await seedAudit(db, slug, `${slug}-old`, NOW);
    }
    return db;
  }

  it("REFUTED: an over-budget run sweeps the same head every night and starves the tail", async () => {
    const db = await seedFive();

    // Run 1 does the front of the list and NAMES the rest rather than pretending it finished.
    const first = await runScheduledMaintenance(db, LATER, { maxProducts: 2 });
    expect(
      Object.keys(first.counts).filter((k) => k.startsWith("audit:")),
    ).toEqual(["audit:p1", "audit:p2"]);
    expect(first.deferred).toEqual(["p3", "p4", "p5"]);
    expect(first.cursor).toBe("p2");
    expect(first.complete).toBe(false);
    // The tail is still there — this is exactly the state the old sweep stayed in for ever.
    expect(await count(db, "SELECT COUNT(*) AS n FROM audit")).toBe(3);

    // …but the next runs resume where the previous one stopped, so the tail is reached.
    const second = await runScheduledMaintenance(db, LATER, {
      cursor: first.cursor,
      maxProducts: 2,
    });
    expect(
      Object.keys(second.counts).filter((k) => k.startsWith("audit:")),
    ).toEqual(["audit:p3", "audit:p4"]);
    const third = await runScheduledMaintenance(db, LATER, {
      cursor: second.cursor,
      maxProducts: 2,
    });
    expect(
      Object.keys(third.counts).filter((k) => k.startsWith("audit:")),
    ).toContain("audit:p5");

    // Three runs at two products a run: every one of the five has had its retention pass.
    expect(await count(db, "SELECT COUNT(*) AS n FROM audit")).toBe(0);
  });

  it("wraps past the end of the list, so no product waits longer than one cycle", async () => {
    // Coverage is the property, not any particular grouping: at two products a night, every one
    // of the five must have had a pass by the third night, which means the third night's run has
    // to wrap off the end of the list back onto `p1` rather than stopping there.
    const db = await seedFive();
    let cursor: string | null = null;
    const seen: string[][] = [];
    for (let i = 0; i < 3; i++) {
      const report = await runScheduledMaintenance(db, LATER, {
        cursor,
        maxProducts: 2,
      });
      seen.push(
        Object.keys(report.counts)
          .filter((k) => k.startsWith("seats:"))
          .map((k) => k.slice("seats:".length)),
      );
      cursor = report.cursor;
    }
    expect(seen).toEqual([
      ["p1", "p2"],
      ["p3", "p4"],
      ["p5", "p1"],
    ]);
    expect([...new Set(seen.flat())].sort()).toEqual(FIVE);
  });

  it("resumes past a cursor naming a product that no longer exists", async () => {
    // The cursor is a slug, not an index, and `listAllProductSlugs` is ordered — so the resume
    // point is "the first slug greater than the cursor", which survives the product being
    // deleted between two nights. An index would have silently shifted the whole rotation by
    // one, and the product that moved into the vacated position would never be swept again.
    const db = makeTestDb();
    for (const slug of FIVE.filter((s) => s !== "p2")) {
      await seedProduct(db, slug);
      await seedAudit(db, slug, `${slug}-old`, NOW);
    }

    const report = await runScheduledMaintenance(db, LATER, {
      cursor: "p2",
      maxProducts: 2,
    });

    expect(
      Object.keys(report.counts).filter((k) => k.startsWith("audit:")),
    ).toEqual(["audit:p3", "audit:p4"]);
  });

  it("a cursor past the end of the list wraps rather than skipping a whole cycle", async () => {
    const db = await seedFive();

    const report = await runScheduledMaintenance(db, LATER, {
      cursor: "zzzz",
      maxProducts: 2,
    });

    expect(report.deferred).toEqual(["p3", "p4", "p5"]);
    expect(report.counts["audit:p1"]).toBe(1);
  });

  it("carries the cursor across ticks through KV, without a global", async () => {
    const db = await seedFive();
    const { env, kv } = sweepEnv();

    const first = await handleScheduled(env, db, { maxProducts: 2 });
    expect(first.cursor).toBe("p2");
    expect((await sweepState(kv))?.cursor).toBe("p2");

    // A second tick reads the record the first one wrote — nothing is threaded by the caller.
    const second = await handleScheduled(env, db, { maxProducts: 2 });
    expect(Object.keys(second.counts)).toContain("audit:p3");
    expect((await sweepState(kv))?.cursor).toBe("p4");
  });

  it("sweeps every product in one tick when the list fits the budget", async () => {
    const db = await seedFive();
    expect(FIVE.length).toBeLessThan(SWEEP_MAX_PRODUCTS);

    const report = await runScheduledMaintenance(db, LATER);

    expect(report.deferred).toEqual([]);
    expect(report.cursor).toBeNull();
    expect(report.complete).toBe(true);
    expect(await count(db, "SELECT COUNT(*) AS n FROM audit")).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────
// Observability — "stopped on the budget with work left" and "had nothing to do" are different
// outcomes and must not produce the same report.
// ───────────────────────────────────────────────────────────────────────────────────────────

describe("scheduled() truncation is reported, not inferred", () => {
  it("REFUTED: a run that stops on its batch budget looks exactly like a clean one", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    const budgeted = bottomlessTable(db, "audit");

    const report = await runScheduledMaintenance(budgeted, LATER);

    // The count alone cannot tell the two apart — that is the entire defect — so the stop
    // REASON is its own field, and it names the step.
    expect(report.counts["audit:acme"]).toBe(
      PRUNE_MAX_BATCHES * PRUNE_BATCH_ROWS,
    );
    expect(report.truncated["audit:acme"]).toBe(
      PRUNE_MAX_BATCHES * PRUNE_BATCH_ROWS,
    );
    expect(report.complete).toBe(false);
    // …while a step that finished is absent from `truncated` in the very same report.
    expect(report.counts["portalAudit:acme"]).toBe(0);
    expect(report.truncated["portalAudit:acme"]).toBeUndefined();
  });

  it("a sweep with nothing to do reports complete, with nothing truncated or deferred", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");

    const report = await runScheduledMaintenance(db, LATER);

    expect(report.truncated).toEqual({});
    expect(report.deferred).toEqual([]);
    expect(report.complete).toBe(true);
  });

  it("persists the outcome of EVERY tick, including the green ones, where an operator can read it", async () => {
    // `index.ts`'s `scheduled()` throws the report away and this file may not log (R12), so the
    // KV record is the only place a production truncation is visible at all.
    const db = makeTestDb();
    await seedProduct(db, "acme");
    const { env, kv } = sweepEnv();

    await handleScheduled(env, bottomlessTable(db, "audit"));

    const state = await sweepState(kv);
    expect(state).toMatchObject({
      complete: false,
      truncated: ["audit:acme"],
      deferred: [],
      failed: [],
    });
  });

  it("names what it left behind in the thrown aggregate, alongside the failures", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await seedProduct(db, "other");
    await db.run("DROP INDEX idx_devices_seat");
    const { env } = sweepEnv();

    await expect(
      handleScheduled(env, bottomlessTable(db, "audit"), { maxProducts: 1 }),
    ).rejects.toThrow(
      /idx_devices_seat[\s\S]*stopped on the batch budget[\s\S]*audit:acme[\s\S]*1 product\(s\) not reached this run \(other\)/,
    );
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

  // R11-04: the migration-time half of the same check. `makeTestDb()` applies 0018, so the
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
  // way they stay true is if nothing can change one without the other. The migration side is now
  // 0026's re-assertion (0018's is the historical original, checked below to be a strict subset —
  // the assertion may only ever GROW, because every name in it is a security invariant).
  it("REQUIRED_INDEXES and 0018_index_assertion.sql name the same set", () => {
    // Statements only — the file's header carries a worked example of the same VALUES list.
    const namesIn = (sql: string): string[] =>
      [...sql.replace(/--[^\n]*/g, "").matchAll(/\('(idx_[a-z0-9_]+)'\)/g)]
        .map((m) => m[1])
        .filter((name): name is string => name !== undefined);
    const inSql = namesIn(ASSERTION_SQL);
    expect(inSql.length).toBeGreaterThan(0);
    expect([...inSql].sort()).toEqual([...REQUIRED_INDEXES].sort());

    const original = namesIn(ORIGINAL_ASSERTION_SQL);
    expect(original.length).toBeGreaterThan(0);
    expect(original.every((name) => inSql.includes(name))).toBe(true);
  });
});
