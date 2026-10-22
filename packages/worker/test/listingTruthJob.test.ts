/**
 * A-27.6 and A-27.7: `distribution.listing-truth`. The dry run reads and writes nothing (the runner
 * stores the report). Apply writes the ledger and then the ingest's guarded statements, one batch
 * per product; down puts back only the fields that still hold what the apply wrote.
 */
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db/types.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import type { MigrationContext } from "../src/core/migrate/job.js";
import { apply, down, dryRun, getRun } from "../src/core/migrate/runner.js";
import {
  listingTruthJob,
  type ListingTruthDetail,
} from "../src/services/distribution/listingTruthJob.js";
import { migrationJobs } from "../src/core/contributions.js";
import {
  stmtUpsertListing,
  stmtUpsertLocale,
} from "../src/services/distribution/listing/store.js";
import { getListing } from "../src/services/distribution/outlets.js";
import { resolvedListing } from "../src/services/distribution/listing/resolved.js";
import type { MigrationJob } from "../src/core/migrate/job.js";
import "../src/mount.js";

const ACTOR = { sub: "op", name: "Op", email: null };
const ICON = "https://raw.githubusercontent.com/acme/dice/main/icon.png";

const ctxOf = (db: Db, at = NOW): MigrationContext => ({
  env: makeEnv(new KvMock(), []),
  db,
  now: at,
});

async function blob(db: Db, product: string, listing: unknown): Promise<void> {
  await seedProduct(db, product);
  await db.run(
    "INSERT INTO dist_listing (product, listing_json, modified_at) VALUES (?, ?, ?)",
    product,
    JSON.stringify(listing),
    NOW,
  );
}

async function plan(db: Db, product: string): Promise<ListingTruthDetail> {
  const p = await listingTruthJob.plan(ctxOf(db), product);
  return (p.detail ?? {}) as ListingTruthDetail;
}

describe("distribution.listing-truth (A-27.6)", () => {
  it("is contributed by Distribution and its units are the products with a blob", async () => {
    expect(migrationJobs().map((j) => j.id)).toContain(
      "distribution.listing-truth",
    );
    const db = await makeTestDb();
    await blob(db, "alpha", { name: "Alpha" });
    await blob(db, "beta", { name: "Beta" });
    await seedProduct(db, "gamma"); // no blob: not a unit
    expect(await listingTruthJob.units(ctxOf(db))).toEqual(["alpha", "beta"]);
  });

  it("a product with no model: every blob field is missing, nothing is equal", async () => {
    const db = await makeTestDb();
    await blob(db, "dice", {
      name: "Dice",
      subtitle: "Roll",
      developerName: "Acme",
      website: "https://acme.example",
    });
    const p = await listingTruthJob.plan(ctxOf(db), "dice");
    const d = p.detail as ListingTruthDetail;
    expect(d).toMatchObject({
      equal: 0,
      typedDiffers: 0,
      missing: 4,
      refused: 0,
      clears: 0,
    });
    expect(d.missingFields.sort()).toEqual([
      "developerName",
      "locales.en-US.subtitle",
      "name",
      "urls.website",
    ]);
    expect(p.changes).toBe(4);
  });

  it("a model that already holds the blob's values is equal and has no changes", async () => {
    const db = await makeTestDb();
    await blob(db, "dice", { name: "Dice", subtitle: "Roll" });
    await db.batch([
      stmtUpsertListing(
        "dice",
        { name: "Dice" },
        undefined,
        "import",
        "op",
        NOW,
        "en-US",
        { name: "manifest" },
      ),
      stmtUpsertLocale(
        "dice",
        "en-US",
        { subtitle: "Roll" },
        "import",
        "op",
        NOW,
        { subtitle: "manifest" },
      ),
    ]);
    const p = await listingTruthJob.plan(ctxOf(db), "dice");
    expect(p.changes).toBe(0);
    expect(p.detail).toMatchObject({
      equal: 2,
      typedDiffers: 0,
      missing: 0,
      refused: 0,
    });
  });

  it("an operator-typed value that differs is kept and counted as typedDiffers", async () => {
    const db = await makeTestDb();
    await blob(db, "dice", { name: "Dice (blob)" });
    await db.batch([
      stmtUpsertListing(
        "dice",
        { name: "Dice Deluxe" },
        undefined,
        "admin",
        "op",
        NOW,
        "en-US",
      ),
    ]);
    const p = await listingTruthJob.plan(ctxOf(db), "dice");
    expect(p.changes).toBe(0);
    expect(p.detail).toMatchObject({ typedDiffers: 1, missing: 0, equal: 0 });
  });

  it("a blob value over the model's limit is refused with its limit, never cut", async () => {
    const db = await makeTestDb();
    await blob(db, "dice", { name: "N".repeat(31), subtitle: "ok" });
    const p = await listingTruthJob.plan(ctxOf(db), "dice");
    const d = p.detail as ListingTruthDetail;
    expect(d.refused).toBe(1);
    expect(d.refusedFields).toEqual([{ field: "name", limit: 30 }]);
    expect(d.missingFields).toEqual(["locales.en-US.subtitle"]);
    expect(JSON.stringify(d)).not.toContain("NNNN");
  });

  it("a manifest-owned model field the blob dropped is a clear", async () => {
    const db = await makeTestDb();
    await blob(db, "dice", { subtitle: "Roll" });
    await db.batch([
      stmtUpsertListing(
        "dice",
        { name: "Old" },
        undefined,
        "import",
        "op",
        NOW,
        "en-US",
        { name: "manifest" },
      ),
    ]);
    const p = await listingTruthJob.plan(ctxOf(db), "dice");
    expect(p.detail).toMatchObject({ clears: 1, missing: 1 });
    expect(p.changes).toBe(2);
  });

  it("art URLs without a hosted_assets url source are counted; a url row clears them", async () => {
    const db = await makeTestDb();
    await blob(db, "dice", {
      icon: { kind: "url", src: ICON },
      header: { kind: "repo", src: "art/h.png" },
      screenshots: [{ kind: "url", src: ICON }],
    });
    expect(await plan(db, "dice")).toMatchObject({
      artWithoutSource: 2,
      artSlots: ["listing.icon", "listing.screenshot:1"],
    });
    await db.run(
      `INSERT INTO hosted_assets (product, slot, locale, origin, source_kind, source_ref, status, modified_at)
       VALUES ('dice', 'listing.icon', '', 'manifest', 'url', ?, 'pending', ?)`,
      ICON,
      NOW,
    );
    expect((await plan(db, "dice")).artSlots).toEqual(["listing.screenshot:1"]);
  });

  it("the runner's dry run writes only its report", async () => {
    const db = await makeTestDb();
    await blob(db, "dice", { name: "Dice" });
    const tables = [
      "dist_listing",
      "dist_listings",
      "dist_listing_locales",
      "hosted_assets",
      "dist_listing_truth_moves",
    ];
    const count = async () =>
      Promise.all(
        tables.map((t) =>
          db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`),
        ),
      );
    const before = await count();
    const run = await dryRun(ctxOf(db), listingTruthJob, ACTOR);
    expect(run.changes).toBe(1);
    expect(await count()).toEqual(before);
    expect((await getRun(db, run.id))?.status).toBe("reported");
  });

  it("the ledger table exists with its primary key", async () => {
    const db = await makeTestDb();
    await seedProduct(db, "dice");
    const ins = (field: string) =>
      db.run(
        `INSERT INTO dist_listing_truth_moves (product, locale, field, had_row, moved_at)
         VALUES ('dice', '', ?, 0, ?)`,
        field,
        NOW,
      );
    await ins("name");
    await expect(ins("name")).rejects.toThrow();
    await ins("urls.website");
  });
});

// ── A-27.7: apply and down ──────────────────────────────────────────────────────────────────────

/** The model's rows without the columns an apply stamps (modified_at / modified_by). */
async function modelRows(db: Db, product: string) {
  const strip = (rows: Record<string, unknown>[]) =>
    rows.map(({ modified_at, modified_by, ...rest }) => rest);
  return {
    app: strip(
      await db.all("SELECT * FROM dist_listings WHERE product = ?", product),
    ),
    locales: strip(
      await db.all(
        "SELECT * FROM dist_listing_locales WHERE product = ? ORDER BY locale",
        product,
      ),
    ),
  };
}

const ledger = (db: Db, product: string) =>
  db.all<{ locale: string; field: string }>(
    "SELECT locale, field FROM dist_listing_truth_moves WHERE product = ? ORDER BY locale, field",
    product,
  );

const BLOB = {
  name: "Dice",
  subtitle: "Roll",
  developerName: "Acme",
  website: "https://acme.example",
  supportEmail: "help@acme.example",
};

describe("distribution.listing-truth apply and down (A-27.7)", () => {
  it("apply writes the model, a fresh dry run shows 0 changes, and the portal output equals the blob", async () => {
    const db = await makeTestDb();
    await blob(db, "dice", BLOB);
    const report = await dryRun(ctxOf(db), listingTruthJob, ACTOR);
    expect(report.changes).toBe(5);
    const res = await apply(ctxOf(db), listingTruthJob, ACTOR, report.id);
    expect(res.ok && res.run.status).toBe("applied");
    expect((await ledger(db, "dice")).map((r) => r.field)).toEqual([
      "contactEmail",
      "developerName",
      "name",
      "urls.website",
      "subtitle",
    ]);
    const again = await dryRun(ctxOf(db), listingTruthJob, ACTOR);
    expect(again.changes).toBe(0);
    expect(again.units[0]).toMatchObject({ unit: "dice" });
    expect(await plan(db, "dice")).toMatchObject({ equal: 5, missing: 0 });
    // Every field the portal reads is what the blob said.
    expect(await resolvedListing(db, "dice")).toMatchObject(BLOB);
    // The model carries the manifest's provenance, so a resync keeps owning it.
    const row = await db.first<{ provenance_json: string }>(
      "SELECT provenance_json FROM dist_listings WHERE product = 'dice'",
    );
    expect(JSON.parse(row!.provenance_json)).toMatchObject({
      name: "manifest",
      "urls.website": "manifest",
    });
  });

  it("leaves an operator's typed value and a refused value alone", async () => {
    const db = await makeTestDb();
    await blob(db, "dice", {
      ...BLOB,
      name: "Dice (blob)",
      subtitle: "S".repeat(31),
    });
    await db.batch([
      stmtUpsertListing(
        "dice",
        { name: "Deluxe" },
        undefined,
        "admin",
        "op",
        NOW,
        "en-US",
      ),
    ]);
    const report = await dryRun(ctxOf(db), listingTruthJob, ACTOR);
    await apply(ctxOf(db), listingTruthJob, ACTOR, report.id);
    const r = await resolvedListing(db, "dice");
    expect(r?.name).toBe("Deluxe");
    expect(r?.subtitle).toBe("S".repeat(31)); // the blob fills it; the model refused it
    const rows = await db.all<{ subtitle: string | null }>(
      "SELECT subtitle FROM dist_listing_locales WHERE product = 'dice'",
    );
    expect(rows.every((x) => x.subtitle === null)).toBe(true);
    expect((await ledger(db, "dice")).map((x) => x.field)).not.toContain(
      "name",
    );
  });

  it("kills mid-run and resumes: the finished product is skipped, the killed one is applied once", async () => {
    const db = await makeTestDb();
    await blob(db, "alpha", { name: "Alpha" });
    await blob(db, "beta", { name: "Beta" });
    await blob(db, "gamma", { name: "Gamma" });
    const calls: string[] = [];
    let kill: string | null = "beta";
    const job: MigrationJob = {
      ...listingTruthJob,
      apply: async (c, u) => {
        calls.push(u);
        if (kill === u) {
          kill = null;
          throw new Error("killed");
        }
        return listingTruthJob.apply(c, u);
      },
    };
    const report = await dryRun(ctxOf(db), job, ACTOR);
    const first = await apply(ctxOf(db), job, ACTOR, report.id);
    expect(first.ok && first.run.status).toBe("failed");
    expect(await ledger(db, "beta")).toEqual([]);
    calls.length = 0;
    const resumed = await apply(ctxOf(db, NOW + 1), job, ACTOR, report.id);
    expect(resumed.ok && resumed.run.status).toBe("applied");
    expect(calls).not.toContain("alpha");
    expect((await dryRun(ctxOf(db, NOW + 2), job, ACTOR)).changes).toBe(0);
    // Applying the unit again changes nothing and keeps the first ledger.
    const before = await db.all(
      "SELECT * FROM dist_listing_truth_moves ORDER BY product, field",
    );
    expect(await listingTruthJob.apply(ctxOf(db, NOW + 3), "alpha")).toBe(0);
    expect(
      await db.all(
        "SELECT * FROM dist_listing_truth_moves ORDER BY product, field",
      ),
    ).toEqual(before);
  });

  it("a call killed after its batch is re-applied as a no-op", async () => {
    const db = await makeTestDb();
    await blob(db, "dice", BLOB);
    expect(await listingTruthJob.apply(ctxOf(db), "dice")).toBe(5);
    expect(await listingTruthJob.apply(ctxOf(db, NOW + 1), "dice")).toBe(0);
  });

  it("down restores the model byte for byte, a manifest-owned value, a clear and an empty field", async () => {
    const db = await makeTestDb();
    await blob(db, "dice", {
      name: "Dice",
      subtitle: "Roll",
      website: "https://acme.example",
    });
    // A model from an earlier ingest: a stale manifest name, a manifest developer the blob dropped,
    // a typed website that differs (skipped), and a manifest subtitle.
    await db.batch([
      stmtUpsertListing(
        "dice",
        {
          name: "Dice 0",
          developerName: "Old Co",
          urls: { website: "https://typed.example" },
        },
        undefined,
        "import",
        "op",
        NOW,
        "en-US",
        { name: "manifest", developerName: "manifest" },
      ),
      stmtUpsertLocale(
        "dice",
        "en-US",
        { subtitle: "Old roll" },
        "import",
        "op",
        NOW,
        {
          subtitle: "manifest",
        },
      ),
    ]);
    const before = await modelRows(db, "dice");
    const report = await dryRun(ctxOf(db), listingTruthJob, ACTOR);
    expect(report.changes).toBe(3); // name set, developerName clear, subtitle set
    const applied = await apply(ctxOf(db), listingTruthJob, ACTOR, report.id);
    expect(await modelRows(db, "dice")).not.toEqual(before);
    const reverted = await down(
      ctxOf(db, NOW + 1),
      listingTruthJob,
      ACTOR,
      (applied.ok && applied.run.id) as string,
    );
    expect(reverted.ok && reverted.run.status).toBe("reverted");
    expect(await modelRows(db, "dice")).toEqual(before);
    expect(await ledger(db, "dice")).toEqual([]);
  });

  it("down of a product the apply filled from empty leaves its fields empty again", async () => {
    const db = await makeTestDb();
    await blob(db, "dice", BLOB);
    await listingTruthJob.apply(ctxOf(db), "dice");
    expect(await listingTruthJob.down(ctxOf(db, NOW + 1), "dice")).toBe(5);
    const r = await resolvedListing(db, "dice");
    // The model is empty again, so the portal reads the blob, as before the apply.
    expect(r).toMatchObject(BLOB);
    const row = await db.first<Record<string, unknown>>(
      "SELECT name, developer_name, urls_json, contact_email, provenance_json FROM dist_listings WHERE product = 'dice'",
    );
    expect(row).toEqual({
      name: null,
      developer_name: null,
      urls_json: null,
      contact_email: null,
      provenance_json: "{}",
    });
  });

  it("down skips a field an operator edited after the apply, and keeps the rest restored", async () => {
    const db = await makeTestDb();
    await blob(db, "dice", BLOB);
    await listingTruthJob.apply(ctxOf(db), "dice");
    await db.run(
      "UPDATE dist_listings SET name = 'Operator name', provenance_json = json_remove(provenance_json, '$.\"name\"') WHERE product = 'dice'",
    );
    await db.run(
      "UPDATE dist_listing_locales SET subtitle = 'Edited' WHERE product = 'dice'",
    );
    const n = await listingTruthJob.down(ctxOf(db, NOW + 1), "dice");
    expect(n).toBe(3);
    const app = await db.first<{ name: string; developer_name: string | null }>(
      "SELECT name, developer_name FROM dist_listings WHERE product = 'dice'",
    );
    expect(app).toEqual({ name: "Operator name", developer_name: null });
    const loc = await db.first<{ subtitle: string }>(
      "SELECT subtitle FROM dist_listing_locales WHERE product = 'dice'",
    );
    expect(loc?.subtitle).toBe("Edited");
    expect(await ledger(db, "dice")).toEqual([]);
    // Down twice is a no-op.
    expect(await listingTruthJob.down(ctxOf(db, NOW + 2), "dice")).toBe(0);
  });

  it("a unit with no blob, or already equal, applies nothing and writes no ledger", async () => {
    const db = await makeTestDb();
    await seedProduct(db, "bare");
    expect(await listingTruthJob.apply(ctxOf(db), "bare")).toBe(0);
    expect(await ledger(db, "bare")).toEqual([]);
  });

  it("the blob itself is never changed", async () => {
    const db = await makeTestDb();
    await blob(db, "dice", BLOB);
    const before = await getListing(db, "dice");
    await listingTruthJob.apply(ctxOf(db), "dice");
    await listingTruthJob.down(ctxOf(db, NOW + 1), "dice");
    expect(await getListing(db, "dice")).toEqual(before);
  });
});
