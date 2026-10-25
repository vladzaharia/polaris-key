/**
 * A-27.3 — the one manifest mapping (`manifestListingSnapshot`), `manifestSource` reading the
 * root listing from Core's manifest snapshot (an outlet's merged copy unchanged), and the pure
 * sync plan (`planManifestSync`): empty, manifest, typed, store-imported, dropped, over-limit.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../helpers.js";
import { NOW, seedProduct } from "../../seed.js";
import {
  manifestListingSnapshot,
  type CurrentListing,
} from "../../../src/core/storefront/listingImport.js";
import { stmtUpsertManifestSnapshot } from "../../../src/core/manifestSnapshot.js";
import { manifestSource } from "../../../src/services/distribution/listing/sources.js";
import { planManifestSync } from "../../../src/services/distribution/listing/manifestSync.js";

const SLUG = "dice";
const LOC = "en-US";

const ROOT = {
  name: "Dice",
  subtitle: "Roll with friends",
  description: "Rolls dice.",
  developerName: "Vlad",
  category: "Puzzle-games",
  tintColor: "#ff8800",
  website: "https://dice.example",
  supportUrl: "https://dice.example/help",
  supportEmail: "help@dice.example",
  icon: { kind: "url", url: "https://dice.example/i.png" },
};

describe("manifestListingSnapshot (the mapping table)", () => {
  const snap = manifestListingSnapshot(ROOT, "root", LOC);

  it("maps each manifest field to its model field", () => {
    expect(snap.source).toBe("manifest");
    expect(snap.ref).toBe("root");
    expect(snap.app).toEqual({
      name: "Dice",
      developerName: "Vlad",
      category: "puzzle-games",
      tint: "#ff8800",
      contactEmail: "help@dice.example",
      urls: {
        website: "https://dice.example",
        support: "https://dice.example/help",
      },
    });
    expect(snap.locales).toEqual({
      [LOC]: { subtitle: "Roll with friends", description: "Rolls dice." },
    });
  });

  it("reports art as skipped, never maps it", () => {
    expect(snap.assets).toEqual([]);
    expect(snap.skipped.map((s) => s.field)).toEqual(["icon"]);
  });

  it("drops empty and non-string values", () => {
    const s = manifestListingSnapshot({ name: "", website: 3 }, null, LOC);
    expect(s.app).toEqual({});
    expect(s.locales).toEqual({});
  });
});

describe("manifestSource", () => {
  async function world(withSnapshot: boolean) {
    const db = makeTestDb();
    await seedProduct(db, SLUG);
    await db.run(
      `INSERT INTO dist_outlets (product, outlet_id, kind, identity_json, listing_json, created_at, modified_at)
       VALUES (?, 'altstore', 'altstore', '{}', ?, ?, ?)`,
      SLUG,
      JSON.stringify({ name: "Outlet copy", subtitle: "Merged" }),
      NOW,
      NOW,
    );
    if (withSnapshot) {
      const st = stmtUpsertManifestSnapshot({
        product: SLUG,
        appliedSha: null,
        appliedAt: NOW,
        origin: "link",
        filesSha256: "0".repeat(64),
        manifest: { distribution: { listing: ROOT } },
      });
      await db.run(st.sql, ...st.params);
    }
    return db;
  }

  it("with no outlet reads the root listing from the manifest snapshot", async () => {
    const r = await manifestSource(await world(true), SLUG, null, LOC);
    expect(r.ok && r.snapshot.ref).toBe("root");
    expect(r.ok && r.snapshot.app.name).toBe("Dice");
    expect(r.ok && r.snapshot.app.contactEmail).toBe("help@dice.example");
  });

  it("with an outlet keeps that outlet's merged copy", async () => {
    const r = await manifestSource(await world(true), SLUG, "altstore", LOC);
    expect(r.ok && r.snapshot.ref).toBe("altstore");
    expect(r.ok && r.snapshot.app.name).toBe("Outlet copy");
    expect(r.ok && r.snapshot.locales[LOC]).toEqual({ subtitle: "Merged" });
  });

  it("with no snapshot row falls back to the first live outlet", async () => {
    const r = await manifestSource(await world(false), SLUG, null, LOC);
    expect(r.ok && r.snapshot.ref).toBe("altstore");
  });

  it("a snapshot with no listing refuses", async () => {
    const db = await world(false);
    const st = stmtUpsertManifestSnapshot({
      product: SLUG,
      appliedSha: null,
      appliedAt: NOW,
      origin: "link",
      filesSha256: "0".repeat(64),
      manifest: { distribution: { listing: null } },
    });
    await db.run(st.sql, ...st.params);
    const r = await manifestSource(db, SLUG, null, LOC);
    expect(r.ok).toBe(false);
  });
});

describe("planManifestSync", () => {
  const root = manifestListingSnapshot(ROOT, "root", LOC);
  const stored = (over: Partial<CurrentListing> = {}): CurrentListing => ({
    exists: true,
    defaultLocale: LOC,
    app: {},
    locales: {},
    appProvenance: {},
    localeProvenance: {},
    precedence: {},
    ...over,
  });
  const setFields = (p: ReturnType<typeof planManifestSync>) =>
    p.writes.filter((w) => w.action === "set").map((w) => w.field);

  it("empty model: sets every mapped field", () => {
    const p = planManifestSync(stored({ exists: false }), root, LOC);
    expect(setFields(p)).toEqual([
      "name",
      "developerName",
      "category",
      "tint",
      "contactEmail",
      "urls.website",
      "urls.support",
      `locales.${LOC}.subtitle`,
      `locales.${LOC}.description`,
    ]);
    expect(p.skipped).toEqual([]);
    expect(p.refused).toEqual([]);
  });

  it("a manifest-sourced field follows the manifest; an unchanged one writes nothing", () => {
    const p = planManifestSync(
      stored({
        app: { name: "Old", developerName: "Vlad" },
        appProvenance: { name: "manifest", developerName: "manifest" },
      }),
      root,
      LOC,
    );
    expect(p.writes.find((w) => w.field === "name")).toEqual({
      field: "name",
      locale: null,
      action: "set",
      value: "Dice",
    });
    expect(p.writes.some((w) => w.field === "developerName")).toBe(false);
  });

  it("a typed field is skipped", () => {
    const p = planManifestSync(stored({ app: { name: "Typed" } }), root, LOC);
    expect(p.skipped).toContainEqual({ field: "name", reason: "typed" });
    expect(p.writes.some((w) => w.field === "name")).toBe(false);
  });

  it("a store-imported field is skipped, with its source", () => {
    const p = planManifestSync(
      stored({
        app: { name: "Store" },
        appProvenance: { name: "app-store" },
        locales: { [LOC]: { subtitle: "From play" } },
        localeProvenance: { [LOC]: { subtitle: "play" } },
      }),
      root,
      LOC,
    );
    expect(p.skipped).toContainEqual({
      field: "name",
      reason: "imported",
      source: "app-store",
    });
    expect(p.skipped).toContainEqual({
      field: `locales.${LOC}.subtitle`,
      reason: "imported",
      source: "play",
    });
  });

  it("a manifest field the manifest dropped is cleared; a typed one is not", () => {
    const bare = manifestListingSnapshot({ name: "Dice" }, "root", LOC);
    const p = planManifestSync(
      stored({
        app: { developerName: "Vlad", tint: "#000000" },
        appProvenance: { developerName: "manifest" },
        locales: { [LOC]: { subtitle: "Old" } },
        localeProvenance: { [LOC]: { subtitle: "manifest" } },
      }),
      bare,
      LOC,
    );
    expect(p.writes).toContainEqual({
      field: "developerName",
      locale: null,
      action: "clear",
    });
    expect(p.writes).toContainEqual({
      field: `locales.${LOC}.subtitle`,
      locale: LOC,
      action: "clear",
    });
    expect(p.writes.some((w) => w.field === "tint")).toBe(false);
  });

  it("an over-limit value is refused with its limit, never cut; the stored value stays", () => {
    const long = manifestListingSnapshot(
      { name: "N".repeat(31), subtitle: "S".repeat(31), developerName: "ok" },
      "root",
      LOC,
    );
    const p = planManifestSync(
      stored({ app: { name: "Kept" }, appProvenance: { name: "manifest" } }),
      long,
      LOC,
    );
    expect(p.refused).toContainEqual(
      expect.objectContaining({ field: "name", limit: 30 }),
    );
    expect(p.refused).toContainEqual(
      expect.objectContaining({ field: `locales.${LOC}.subtitle`, limit: 30 }),
    );
    expect(p.writes.some((w) => w.field === "name")).toBe(false);
    expect(setFields(p)).toContain("developerName");
  });
});
