/**
 * LK-12b: Identity's `discoverVisibility` hook answers whether a new signed-in account with no
 * licence would be offered the product to add in Discover. One case per input.
 */
import { describe, expect, it } from "vitest";
import { writeListing } from "../../listingWrites.js";
import { makeTestDb, NO_HOOKS } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import {
  makeEnv,
  NOW,
  seedProduct,
  seedTier,
  setPortalToggles,
} from "../../seed.js";
import type { Db } from "../../../src/db/types.js";
import {
  serializeServices,
  type ServicesMap,
} from "../../../src/core/services.js";
import { setServices } from "../../../src/core/products/store.js";
import { loadProductPublic } from "../../../src/core/products.js";
import { buildHooks, type HookContext } from "../../../src/core/hooks.js";
import { SERVICES } from "../../../src/mount.js";
import { discoverVisibility } from "../../../src/services/identity/portal/store/visibility.js";

const flags = (identity: boolean): ServicesMap => ({
  license: { enabled: true },
  config: { enabled: false },
  release: { enabled: false },
  distribution: { enabled: false },
  update: { enabled: false },
  identity: { enabled: identity },
  sync: { enabled: false },
  commerce: { enabled: false },
  connect: { enabled: false },
});

async function setup(
  db: Db,
  slug: string,
  opts: { free?: boolean; identity?: boolean } = {},
): Promise<void> {
  await seedProduct(db, slug);
  await setServices(
    db,
    slug,
    serializeServices({ services: flags(opts.identity !== false) }),
    "manifest",
    NOW,
  );
  await seedTier(db, slug, "free", { deviceLimit: 2, expiryDays: 90 });
  if (opts.free !== false)
    await db.run(
      "UPDATE products SET auto_issue_json = ? WHERE slug = ?",
      JSON.stringify({ enabled: true, tierId: "free", mode: "oidcDefault" }),
      slug,
    );
}

async function visible(db: Db, slug: string): Promise<boolean> {
  const product = (await loadProductPublic(db, slug))!;
  const ctx: HookContext = {
    env: makeEnv(new KvMock(), []),
    db,
    product,
    now: NOW,
    hooks: NO_HOOKS,
  };
  return discoverVisibility(ctx);
}

describe("discoverVisibility (LK-12b)", () => {
  it("is true for a listed, free-with-account product with the portal and storefront on", async () => {
    const db = makeTestDb();
    await setup(db, "free");
    expect(await visible(db, "free")).toBe(true);
    await writeListing(db, "free", { storeListed: "listed" });
    expect(await visible(db, "free")).toBe(true);
  });

  it("is false for an unlisted product", async () => {
    const db = makeTestDb();
    await setup(db, "p");
    await writeListing(db, "p", { storeListed: "unlisted" });
    expect(await visible(db, "p")).toBe(false);
  });

  it("is false for a purchase-only or operator-issued product (no path for a new account)", async () => {
    const db = makeTestDb();
    await setup(db, "paid", { free: false });
    expect(await visible(db, "paid")).toBe(false);
  });

  it("is false with the portal off", async () => {
    const db = makeTestDb();
    await setup(db, "p");
    await setPortalToggles(db, "p", { portalEnabled: false }, NOW);
    expect(await visible(db, "p")).toBe(false);
  });

  it("is false with the deployment's storefront off", async () => {
    const db = makeTestDb();
    await setup(db, "p");
    await db.run(
      `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
       VALUES ('storefront.polarisKey.enabled', '"off"', 2, ?, 'u1')`,
      NOW,
    );
    expect(await visible(db, "p")).toBe(false);
  });

  it("is false for an audience-everyone link with nothing to add", async () => {
    const db = makeTestDb();
    await setup(db, "p", { free: false });
    await writeListing(db, "p", {
      storeListed: "listed",
      storeAudience: "everyone",
    });
    expect(await visible(db, "p")).toBe(false);
  });

  it("the accessor answers null while Identity is off, and the value while it is on", async () => {
    const db = makeTestDb();
    await setup(db, "on");
    await setup(db, "off", { identity: false });
    for (const [slug, want] of [
      ["on", true],
      ["off", null],
    ] as const) {
      const product = (await loadProductPublic(db, slug))!;
      const hooks = buildHooks(SERVICES, flags(slug === "on"), {
        env: makeEnv(new KvMock(), []),
        db,
        product,
        now: NOW,
      });
      expect(await hooks.discoverVisibility(), slug).toBe(want);
    }
  });
});
