/**
 * The manifest's deliverable declarations, written at link and on every resync (P2-04).
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
} from "@polaris-key/manifest";
import type { DbStatement } from "../../core/platform.js";
import { stmtSetChannelPolicy, stmtUpsertDeliverable } from "./model.js";

export function manifestDeliverableStatements(
  product: string,
  app: ManifestAppDeliverable | null,
  now: number,
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
  return stmts;
}
