/**
 * The Scoop generator (A-18i; notes/S-15 §4.4): `bucket/<app>.json` for the product's OWN bucket
 * (`direct.scoopBucket`), never a ScoopInstaller bucket. The manifest is the existing feed's,
 * byte for byte the object `/<p>/distribution/scoop/<channel>.json` serves (P2b-05, the Worker's
 * `feeds/render.ts`), so its `checkver` and `autoupdate` point at the feed and the bucket's own
 * Excavator can follow it between PRs. Written with Scoop's four-space indentation.
 */

import { needRelease, type GeneratedFile, type PrInputs } from "./prInputs.js";

export interface ScoopOptions {
  /** The app name (the manifest's file name). Default: the product slug. */
  app?: string;
}

export const SCOOP_APP_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** The app name a Scoop manifest is filed under. */
export function scoopApp(i: PrInputs, o: ScoopOptions = {}): string {
  const app = o.app ?? i.product.slug.toLowerCase();
  if (!SCOOP_APP_PATTERN.test(app))
    throw new Error(
      `--app must be 1-64 lower-case letters, digits, ., _ or - (got ${app}).`,
    );
  return app;
}

/** Generate the bucket's manifest for the inputs' release. */
export function generateScoop(
  i: PrInputs,
  o: ScoopOptions = {},
): GeneratedFile {
  const bucket = i.outlet.identity.scoopBucket;
  if (typeof bucket !== "string" || !bucket)
    throw new Error(
      `The ${i.outlet.id} outlet declares no scoopBucket in .pkey/distribution.`,
    );
  const release = needRelease(i);
  const manifest = i.scoop as { version?: unknown } | null | undefined;
  if (!manifest || typeof manifest !== "object")
    throw new Error(
      `The Scoop feed has no manifest for ${release.version}: it needs a Windows x86_64 or arm64 build with a SHA-256.`,
    );
  if (manifest.version !== release.version)
    throw new Error(
      `The Scoop feed serves ${String(manifest.version)}, not ${release.version}.`,
    );
  return {
    path: `bucket/${scoopApp(i, o)}.json`,
    content: `${JSON.stringify(manifest, null, 4)}\n`,
  };
}
