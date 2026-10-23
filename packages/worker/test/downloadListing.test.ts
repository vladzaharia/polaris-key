/**
 * A-27.8 — the download page's `listing` reads the shared listing model first, field by field,
 * then the direct outlet's merged copy (D10). A product with no model reads what it always did.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOW } from "./seed.js";
import { LISTING, SLUG, model, setup } from "./downloadWorld.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

async function seedModel(
  w: Awaited<ReturnType<typeof setup>>,
  app: {
    name?: string;
    developer?: string;
    website?: string;
  },
  locale?: { subtitle?: string; description?: string },
) {
  await w.db.run(
    `INSERT INTO dist_listings (product, default_locale, name, developer_name, urls_json, source, created_at, modified_at, modified_by)
     VALUES (?, 'en-US', ?, ?, ?, 'admin', ?, ?, 'op')`,
    SLUG,
    app.name ?? null,
    app.developer ?? null,
    app.website ? JSON.stringify({ website: app.website }) : null,
    NOW,
    NOW,
  );
  if (locale)
    await w.db.run(
      `INSERT INTO dist_listing_locales (product, locale, subtitle, description, source, modified_at, modified_by)
       VALUES (?, 'en-US', ?, ?, 'admin', ?, 'op')`,
      SLUG,
      locale.subtitle ?? null,
      locale.description ?? null,
      NOW,
    );
}

describe("download.json listing", () => {
  it("a product with no model reads the direct outlet's copy, as before", async () => {
    const w = await setup();
    expect((await model(w)).listing).toEqual({
      name: LISTING.name,
      subtitle: LISTING.subtitle,
      description: LISTING.description,
      developerName: LISTING.developerName,
      website: `${LISTING.website}/`,
    });
  });

  it("the model wins per field; the outlet fills the rest", async () => {
    const w = await setup();
    await seedModel(
      w,
      { name: "Model Name", website: "https://model.example.test" },
      { subtitle: "Model subtitle" },
    );
    expect((await model(w)).listing).toEqual({
      name: "Model Name",
      subtitle: "Model subtitle",
      description: LISTING.description,
      developerName: LISTING.developerName,
      website: "https://model.example.test/",
    });
  });

  it("a model value the page refuses falls back to the outlet's", async () => {
    const w = await setup();
    await seedModel(w, { website: "javascript:alert(1)", name: "a\u0007b" });
    const l = (await model(w)).listing;
    expect(l.website).toBe(LISTING.website + "/");
    expect(l.name).toBe(LISTING.name);
  });

  it("with no outlet listing the model still names the product", async () => {
    const w = await setup({ listing: {} });
    await seedModel(w, { name: "Model Name", developer: "Dev" });
    const l = (await model(w)).listing;
    expect(l.name).toBe("Model Name");
    expect(l.developerName).toBe("Dev");
    expect(l.subtitle).toBeNull();
  });

  it("an empty model row changes nothing", async () => {
    const a = await setup();
    const before = (await model(a)).listing;
    const b = await setup();
    await seedModel(b, {});
    expect((await model(b)).listing).toEqual(before);
  });
});
