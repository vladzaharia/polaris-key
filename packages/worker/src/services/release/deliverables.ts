/**
 * The manifest's deliverable declarations, written at link and on every resync (P2-04; packs
 * P4-02).
 *
 * `release_deliverables` gets the `app` row with the declaration as `def_json`
 * (`def_source = 'manifest'`) — or NULL when `.pkey/release` declares no `deliverables`, the
 * implicit app deliverable with legacy sniffing. The truth-store sync and the descriptor ingest
 * read the artifact map back from it (`readAppDeliverable`).
 *
 * Each declared channel's `includes` goes to `release_channel_policy` through the source-guarded
 * `stmtSetChannelPolicy` (P2-03): a manifest write never resets an operator's pointer, and a
 * channel an operator has claimed (`source = 'admin'`) is left alone. A channel the manifest no
 * longer declares has its manifest-owned `includes` cleared.
 */

import {
  APP_DELIVERABLE_ID,
  type ManifestAppDeliverable,
  type ManifestPackDeliverable,
  type ManifestPackageDeliverable,
} from "@polaris-key/manifest";
import type { DbStatement } from "../../db/types.js";
import { stmtSetChannelPolicy, stmtUpsertDeliverable } from "./model.js";

export function manifestDeliverableStatements(
  product: string,
  app: ManifestAppDeliverable | null,
  now: number,
  packs: readonly ManifestPackDeliverable[] = [],
  packages: readonly ManifestPackageDeliverable[] = [],
): DbStatement[] {
  const stmts: DbStatement[] = [
    stmtUpsertDeliverable(
      {
        product,
        deliverableId: APP_DELIVERABLE_ID,
        kind: "app",
        defJson: app ? JSON.stringify(app) : null,
        defSource: "manifest",
      },
      now,
    ),
  ];
  const channels = Object.entries(app?.channels ?? {});
  for (const [channel, decl] of channels) {
    stmts.push(
      stmtSetChannelPolicy(
        { product, deliverableId: APP_DELIVERABLE_ID, channel },
        { includes: decl.includes.length > 0 ? decl.includes : null },
        { source: "manifest", by: "manifest", now },
      ),
    );
  }
  stmts.push({
    sql: `UPDATE release_channel_policy
             SET includes_json = NULL, modified_at = ?, modified_by = 'manifest'
           WHERE product = ? AND deliverable_id = ? AND source = 'manifest'
             AND includes_json IS NOT NULL
             AND channel NOT IN (SELECT value FROM json_each(?))`,
    params: [
      now,
      product,
      APP_DELIVERABLE_ID,
      JSON.stringify(channels.map(([name]) => name)),
    ],
  });
  stmts.push(...packDeliverableStatements(product, packs, now));
  stmts.push(...packageDeliverableStatements(product, packages, now));
  return stmts;
}

/**
 * The package rows (F-03): upsert each declared package unless an operator owns its row or the
 * id is held by another kind, then drop the manifest-owned rows of packages no longer declared —
 * except one with any release. A package version is unique forever, so its deliverable row stays
 * for the feeds to keep serving its history; and a package's ecosystem and name never change
 * under its released versions (`release_exists` is the ingest's answer to a re-declared name,
 * which publishes under the old one). Feed retention (`packages/prune.ts`) deletes the
 * `release_packages` rows of builds of main, but only below a live stable release, which is
 * never pruned: a package that had any prune keeps a release row, so this lock still holds.
 */
function packageDeliverableStatements(
  product: string,
  packages: readonly ManifestPackageDeliverable[],
  now: number,
): DbStatement[] {
  const stmts: DbStatement[] = packages.map((p) => {
    const upsert = stmtUpsertDeliverable(
      {
        product,
        deliverableId: p.id,
        kind: "package",
        defJson: JSON.stringify(p),
        defSource: "manifest",
        ecosystem: p.ecosystem,
        packageName: p.name,
      },
      now,
    );
    return {
      sql: `${upsert.sql}
          WHERE release_deliverables.def_source = 'manifest'
            AND release_deliverables.kind = 'package'
            AND (NOT EXISTS (SELECT 1 FROM release_packages rp
                              WHERE rp.product = release_deliverables.product
                                AND rp.deliverable_id = release_deliverables.deliverable_id)
                 OR (release_deliverables.ecosystem = excluded.ecosystem
                     AND release_deliverables.package_name = excluded.package_name))`,
      params: upsert.params,
    };
  });
  stmts.push({
    sql: `DELETE FROM release_deliverables
           WHERE product = ? AND kind = 'package' AND def_source = 'manifest'
             AND deliverable_id NOT IN (SELECT value FROM json_each(?))
             AND NOT EXISTS (SELECT 1 FROM release_metadata m
                              WHERE m.product = release_deliverables.product
                                AND m.deliverable_id = release_deliverables.deliverable_id)
             AND NOT EXISTS (SELECT 1 FROM release_channel_policy c
                              WHERE c.product = release_deliverables.product
                                AND c.deliverable_id = release_deliverables.deliverable_id)`,
    params: [product, JSON.stringify(packages.map((p) => p.id))],
  });
  return stmts;
}

/** The pack rows (P4-02): upsert each declared pack unless an operator owns its row, then drop
 *  the manifest-owned rows of packs no longer declared. */
function packDeliverableStatements(
  product: string,
  packs: readonly ManifestPackDeliverable[],
  now: number,
): DbStatement[] {
  const stmts: DbStatement[] = packs.map((p) => {
    const upsert = stmtUpsertDeliverable(
      {
        product,
        deliverableId: p.id,
        kind: "pack",
        packType: p.type,
        defJson: JSON.stringify(p),
        defSource: "manifest",
      },
      now,
    );
    // The operator-ownership guard: ON CONFLICT ... DO UPDATE applies only to a manifest-owned
    // row (a row of kind `app` under this id is impossible: the validator reserves `app`).
    return {
      sql: `${upsert.sql}
          WHERE release_deliverables.def_source = 'manifest'
            AND release_deliverables.kind = 'pack'`,
      params: upsert.params,
    };
  });
  stmts.push({
    sql: `DELETE FROM release_deliverables
           WHERE product = ? AND kind = 'pack' AND def_source = 'manifest'
             AND deliverable_id NOT IN (SELECT value FROM json_each(?))
             AND NOT EXISTS (SELECT 1 FROM release_channel_policy c
                              WHERE c.product = release_deliverables.product
                                AND c.deliverable_id = release_deliverables.deliverable_id)
             AND NOT EXISTS (SELECT 1 FROM release_pack_floors f
                              WHERE f.product = release_deliverables.product
                                AND f.deliverable_id = release_deliverables.deliverable_id)`,
    params: [product, JSON.stringify(packs.map((p) => p.id))],
  });
  return stmts;
}
