/**
 * `release.scrub-manifest-snapshots`: rewrite the stored manifest snapshots so none holds a
 * secret value. Snapshots written before the scrub (`core/manifestSnapshot.ts`
 * `scrubManifestSecrets`) kept the parsed manifest as it was before sealing.
 *
 * One unit per product with a snapshot. The keys judged secret are the union of the snapshot's
 * own catalog and the product's stored one, as sealing judges them. Apply is a compare-and-set on
 * the text it scrubbed, so it is idempotent and never overwrites a newer snapshot. Down restores
 * nothing: the old text is not kept, and must not be recoverable.
 */

import { Catalog } from "@polaris-key/catalog";
import type { MigrationJob } from "../../core/migrate/job.js";
import type { MigrationContext } from "../../core/migrate/job.js";
import { getActiveSchema } from "../../core/products/store.js";
import {
  getManifestSnapshot,
  scrubManifestSecrets,
} from "../../core/manifestSnapshot.js";
import { isJsonObject } from "../../platform/json.js";
import {
  managedSecretKeyPredicate,
  parseStoredCatalog,
} from "./manifestSecrets.js";

async function scrubbed(
  ctx: MigrationContext,
  product: string,
): Promise<{ from: string; to: string } | null> {
  const row = await getManifestSnapshot(ctx.db, product);
  if (!row) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.manifest_json);
  } catch {
    return null;
  }
  const catalogs: Catalog[] = [];
  if (isJsonObject(parsed) && isJsonObject(parsed.catalog)) {
    try {
      catalogs.push(new Catalog(parsed.catalog as never));
    } catch {
      /* an unparseable catalog names no keys */
    }
  }
  const stored = parseStoredCatalog(
    (await getActiveSchema(ctx.db, product))?.catalog_json,
  );
  if (stored) catalogs.push(stored);
  const to = JSON.stringify(
    scrubManifestSecrets(parsed, managedSecretKeyPredicate(catalogs)),
  );
  return to === row.manifest_json ? null : { from: row.manifest_json, to };
}

export const scrubManifestSnapshotsJob: MigrationJob = {
  id: "release.scrub-manifest-snapshots",
  summary:
    "Replace secret values held in stored manifest snapshots with a marker",
  async units(ctx) {
    const rows = await ctx.db.all<{ product: string }>(
      "SELECT product FROM product_manifest_snapshot ORDER BY product",
    );
    return rows.map((r) => r.product);
  },
  async plan(ctx, unit) {
    return { changes: (await scrubbed(ctx, unit)) ? 1 : 0 };
  },
  async apply(ctx, unit) {
    const change = await scrubbed(ctx, unit);
    if (!change) return 0;
    return ctx.db.runChanges(
      "UPDATE product_manifest_snapshot SET manifest_json = ? WHERE product = ? AND manifest_json = ?",
      change.to,
      unit,
      change.from,
    );
  },
  /** Nothing to restore: the plaintext is not kept. */
  async down() {
    return 0;
  },
};
