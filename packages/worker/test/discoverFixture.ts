/** Fixtures for the Discover-visibility suites (LK-12b/12d): a product the storefront may offer. */
import { NOW, seedProduct, seedTier } from "./seed.js";
import type { Db } from "../src/db/types.js";
import { serializeServices, type ServicesMap } from "../src/core/services.js";
import { setServices } from "../src/core/products/store.js";

export const flags = (identity: boolean): ServicesMap => ({
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

export async function setup(
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
