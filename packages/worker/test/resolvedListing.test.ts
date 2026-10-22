/**
 * A-27.1 — `resolvedListing`, the read behind `delivery().listing()`: the shared listing model
 * over the root-listing blob, field by field. Model only, blob only (deep-equals `getListing`),
 * both (the model wins per field, art from the blob), the support fields, and Distribution off.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import type { Db } from "../src/db/types.js";
import { SERVICES } from "../src/mount.js";
import { buildHooks } from "../src/core/hooks.js";
import { loadProduct } from "../src/core/products.js";
import { setServices } from "../src/core/products/store.js";
import { serializeServices } from "../src/core/services.js";
import { getListing } from "../src/services/distribution/outlets.js";
import { resolvedListing } from "../src/services/distribution/listing/resolved.js";

const SLUG = "dice";

async function world() {
  const db = makeTestDb();
  await seedProduct(db, SLUG);
  return db;
}

const blob = (db: Db, listing: unknown) =>
  db.run(
    "INSERT INTO dist_listing (product, listing_json, modified_at) VALUES (?, ?, ?)",
    SLUG,
    JSON.stringify(listing),
    NOW,
  );

async function model(
  db: Db,
  app: {
    name?: string;
    developer?: string;
    category?: string;
    urls?: Record<string, string>;
    email?: string;
    tint?: string;
  },
  locale?: { name?: string; subtitle?: string; description?: string },
) {
  await db.run(
    `INSERT INTO dist_listings (product, default_locale, name, developer_name, category, urls_json,
                                contact_email, tint, source, created_at, modified_at, modified_by)
     VALUES (?, 'en-US', ?, ?, ?, ?, ?, ?, 'admin', ?, ?, 'op')`,
    SLUG,
    app.name ?? null,
    app.developer ?? null,
    app.category ?? null,
    app.urls ? JSON.stringify(app.urls) : null,
    app.email ?? null,
    app.tint ?? null,
    NOW,
    NOW,
  );
  if (locale)
    await db.run(
      `INSERT INTO dist_listing_locales (product, locale, name, subtitle, description, source, modified_at, modified_by)
       VALUES (?, 'en-US', ?, ?, ?, 'admin', ?, 'op')`,
      SLUG,
      locale.name ?? null,
      locale.subtitle ?? null,
      locale.description ?? null,
      NOW,
    );
}

const BLOB = {
  name: "Dice (manifest)",
  subtitle: "Manifest subtitle",
  icon: { kind: "url", url: "https://dice.example/icon.png" },
  screenshots: [{ kind: "url", url: "https://dice.example/s1.png" }],
  tintColor: "#3b1f1f",
  website: "https://dice.example",
  developerName: "Manifest Dev",
};

describe("resolvedListing", () => {
  it("nothing stored reads null", async () => {
    expect(await resolvedListing(await world(), SLUG)).toBeNull();
  });

  it("blob only deep-equals getListing", async () => {
    const db = await world();
    await blob(db, BLOB);
    expect(await resolvedListing(db, SLUG)).toEqual(await getListing(db, SLUG));
    expect(await resolvedListing(db, SLUG)).toEqual(BLOB);
  });

  it("an empty model row leaves the blob alone", async () => {
    const db = await world();
    await blob(db, BLOB);
    await model(db, {});
    expect(await resolvedListing(db, SLUG)).toEqual(BLOB);
  });

  it("model only maps urls, contact email and tint to the manifest names", async () => {
    const db = await world();
    await model(
      db,
      {
        name: "Dice",
        developer: "Vlad",
        category: "games",
        urls: {
          website: "https://dice.example",
          support: "https://dice.example/help",
          privacy: "https://dice.example/privacy",
        },
        email: "help@dice.example",
        tint: "#ff8800",
      },
      { subtitle: "Roll", description: "Rolls dice." },
    );
    expect(await resolvedListing(db, SLUG)).toEqual({
      name: "Dice",
      subtitle: "Roll",
      description: "Rolls dice.",
      category: "games",
      website: "https://dice.example",
      developerName: "Vlad",
      supportUrl: "https://dice.example/help",
      supportEmail: "help@dice.example",
      tintColor: "#ff8800",
    });
  });

  it("both: the model wins per field, the rest and all art come from the blob", async () => {
    const db = await world();
    await blob(db, {
      ...BLOB,
      supportUrl: "https://old.example/help",
      supportEmail: "old@dice.example",
    });
    await model(
      db,
      { name: "Dice", urls: { support: "https://dice.example/help" } },
      { name: "Dice (en)" },
    );
    expect(await resolvedListing(db, SLUG)).toEqual({
      ...BLOB,
      name: "Dice (en)",
      supportUrl: "https://dice.example/help",
      supportEmail: "old@dice.example",
    });
  });

  it("a typed model field replaces the manifest's, and the locale name beats the app name", async () => {
    const db = await world();
    await blob(db, BLOB);
    await model(
      db,
      { name: "App name", developer: "Typed Dev" },
      {
        name: "Locale name",
      },
    );
    const r = await resolvedListing(db, SLUG);
    expect(r?.name).toBe("Locale name");
    expect(r?.developerName).toBe("Typed Dev");
    expect(r?.subtitle).toBe("Manifest subtitle");
    expect(r?.icon).toEqual(BLOB.icon);
  });

  it("the hook reads it, and is null while Distribution is off", async () => {
    const db = await world();
    await blob(db, BLOB);
    await model(db, { name: "Dice" });
    const env = makeEnv(new KvMock(), [SLUG]);
    const on = (enabled: boolean) =>
      setServices(
        db,
        SLUG,
        serializeServices({
          services: {
            license: { enabled: true },
            config: { enabled: false },
            release: { enabled },
            distribution: { enabled },
            update: { enabled: false },
            identity: { enabled: false },
            sync: { enabled: false },
            commerce: { enabled: false },
          },
        }),
        "manifest",
        NOW,
      );
    const hooks = async () => {
      const product = (await loadProduct(env, db, SLUG))!;
      return buildHooks(SERVICES, product.services, {
        env,
        db,
        product,
        now: NOW,
      });
    };
    await on(true);
    expect((await (await hooks()).delivery()!.listing())?.name).toBe("Dice");
    await on(false);
    expect((await hooks()).delivery()).toBeNull();
  });
});
