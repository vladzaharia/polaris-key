/**
 * The Scoop generator (A-18i; notes/S-15 §4.4): `bucket/<app>.json` for the product's OWN bucket
 * (`direct.scoopBucket`), never a ScoopInstaller bucket. The manifest is the existing feed's, the
 * object `/<p>/distribution/scoop/<channel>.json` serves (P2b-05, the Worker's `feeds/render.ts`),
 * with `checkver` pointing at the feed. The feed only writes `autoupdate` when a build URL carries
 * the version; Polaris-hosted builds are content-addressed (`…/blobs/sha256/<hash>`) and never do,
 * so for those the generator adds it ({@link withHashAutoupdate}): `checkver` captures each
 * architecture's hash from the feed and `autoupdate` rebuilds the URL from it, which lets the
 * bucket's Excavator follow the feed between PRs. Written with Scoop's four-space indentation.
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
    content: `${JSON.stringify(withHashAutoupdate(manifest), null, 4)}\n`,
  };
}

const HASH_URL = /\/blobs\/sha256\/([0-9a-f]{64})$/;

/**
 * The `checkver` capture group for an architecture key. Scoop names the variable
 * `'$match' + TextInfo.ToTitleCase(group)` and substitutes it case-sensitively, so the group is
 * lower-case letters only (no digit for ToTitleCase to treat as a word break) and no group's
 * variable is a prefix of another's: `64bit` → `hashx` (`$matchHashx`), `arm64` → `hasharm`.
 */
const HASH_GROUP: Readonly<Record<string, string>> = {
  "64bit": "hashx",
  "32bit": "hashi",
  arm64: "hasharm",
};
function hashGroup(arch: string): string | null {
  return HASH_GROUP[arch] ?? null;
}

/**
 * Add `autoupdate` to a feed manifest whose builds are content-addressed. Scoop's Excavator needs
 * `autoupdate` to rewrite a manifest, and a hash-addressed URL has no `$version` to substitute, so
 * `checkver` becomes a regex over the feed JSON (P2b-05 serialises `version` first and the
 * architectures in sorted key order, each `{url, hash}`) that captures the version and each
 * architecture's hash, and `autoupdate` rebuilds each URL with `$match<Hash…>`. The hash itself
 * still comes from the feed's JSON path. Manifests that already have `autoupdate`, or whose URLs
 * are not all `…/blobs/sha256/<their hash>`, are returned unchanged.
 */
export function withHashAutoupdate(manifest: object): object {
  const m = manifest as {
    autoupdate?: unknown;
    architecture?: Record<string, { url?: unknown; hash?: unknown }>;
    checkver?: { url?: unknown };
  };
  if (m.autoupdate !== undefined || !m.architecture) return manifest;
  const feedUrl = m.checkver?.url;
  if (typeof feedUrl !== "string") return manifest;
  const arches = Object.keys(m.architecture);
  if (arches.length === 0) return manifest;
  const autoArch: Record<string, unknown> = {};
  const parts = ['"version"\\s*:\\s*"(?<version>[^"]+)"'];
  for (const arch of arches) {
    const { url, hash } = m.architecture[arch]!;
    if (typeof url !== "string" || typeof hash !== "string") return manifest;
    const match = HASH_URL.exec(url);
    if (!match || match[1] !== hash) return manifest;
    const group = hashGroup(arch);
    if (!group) return manifest;
    const variable = `$match${group[0]!.toUpperCase()}${group.slice(1)}`;
    parts.push(
      `"${arch}"\\s*:\\s*\\{[^}]*?"hash"\\s*:\\s*"(?<${group}>[0-9a-f]{64})"`,
    );
    autoArch[arch] = {
      url: `${url.slice(0, -hash.length)}${variable}`,
      hash: { url: feedUrl, jsonpath: `$.architecture.${arch}.hash` },
    };
  }
  return {
    ...manifest,
    checkver: { url: feedUrl, regex: parts.join("[\\s\\S]*?") },
    autoupdate: { architecture: autoArch },
  };
}
