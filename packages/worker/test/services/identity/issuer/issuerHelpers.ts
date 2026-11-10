/** Shared setup for the issuer tests: turn `identity.issuer.enabled` on through the manifest path. */
import type { ParsedManifest } from "@polaris-key/manifest";
import type { Db } from "../../../../src/db/types.js";
import {
  identityHookStatements,
  issuerClientStatements,
} from "../../../../src/services/identity/ingest.js";
import { NOW } from "../../../seed.js";

/** A parsed manifest holding only the `identity` block (the only member the ingest reads). */
export const identityManifest = (identity?: unknown): ParsedManifest =>
  ({ identity }) as unknown as ParsedManifest;

/** Apply the identity row settings for `slug` as a resync would. */
export async function ingestIdentity(
  db: Db,
  slug: string,
  identity?: unknown,
  at = NOW,
): Promise<void> {
  const ctx = {
    manifest: identityManifest(identity),
    slug,
    now: at,
    enabled: true,
  };
  await db.batch([
    ...issuerClientStatements(ctx),
    ...identityHookStatements(ctx),
  ]);
}

/** Turn the issuer on for each slug, as the manifest does. */
export async function enableIssuer(db: Db, ...slugs: string[]): Promise<void> {
  for (const slug of slugs)
    await ingestIdentity(db, slug, { issuer: { enabled: true } });
}
