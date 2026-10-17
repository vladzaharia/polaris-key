/**
 * Test support: the row statements License, Identity and Distribution contribute to an ingest for
 * a product with `services` as given, in the service table's order. What the old descriptor hooks
 * returned; the tests that seed a product's rows without a link or resync use it.
 */
import type { ParsedManifest } from "@polaris-key/manifest";
import type { DbStatement } from "../../src/db/types.js";
import type { ServicesMap } from "../../src/core/services.js";
import { distributionStatements } from "../../src/services/distribution/ingest.js";
import { identityHookStatements } from "../../src/services/identity/ingest.js";
import { licensingRowStatements } from "../../src/services/license/ingest.js";

export function contributedRowStatements(
  manifest: ParsedManifest,
  slug: string,
  services: ServicesMap,
  now: number,
): DbStatement[] {
  const at = { manifest, slug, now };
  return [
    ...licensingRowStatements(manifest, slug, now),
    ...distributionStatements({
      ...at,
      enabled: services.distribution.enabled,
    }),
    ...identityHookStatements({ ...at, enabled: services.identity.enabled }),
  ];
}
