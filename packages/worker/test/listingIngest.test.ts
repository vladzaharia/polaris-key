/**
 * A-27.4 — the ingest writes the shared listing model (phase-1 dual-write), guarded in SQL:
 * a push changes a model field only where it is empty or owned by `manifest`.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { NOW, seedProduct } from "./seed.js";
import type { Db } from "../src/db/types.js";
import type { ParsedManifest } from "@polaris-key/manifest";
import { distributionStatements } from "../src/services/distribution/ingest.js";
import { resolvedListing } from "../src/services/distribution/listing/resolved.js";

const SLUG = "dice";

const manifest = (listing: Record<string, unknown> | null): ParsedManifest =>
  ({
    distribution: {
      declared: true,
      outlets: [],
      transports: { default: "pkey-cdn", packs: {}, deliverables: {} },
      listing,
      routes: [],
    },
  }) as unknown as ParsedManifest;

const ROOT = {
  name: "Dice",
  subtitle: "Roll with friends",
  description: "Rolls dice.",
  developerName: "Vlad",
  tintColor: "#ff8800",
  website: "https://dice.example",
  supportUrl: "https://dice.example/help",
  supportEmail: "help@dice.example",
};

async function ingest(
  db: Db,
  listing: Record<string, unknown> | null,
  opts: { enabled?: boolean; now?: number } = {},
): Promise<number[]> {
  const stmts = distributionStatements({
    manifest: manifest(listing),
    slug: SLUG,
    now: opts.now ?? NOW,
    enabled: opts.enabled ?? true,
  });
  return db.batchChanges!(stmts);
}

const app = (db: Db) =>
  db.first<Record<string, string | null>>(
    "SELECT * FROM dist_listings WHERE product = ?",
    SLUG,
  );
const loc = (db: Db) =>
  db.first<Record<string, string | null>>(
    "SELECT * FROM dist_listing_locales WHERE product = ?",
    SLUG,
  );
const prov = (r: Record<string, string | null> | null) =>
  JSON.parse(r?.provenance_json ?? "{}") as Record<string, string>;

async function world() {
  const db = makeTestDb();
  await seedProduct(db, SLUG);
  return db;
}

describe("the ingest writes the model", () => {
  it("the first ingest creates the rows, every field with manifest provenance", async () => {
    const db = await world();
    await ingest(db, ROOT);
    const a = (await app(db))!;
    expect(a).toMatchObject({
      default_locale: "en-US",
      source: "import",
      name: "Dice",
      developer_name: "Vlad",
      tint: "#ff8800",
      contact_email: "help@dice.example",
    });
    expect(JSON.parse(a.urls_json!)).toEqual({
      website: "https://dice.example",
      support: "https://dice.example/help",
    });
    expect(prov(a)).toEqual({
      name: "manifest",
      developerName: "manifest",
      tint: "manifest",
      contactEmail: "manifest",
      "urls.website": "manifest",
      "urls.support": "manifest",
    });
    const l = (await loc(db))!;
    expect(l).toMatchObject({
      locale: "en-US",
      subtitle: "Roll with friends",
      description: "Rolls dice.",
    });
    expect(prov(l)).toEqual({ subtitle: "manifest", description: "manifest" });
    // The reader sees the model; the blob write is still there.
    expect((await resolvedListing(db, SLUG))?.name).toBe("Dice");
    expect(
      await db.first("SELECT 1 FROM dist_listing WHERE product = ?", SLUG),
    ).not.toBeNull();
  });

  it("an identical resync changes no row of the model", async () => {
    const db = await world();
    await ingest(db, ROOT);
    const before = [await app(db), await loc(db)];
    const stmts = distributionStatements({
      manifest: manifest(ROOT),
      slug: SLUG,
      now: NOW + 100,
      enabled: true,
    });
    const changes = await db.batchChanges!(stmts);
    const modelChanges = stmts
      .map((s, i) => ({ s, c: changes[i]! }))
      .filter((x) => /dist_listings|dist_listing_locales/.test(x.s.sql));
    expect(modelChanges.length).toBeGreaterThan(0);
    expect(modelChanges.every((x) => x.c === 0)).toBe(true);
    expect([await app(db), await loc(db)]).toEqual(before);
  });

  it("a changed manifest value follows through", async () => {
    const db = await world();
    await ingest(db, ROOT);
    await ingest(db, { ...ROOT, name: "Dice 2" }, { now: NOW + 5 });
    expect((await app(db))!.name).toBe("Dice 2");
  });

  it("a typed field and an App Store-imported field survive a push", async () => {
    const db = await world();
    await ingest(db, { name: "Dice" });
    // The operator types the name and an App Store import fills the developer name.
    await db.run(
      `UPDATE dist_listings SET name = 'Typed', developer_name = 'Store Dev',
              provenance_json = '{"developerName":"app-store"}' WHERE product = ?`,
      SLUG,
    );
    await ingest(db, ROOT, { now: NOW + 5 });
    const a = (await app(db))!;
    expect(a.name).toBe("Typed");
    expect(a.developer_name).toBe("Store Dev");
    expect(prov(a).developerName).toBe("app-store");
    expect(prov(a).name).toBeUndefined();
    // Empty fields are still filled.
    expect(a.tint).toBe("#ff8800");
  });

  it("a typed locale field survives, an empty one is filled", async () => {
    const db = await world();
    await ingest(db, { name: "Dice", subtitle: "Mine" });
    await db.run(
      `UPDATE dist_listing_locales SET subtitle = 'Typed', provenance_json = '{}' WHERE product = ?`,
      SLUG,
    );
    await ingest(db, ROOT, { now: NOW + 5 });
    const l = (await loc(db))!;
    expect(l.subtitle).toBe("Typed");
    expect(l.description).toBe("Rolls dice.");
  });

  it("an operator edit between plan and write is not overwritten (the guard runs in the UPDATE)", async () => {
    const db = await world();
    await ingest(db, ROOT);
    const stmts = distributionStatements({
      manifest: manifest({ ...ROOT, name: "Dice 3" }),
      slug: SLUG,
      now: NOW + 9,
      enabled: true,
    });
    // The statements were built; the operator types the name before they run.
    await db.run(
      `UPDATE dist_listings SET name = 'Operator',
              provenance_json = json_remove(provenance_json, '$."name"') WHERE product = ?`,
      SLUG,
    );
    await db.batch(stmts);
    expect((await app(db))!.name).toBe("Operator");
  });

  it("a dropped manifest field is cleared; a typed one is kept", async () => {
    const db = await world();
    await ingest(db, ROOT);
    await db.run(
      `UPDATE dist_listings SET developer_name = 'Typed Dev',
              provenance_json = json_remove(provenance_json, '$.developerName') WHERE product = ?`,
      SLUG,
    );
    await ingest(db, { name: "Dice" }, { now: NOW + 5 });
    const a = (await app(db))!;
    expect(a.name).toBe("Dice");
    expect(a.developer_name).toBe("Typed Dev");
    expect(a.tint).toBeNull();
    expect(a.contact_email).toBeNull();
    expect(a.urls_json).toBeNull();
    expect(prov(a)).toEqual({ name: "manifest" });
    const l = (await loc(db))!;
    expect(l.subtitle).toBeNull();
    expect(prov(l)).toEqual({});
  });

  it("no listing at all clears what the manifest owned", async () => {
    const db = await world();
    await ingest(db, ROOT);
    await ingest(db, null, { now: NOW + 5 });
    const a = (await app(db))!;
    expect(a.name).toBeNull();
    expect(prov(a)).toEqual({});
  });

  it("an over-limit value is skipped (the stored one stays), the rest still lands", async () => {
    const db = await world();
    await ingest(db, ROOT);
    await ingest(
      db,
      {
        ...ROOT,
        name: "N".repeat(31),
        subtitle: "S".repeat(31),
        tintColor: "#000000",
      },
      { now: NOW + 5 },
    );
    const a = (await app(db))!;
    expect(a.name).toBe("Dice");
    expect(a.tint).toBe("#000000");
    expect((await loc(db))!.subtitle).toBe("Roll with friends");
  });

  it("an existing model keeps its own default locale", async () => {
    const db = await world();
    await db.run(
      `INSERT INTO dist_listings (product, default_locale, source, created_at, modified_at, modified_by, provenance_json)
       VALUES (?, 'de-DE', 'admin', ?, ?, 'op', '{}')`,
      SLUG,
      NOW,
      NOW,
    );
    await ingest(db, ROOT);
    expect((await app(db))!.default_locale).toBe("de-DE");
    expect((await loc(db))!.locale).toBe("de-DE");
  });

  it("an admin row with no provenance map: typed values kept, empty ones filled", async () => {
    const db = await world();
    await db.run(
      `INSERT INTO dist_listings (product, default_locale, name, source, created_at, modified_at, modified_by)
       VALUES (?, 'en-US', 'Typed', 'admin', ?, ?, 'op')`,
      SLUG,
      NOW,
      NOW,
    );
    await ingest(db, ROOT);
    const a = (await app(db))!;
    expect(a.name).toBe("Typed");
    expect(a.developer_name).toBe("Vlad");
  });

  it("Distribution off writes nothing to the model", async () => {
    const db = await world();
    await ingest(db, ROOT, { enabled: false });
    expect(await app(db)).toBeNull();
    expect(await loc(db)).toBeNull();
  });
});
