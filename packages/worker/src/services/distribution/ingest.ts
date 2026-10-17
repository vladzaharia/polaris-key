/**
 * Distribution's contribution to the manifest ingest (P0-26): `.pkey/distribution` (outlets and
 * transports) and the declared release keys as key-inventory observations (P3-03) while
 * Distribution is on, and the `app` row of `dist_access` WHATEVER its enablement (P2b-04: the row
 * must already hold the manifest's answer when an operator turns Distribution on).
 */

import type { DbStatement } from "../../db/types.js";
import type {
  IngestContext,
  ManifestContribution,
  ManifestContributor,
} from "../../core/ingest/types.js";
import { accessIngestStatements } from "./access.js";
import { releaseKeyObservationStatements } from "./availability.js";
import { manifestIngestStatements as outletIngestStatements } from "./outlets.js";

async function prepare(ctx: IngestContext): Promise<ManifestContribution> {
  const { manifest, slug, now } = ctx;
  const statements: DbStatement[] = [
    ...(ctx.enabled
      ? [
          ...outletIngestStatements(manifest, slug, now),
          ...releaseKeyObservationStatements(manifest, slug, now),
        ]
      : []),
    ...accessIngestStatements(manifest, slug, now),
  ];
  return {
    statements,
    audits: [],
    updated: statements.length > 0 ? ["distribution"] : [],
  };
}

export const distributionManifest: ManifestContributor = { prepare };
