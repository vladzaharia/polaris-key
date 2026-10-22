/**
 * A-27.6: `distribution.listing-truth`, the dry run and its report. The dry run reads and writes
 * nothing (the runner stores the report); apply and down are A-27.7, so the runner refuses both.
 */
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db/types.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import type { MigrationContext } from "../src/core/migrate/job.js";
import { apply, dryRun, getRun } from "../src/core/migrate/runner.js";
import {
  listingTruthJob,
  type ListingTruthDetail,
} from "../src/services/distribution/listingTruthJob.js";
import { migrationJobs } from "../src/core/contributions.js";
import {
  stmtUpsertListing,
  stmtUpsertLocale,
} from "../src/services/distribution/listing/store.js";
import "../src/mount.js";

const ACTOR = { sub: "op", name: "Op", email: null };
const ICON = "https://raw.githubusercontent.com/acme/dice/main/icon.png";

const ctxOf = (db: Db): MigrationContext => ({
  env: makeEnv(new KvMock(), []),
  db,
  now: NOW,
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

  it("the runner's dry run writes only its report, and apply and down are refused", async () => {
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
    const applied = await apply(ctxOf(db), listingTruthJob, ACTOR, run.id);
    expect(applied).toMatchObject({ ok: false, reason: "delegated" });
    expect(await count()).toEqual(before);
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
