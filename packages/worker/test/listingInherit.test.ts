/**
 * A-27.9 (criterion 2) — base fields inherit from Presentation: the product's name and accents
 * reach the store projections, the fit reports, the CI projection and the AltStore and Obtainium
 * feed, unless the listing sets the field; HA-12's order (the presentation's accent outranks the
 * listing's tint). `readListing` itself never inherits.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { NOW, seedProduct } from "./seed.js";
import type { Db } from "../src/db/types.js";
import { LISTING_STORES } from "../src/core/storefront/listingProfiles.js";
import { readListing } from "../src/services/distribution/listing/store.js";
import {
  inheritPresentation,
  inheritedFields,
} from "../src/services/distribution/listing/inherit.js";
import { ciListingProjection } from "../src/services/distribution/listing/ci.js";
import { feedListing } from "../src/services/distribution/listing/feed.js";
import { projectionFor } from "../src/services/distribution/storefronts/outcome.js";
import { makeEnv } from "./seed.js";
import { KvMock } from "./kvMock.js";

const SLUG = "dice";

async function world(listing: { name?: string; tint?: string } = {}) {
  const db = makeTestDb();
  await seedProduct(db, SLUG);
  await db.run(
    `INSERT INTO dist_listings (product, default_locale, name, tint, source, created_at, modified_at, modified_by)
     VALUES (?, 'en-US', ?, ?, 'admin', ?, ?, 'op')`,
    SLUG,
    listing.name ?? null,
    listing.tint ?? null,
    NOW,
    NOW,
  );
  // A locale and the app fields that make a store payload fit (only the name is left to inherit).
  await db.run(
    `UPDATE dist_listings SET developer_name = 'Vlad', category = 'games', copyright = '(c) 2026 Vlad',
            contact_email = 'help@dice.example',
            urls_json = '{"website":"https://dice.example","support":"https://dice.example/help","privacy":"https://dice.example/privacy","marketing":"https://dice.example/m"}'
      WHERE product = ?`,
    SLUG,
  );
  await db.run(
    `INSERT INTO dist_listing_locales (product, locale, subtitle, short_description, description, keywords_json, features_json, promotional_text, source, modified_at, modified_by)
     VALUES (?, 'en-US', 'Roll with friends', 'A tiny dice roller for tabletop nights.', 'Rolls dice. That is all it does.', '["dice","tabletop","rpg"]', '["Roll any die","Share results"]', 'Now with d100.', 'admin', ?, 'op')`,
    SLUG,
    NOW,
  );
  return db;
}

const setName = (db: Db, name: string) =>
  db.run("UPDATE products SET name = ? WHERE slug = ?", name, SLUG);
const setPresentation = (db: Db, p: Record<string, string>) =>
  db.run(
    "UPDATE products SET presentation_json = ? WHERE slug = ?",
    JSON.stringify(p),
    SLUG,
  );

const payloadText = (r: { payload: unknown } | null) =>
  JSON.stringify(r?.payload ?? null);

describe("name: products.name fills a listing with none", () => {
  it("reaches every store projection and the CI projection; a listing name wins", async () => {
    const db = await world();
    await setName(db, "Product Name");
    for (const store of LISTING_STORES) {
      const row = await projectionFor(db, SLUG, store);
      // Stores that project the name carry it; none may carry the wrong one.
      expect(payloadText(row)).not.toContain("Typed Name");
    }
    const named = await projectionFor(db, SLUG, "app-store");
    expect(payloadText(named)).toContain("Product Name");
    const ci = await ciListingProjection(db, SLUG, "play");
    expect(JSON.stringify(ci.payload)).toContain("Product Name");

    await setName(db, "Renamed");
    expect(payloadText(await projectionFor(db, SLUG, "app-store"))).toContain(
      "Renamed",
    );

    await db.run(
      "UPDATE dist_listings SET name = 'Typed Name' WHERE product = ?",
      SLUG,
    );
    const typed = payloadText(await projectionFor(db, SLUG, "app-store"));
    expect(typed).toContain("Typed Name");
    expect(typed).not.toContain("Renamed");
  });

  it("readListing never inherits", async () => {
    const db = await world();
    await setName(db, "Product Name");
    expect((await readListing(db, SLUG))!.model.app.name).toBeUndefined();
  });
});

describe("accents: presentation.accent outranks the listing's tint (HA-12)", () => {
  it("shows in the AltStore and Obtainium feed listing", async () => {
    const db = await world({ tint: "#112233" });
    for (const store of ["altstore", "obtainium"] as const) {
      expect((await feedListing(db, SLUG, store, null))?.tintColor).toBe(
        "#112233",
      );
    }
    await setPresentation(db, { accent: "#AABBCC" });
    for (const store of ["altstore", "obtainium"] as const)
      expect(
        (await feedListing(db, SLUG, store, { name: "X" }))?.tintColor,
      ).toBe("#aabbcc");
  });

  it("a product with no accent keeps the feed's bytes (manifest untouched)", async () => {
    const db = makeTestDb();
    await seedProduct(db, SLUG);
    const manifest = { name: "X", tintColor: "#445566" };
    expect(await feedListing(db, SLUG, "altstore", manifest)).toBe(manifest);
  });
});

describe("inheritPresentation", () => {
  const base = {
    app: { defaultLocale: "en-US" },
    locales: {},
    overrides: [],
  };
  it("fills name, tint and tintDark and marks each", () => {
    const r = inheritPresentation(
      base,
      {
        name: "P",
        presentation: { accent: "#AA0000", accentDark: "#00BB00" },
      },
      true,
    );
    expect(r.model.app).toMatchObject({
      name: "P",
      tint: "#aa0000",
      tintDark: "#00bb00",
    });
    expect(r.inherited).toEqual({
      name: "presentation",
      tint: "presentation",
      tintDark: "presentation",
      "icon-master": "presentation",
    });
  });
  it("a listing name is kept and not marked; developerName passes through", () => {
    const r = inheritPresentation(
      { ...base, app: { ...base.app, name: "Mine", developerName: "Dev" } },
      { name: "P", presentation: null },
      false,
    );
    expect(r.model.app).toMatchObject({ name: "Mine", developerName: "Dev" });
    expect(r.inherited).toEqual({});
  });
  it("an equal tint is not marked", () => {
    const r = inheritPresentation(
      { ...base, app: { ...base.app, tint: "#aa0000" } },
      { name: "P", presentation: { accent: "#AA0000" } },
      false,
    );
    expect(r.inherited.tint).toBeUndefined();
  });
});

describe("the admin view's inherited fields", () => {
  it("reports name and accents, and no icon without a hosted copy", async () => {
    const db = await world();
    await setPresentation(db, { accent: "#AABBCC" });
    const env = makeEnv(new KvMock(), [SLUG]);
    const stored = await readListing(db, SLUG);
    expect(await inheritedFields(env, db, SLUG, stored, [])).toEqual({
      name: "presentation",
      tint: "presentation",
    });
  });
});
