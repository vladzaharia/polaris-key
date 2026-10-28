/**
 * LK-12b: the download page's "Add to library" row. Drawn in "Every way to get" only when
 * Identity says a new account would see the product in Discover and a customer origin exists;
 * the link is `<customer origin>/<slug>`, built from the slug alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOW, seedTier } from "../../seed.js";
import {
  serializeServices,
  type ServicesMap,
} from "../../../src/core/services.js";
import { setServices } from "../../../src/core/products/store.js";
import { writeListing } from "../../listingWrites.js";
import { SLUG, UA, onBytes, setup, type World } from "../../downloadWorld.js";
import { renderDownloadPage } from "../../../src/services/distribution/page/render.js";
import { detectPlatform } from "../../../src/core/platformDetect.js";
import type { DownloadModel } from "../../../src/services/distribution/page/model.js";

const CUSTOMER = "https://locker.example.test";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

const flags = (identity: boolean): ServicesMap => ({
  license: { enabled: true },
  config: { enabled: true },
  release: { enabled: true },
  distribution: { enabled: true },
  update: { enabled: true },
  identity: { enabled: identity },
  sync: { enabled: false },
  commerce: { enabled: false },
  connect: { enabled: false },
});

/** The download world with Identity on and the product free with an account. */
async function world(
  opts: { identity?: boolean; free?: boolean; customer?: boolean } = {},
): Promise<World> {
  const w = await setup();
  await setServices(
    w.db,
    SLUG,
    serializeServices({ services: flags(opts.identity !== false) }),
    "manifest",
    NOW,
  );
  await seedTier(w.db, SLUG, "free", { deviceLimit: 2, expiryDays: 90 });
  if (opts.free !== false)
    await w.db.run(
      "UPDATE products SET auto_issue_json = ? WHERE slug = ?",
      JSON.stringify({ enabled: true, tierId: "free", mode: "oidcDefault" }),
      SLUG,
    );
  if (opts.customer !== false) w.env.CUSTOMER_ORIGIN = CUSTOMER;
  return w;
}

async function page(w: World): Promise<string> {
  const res = await onBytes(w, `/${SLUG}`, {
    headers: { "user-agent": UA.windows },
  });
  expect(res.status).toBe(200);
  return res.text();
}

const ROW = 'data-action="locker-library"';

describe("the Add to library row (LK-12b)", () => {
  it("shows for a product Discover offers, linking to <customer origin>/<slug>", async () => {
    const html = await page(await world());
    expect(html).toContain(ROW);
    expect(html).toContain(`href="${CUSTOMER}/${SLUG}"`);
    expect(html).toContain(">Add to library</a>");
    const ways = html.slice(html.indexOf('id="ways-title"'));
    expect(ways).toContain(ROW);
    expect(ways).toContain('<span class="row-title">Polaris Locker</span>');
  });

  it("draws no row for an unlisted product", async () => {
    const w = await world();
    await writeListing(w.db, SLUG, { storeListed: "unlisted" });
    expect(await page(w)).not.toContain(ROW);
  });

  it("draws no row for a purchase-only or operator-issued product", async () => {
    expect(await page(await world({ free: false }))).not.toContain(ROW);
  });

  it("draws no row with the storefront off", async () => {
    const w = await world();
    await w.db.run(
      `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
       VALUES ('storefront.polarisKey.enabled', '"off"', 2, ?, 'u1')`,
      NOW,
    );
    expect(await page(w)).not.toContain(ROW);
  });

  it("draws no row while Identity is off", async () => {
    expect(await page(await world({ identity: false }))).not.toContain(ROW);
  });

  it("draws no row without a customer origin", async () => {
    expect(await page(await world({ customer: false }))).not.toContain(ROW);
  });
});

describe("renderDownloadPage libraryUrl", () => {
  const model = {
    schemaVersion: 1,
    product: { slug: "tidewater", name: "Tidewater" },
    channel: "stable",
    pageUrl: null,
    listing: {
      name: "Tidewater",
      subtitle: null,
      description: null,
      developerName: null,
      website: null,
    },
    release: null,
    platforms: [],
    actions: [],
    keys: [],
  } as unknown as DownloadModel;
  const detected = detectPlatform(
    new Headers({ "user-agent": "Windows NT 10.0" }),
  );

  it("renders the row, and the section, only with a URL", () => {
    const withRow = renderDownloadPage(model, detected, {
      libraryUrl: "https://locker.example.test/tidewater",
    });
    expect(withRow).toContain("Every way to get Tidewater");
    expect(withRow).toContain(
      '<a class="obtn" href="https://locker.example.test/tidewater" title="Polaris Locker" aria-label="Add to library, Polaris Locker">Add to library</a>',
    );
    const without = renderDownloadPage(model, detected, { libraryUrl: null });
    expect(without).not.toContain("Every way to get");
    expect(without).not.toContain("Add to library");
  });

  it("refuses an unsafe URL", () => {
    expect(
      renderDownloadPage(model, detected, {
        libraryUrl: "javascript:alert(1)",
      }),
    ).not.toContain("Add to library");
  });
});
