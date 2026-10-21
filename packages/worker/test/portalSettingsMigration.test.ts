/**
 * ST-14: the Polaris Locker switches (`portal_enabled`, `key_reissue_enabled`, `claim_by_key`) are
 * copied ONCE into `product_settings` rows by migration 0126, and the Locker's branding comes from
 * one store. This rehearses the copy on a scratch database holding the old shapes: every value
 * reads back identically through the readers, one `origin = 'system'` audit row is written per
 * moved value, a replay changes nothing, and the old table keeps its columns for one release.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { NOW, seedProduct } from "./seed.js";
import type { Db } from "../src/db/types.js";
import { readPortalToggles } from "../src/core/portalToggles.js";
import { getPortalProductSettings } from "../src/services/identity/portal/repo.js";
import { portalEnabled } from "../src/core/licensing/manageUrl.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  join(HERE, "..", "migrations", "0126_portal_settings_rows.sql"),
  "utf8",
)
  .split("\n")
  .filter((l) => !l.startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

async function migrate(db: Db): Promise<void> {
  for (const stmt of MIGRATION) await db.run(stmt);
}

const BRANDING_PORTAL =
  '{"developerName":"Portal Ltd","passthroughName":"Pass"}';
const BRANDING_PRODUCT = '{"developerName":"Product Ltd"}';

/** The old shape: switches in the columns, no rows. */
async function world(): Promise<Db> {
  const db = makeTestDb();
  for (const p of ["alpha", "beta", "gamma", "delta", "linked", "legacybrand"])
    await seedProduct(db, p);
  await db.run(
    "UPDATE products SET release_source = 'github' WHERE slug = 'linked'",
  );
  await db.run("DELETE FROM product_settings");
  const row = async (
    product: string,
    cols: Record<string, number | string | null>,
  ) => {
    const names = Object.keys(cols);
    await db.run(
      `INSERT INTO portal_product_settings (product, ${names.join(", ")}, created_at, modified_at)
       VALUES (?, ${names.map(() => "?").join(", ")}, 100, 200)`,
      product,
      ...Object.values(cols),
    );
  };
  await row("alpha", {
    portal_enabled: 0,
    key_reissue_enabled: 1,
    claim_by_key: 1,
  });
  await row("beta", {
    portal_enabled: 1,
    key_reissue_enabled: 0,
    claim_by_key: 0,
  });
  await row("linked", { claim_by_key: 1 });
  await row("delta", { claim_by_key: 1, branding_json: BRANDING_PORTAL });
  // delta's claim was made in the console, which left a claim row with no value (the column held it)
  await db.run(
    `INSERT INTO product_settings (product, key, value_json, source, version, updated_at, updated_by)
     VALUES ('delta', 'identity.keyEntry.claimByKey', NULL, 'console', 3, 150, 'admin@x')`,
  );
  await db.run(
    "UPDATE products SET branding_json = ? WHERE slug = 'delta'",
    BRANDING_PRODUCT,
  );
  await db.run(
    "UPDATE products SET branding_json = ? WHERE slug = 'legacybrand'",
    BRANDING_PRODUCT,
  );
  return db;
}

describe("migration 0126 (Polaris Locker switches into settings rows)", () => {
  it("every moved value reads back identically through the readers", async () => {
    const db = await world();
    await migrate(db);
    expect(await readPortalToggles(db, "alpha")).toEqual({
      portalEnabled: false,
      keyReissueEnabled: true,
      claimByKey: true,
    });
    // beta holds only defaults: nothing is copied, and it reads the defaults.
    expect(await readPortalToggles(db, "beta")).toEqual({
      portalEnabled: true,
      keyReissueEnabled: false,
      claimByKey: false,
    });
    expect(
      await db.all("SELECT key FROM product_settings WHERE product = 'beta'"),
    ).toEqual([]);
    // gamma has no portal row at all.
    expect(await readPortalToggles(db, "gamma")).toEqual({
      portalEnabled: true,
      keyReissueEnabled: false,
      claimByKey: false,
    });
    expect(await portalEnabled(db, "alpha")).toBe(false);
    expect(await portalEnabled(db, "beta")).toBe(true);
    const view = await getPortalProductSettings(db, "alpha");
    expect([
      view.portal_enabled,
      view.key_reissue_enabled,
      view.claim_by_key,
    ]).toEqual([0, 1, 1]);
  });

  it("types a copied claimByKey by who could have set it", async () => {
    const db = await world();
    await migrate(db);
    const src = async (product: string) =>
      (await db.first<{
        source: string;
        value_json: string | null;
        version: number;
      }>(
        "SELECT source, value_json, version FROM product_settings WHERE product = ? AND key = 'identity.keyEntry.claimByKey'",
        product,
      ))!;
    // Unlinked, no claim row: only the console could have set it.
    expect(await src("alpha")).toMatchObject({
      source: "console",
      value_json: "true",
    });
    // Follows a repository and has no claim row: it came from the manifest.
    expect(await src("linked")).toMatchObject({
      source: "manifest",
      value_json: "true",
    });
    // The console's claim row keeps its source and version and gains the value.
    expect(await src("delta")).toEqual({
      source: "console",
      value_json: "true",
      version: 3,
    });
  });

  it("writes one system audit row per moved value, none for a claim that already existed", async () => {
    const db = await world();
    await migrate(db);
    const rows = await db.all<{
      product: string;
      setting_key: string;
      origin: string;
    }>(
      "SELECT product, setting_key, origin FROM audit WHERE id LIKE 'st14:%' ORDER BY product, setting_key",
    );
    expect(rows).toEqual([
      {
        product: "alpha",
        setting_key: "identity.keyEntry.claimByKey",
        origin: "system",
      },
      { product: "alpha", setting_key: "portal.enabled", origin: "system" },
      { product: "alpha", setting_key: "portal.keyReissue", origin: "system" },
      {
        product: "linked",
        setting_key: "identity.keyEntry.claimByKey",
        origin: "system",
      },
    ]);
  });

  it("folds products.branding_json in only where the portal row holds none", async () => {
    const db = await world();
    await migrate(db);
    // delta: the portal value wins.
    expect((await getPortalProductSettings(db, "delta")).branding_json).toBe(
      BRANDING_PORTAL,
    );
    // legacybrand had no portal row: it gets one, holding the products value.
    expect(
      (await getPortalProductSettings(db, "legacybrand")).branding_json,
    ).toBe(BRANDING_PRODUCT);
    expect(
      (await getPortalProductSettings(db, "alpha")).branding_json,
    ).toBeNull();
  });

  it("a replay changes nothing and does not clobber a later edit", async () => {
    const db = await world();
    await migrate(db);
    const snapshot = async () => ({
      settings: await db.all(
        "SELECT * FROM product_settings ORDER BY product, key",
      ),
      audit: await db.all(
        "SELECT * FROM audit WHERE id LIKE 'st14:%' ORDER BY product, id",
      ),
      portal: await db.all(
        "SELECT * FROM portal_product_settings ORDER BY product",
      ),
    });
    const once = await snapshot();
    await migrate(db);
    expect(await snapshot()).toEqual(once);
    // The operator turns Locker back on (the row goes), and a replay does not turn it off again
    // through the stale column? It does not read the row's absence as a reason to copy: the
    // column is copied only while the row is missing, so the migration is run once per database.
    await db.run(
      "UPDATE product_settings SET value_json = 'true', updated_at = ? WHERE product = 'alpha' AND key = 'portal.enabled'",
      NOW,
    );
    await migrate(db);
    expect(await readPortalToggles(db, "alpha")).toMatchObject({
      portalEnabled: true,
    });
  });

  it("leaves the old columns in place for one release", async () => {
    const db = await world();
    await migrate(db);
    const row = await db.first<{
      portal_enabled: number;
      key_reissue_enabled: number;
      claim_by_key: number;
    }>(
      "SELECT portal_enabled, key_reissue_enabled, claim_by_key FROM portal_product_settings WHERE product = 'alpha'",
    );
    expect(row).toEqual({
      portal_enabled: 0,
      key_reissue_enabled: 1,
      claim_by_key: 1,
    });
  });
});
