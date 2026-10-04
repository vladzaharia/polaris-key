/// <reference types="@cloudflare/workers-types" />
/**
 * The Swift registry's rendered documents (F-06, plans/F-01.md §6.5 and §6.8; SwiftPM
 * `Registry.md` §4.1 and §4.2). Rendered from D1 into R2 when a package changes, under
 * `registry/swift/<owner>/<identity>/`, where `<identity>` is `scope.name` in lower case
 * (package identity is case-insensitive, §3.6):
 *
 *   releases.json     the release list (§4.1), every version in precedence order, a yanked one
 *                     with its `problem` (410 Gone), so SwiftPM never resolves it;
 *   <version>.json    one release's metadata (§4.2): `id`, `version`, the `source-archive`
 *                     resource with its SHA-256 `checksum` and, when the release is signed, its
 *                     `signing {signatureBase64Encoded, signatureFormat}` (§5.3), `metadata` and
 *                     `publishedAt`;
 *   routing.json      not served: what the routes need to answer without D1 — each version's
 *                     state, its archive and signed manifests (content-addressed blobs), the
 *                     signature, and the `latest-version` / predecessor / successor links.
 *
 * NO URL IS RENDERED. The list omits each release's optional `url` (a client then expands
 * `/{scope}/{name}/{version}` on the host it asked, §4.1), and the routes build every `Link`
 * header from the origin when they answer, so a render never depends on where it is served.
 *
 * YANK, DEPRECATE AND CHANNELS (plans/F-01.md §6.3, §6.7). The protocol's only unavailability
 * signal is the list's `problem`: a yanked version carries one, and SwiftPM treats it as
 * unavailable for resolution. Its metadata, manifests and archive stay served, because a Swift
 * archive never changes after publish (SwiftPM pins the checksum on first use). The protocol has
 * no deprecation, so a deprecated version is listed as available. It has no tags either: the
 * `latest-version` link names the `latest` tag (the `stable` channel's head) when it is
 * available, else the highest-precedence stable version; a prerelease (a `beta` channel's
 * `2.0.0-beta.1`) resolves only for a requirement that names a prerelease, which is SwiftPM's
 * own rule.
 *
 * SIGNATURES. The renderer reads the release's `source-archive-signature` blob (the raw CMS
 * bytes `swift package-registry publish --dry-run` writes) to embed it, base64, in the metadata
 * and the routing record. The Worker checks only presence and `signatureFormat == "cms-1.0.0"`;
 * SwiftPM verifies the certificate chain (§5.3).
 */

import { blobKey } from "../../../../core/blobs.js";
import { compareSemver } from "../../../../core/entitlements.js";
import type {
  PackageFile,
  PackageVersion,
  RegistryPackage,
  RenderContext,
  RenderedObject,
} from "../materialise.js";

/** The one signature format this registry serves (SE-0391 `cms-1.0.0`). */
export const SWIFT_SIGNATURE_FORMAT = "cms-1.0.0";

/** The largest signature blob embedded (a CMS signature with its chain is a few KiB). */
export const MAX_SIGNATURE_BYTES = 64 * 1024;

/** How much of a manifest is read for its `swift-tools-version` comment. */
const TOOLS_VERSION_PREFIX_BYTES = 1024;

/** `Package@swift-<n>[.<n>[.<n>]].swift` (`Registry.md` §4.3). */
const VERSIONED_MANIFEST = /^Package@swift-(\d+(?:\.\d+){0,2})\.swift$/;

/** One signed manifest of a release: the blob, and its tools version where it names one. */
export interface SwiftManifestRoute {
  readonly filename: string;
  readonly sha256: string;
  readonly size: number;
  /** `Package@swift-X.swift`'s declared tools version (`// swift-tools-version:…`). */
  readonly toolsVersion?: string;
}

/** What the routes know about one version, from `routing.json`. */
export interface SwiftVersionRoute {
  readonly state: PackageVersion["state"];
  readonly archive: { readonly sha256: string; readonly size: number } | null;
  readonly signature: {
    readonly format: string;
    readonly base64: string;
  } | null;
  /** By swift version: `""` is the unqualified `Package.swift`, `"5.9"` is `Package@swift-5.9.swift`. */
  readonly manifests: Readonly<Record<string, SwiftManifestRoute>>;
  readonly predecessor: string | null;
  readonly successor: string | null;
}

/** `routing.json`. */
export interface SwiftRouting {
  /** `scope.Name` as declared. */
  readonly id: string;
  readonly latest: string | null;
  /** In precedence order, highest first. */
  readonly versions: Readonly<Record<string, SwiftVersionRoute>>;
}

/** The R2 keys (under the owner's prefix) of one package's documents. */
export function swiftKeys(identity: string): {
  releases: string;
  routing: string;
  release: (version: string) => string;
} {
  const base = identity.toLowerCase();
  return {
    releases: `${base}/releases.json`,
    routing: `${base}/routing.json`,
    release: (version) => `${base}/${version}.json`,
  };
}

/** Versions in precedence order, highest first (semver; ties by string, for a stable order). */
export function byPrecedence<T extends { version: string }>(
  versions: readonly T[],
): T[] {
  return [...versions].sort(
    (a, b) =>
      compareSemver(b.version, a.version) ||
      (a.version < b.version ? 1 : a.version > b.version ? -1 : 0),
  );
}

function isPrerelease(version: string): boolean {
  return /^[0-9]+\.[0-9]+\.[0-9]+-/.test(version);
}

/** The version `latest-version` names (see the file comment), or `null` when none is available. */
export function latestVersion(pkg: RegistryPackage): string | null {
  const available = byPrecedence(pkg.versions).filter(
    (v) => v.state !== "yanked",
  );
  const tagged = pkg.tags.latest;
  if (tagged !== undefined && available.some((v) => v.version === tagged))
    return tagged;
  return (
    available.find((v) => !isPrerelease(v.version))?.version ??
    available[0]?.version ??
    null
  );
}

function fileOfType(v: PackageVersion, type: string): PackageFile | undefined {
  return v.files.find((f) => f.type === type);
}

async function readBlob(
  bucket: R2Bucket | undefined,
  sha256: string,
  limit: number,
): Promise<Uint8Array | null> {
  if (!bucket) return null;
  const obj = await bucket.get(blobKey(sha256));
  if (!obj) return null;
  const bytes = new Uint8Array(await obj.arrayBuffer());
  return bytes.length > limit ? bytes.subarray(0, limit) : bytes;
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** The tools version a manifest's first line declares (`// swift-tools-version:5.9`), if any. */
export function declaredToolsVersion(source: string): string | undefined {
  const m =
    /^\uFEFF?\s*\/\/\s*swift-tools-version\s*:\s*([0-9]+(?:\.[0-9]+){0,2})/i.exec(
      source,
    );
  return m?.[1];
}

/** The signature of a signed version, or `null` for an unsigned one; throws when a signed
 *  version's signature cannot be read, so the render fails and the drain retries. */
async function signatureOf(
  v: PackageVersion,
  ctx: RenderContext,
): Promise<SwiftVersionRoute["signature"]> {
  const sig = fileOfType(v, "source-archive-signature");
  if (!sig || v.metadata.signatureFormat !== SWIFT_SIGNATURE_FORMAT)
    return null;
  if (sig.size > MAX_SIGNATURE_BYTES)
    throw new Error("swift: signature over the embed limit");
  const bytes = await readBlob(ctx.bucket, sig.sha256, MAX_SIGNATURE_BYTES);
  if (bytes === null) throw new Error("swift: signature blob unreadable");
  return { format: SWIFT_SIGNATURE_FORMAT, base64: base64(bytes) };
}

async function manifestsOf(
  v: PackageVersion,
  ctx: RenderContext,
): Promise<Record<string, SwiftManifestRoute>> {
  const out: Record<string, SwiftManifestRoute> = {};
  const files = v.files
    .filter((f) => f.type === "manifest")
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const f of files) {
    if (f.name === "Package.swift") {
      out[""] = { filename: f.name, sha256: f.sha256, size: f.size };
      continue;
    }
    const swiftVersion = VERSIONED_MANIFEST.exec(f.name)?.[1];
    if (swiftVersion === undefined) continue;
    const head = await readBlob(
      ctx.bucket,
      f.sha256,
      TOOLS_VERSION_PREFIX_BYTES,
    );
    const declared =
      head === null
        ? undefined
        : declaredToolsVersion(new TextDecoder().decode(head));
    out[swiftVersion] = {
      filename: f.name,
      sha256: f.sha256,
      size: f.size,
      toolsVersion: declared ?? swiftVersion,
    };
  }
  return out;
}

/** `publishedAt` as ISO 8601 to the second (`2026-10-04T12:00:00Z`). */
function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The release metadata document of one version (`Registry.md` §4.2). */
export function releaseMetadata(
  pkg: RegistryPackage,
  v: PackageVersion,
  route: SwiftVersionRoute,
): Record<string, unknown> {
  const resources: Record<string, unknown>[] = [];
  if (route.archive)
    resources.push({
      name: "source-archive",
      type: "application/zip",
      checksum: route.archive.sha256,
      ...(route.signature
        ? {
            signing: {
              signatureBase64Encoded: route.signature.base64,
              signatureFormat: route.signature.format,
            },
          }
        : {}),
    });
  return {
    id: pkg.name,
    version: v.version,
    resources,
    metadata: {},
    publishedAt: iso(v.publishedAt),
  };
}

/** The release list document (`Registry.md` §4.1). */
export function releaseList(pkg: RegistryPackage): Record<string, unknown> {
  const releases: Record<string, unknown> = {};
  for (const v of byPrecedence(pkg.versions))
    releases[v.version] =
      v.state === "yanked"
        ? {
            problem: {
              status: 410,
              title: "Gone",
              detail: "this release was yanked from the registry",
            },
          }
        : {};
  return { releases };
}

/** Every document of one package, and its routing record. */
export async function renderSwift(
  pkg: RegistryPackage,
  ctx: RenderContext,
): Promise<RenderedObject[]> {
  const keys = swiftKeys(pkg.nameNorm);
  const ordered = byPrecedence(pkg.versions);
  const available = ordered.filter((v) => v.state !== "yanked");
  const neighbour = (version: string, dir: 1 | -1): string | null => {
    // `available` is highest first: a successor is higher (earlier), a predecessor lower.
    const candidates =
      dir === 1
        ? available.filter((a) => compareSemver(a.version, version) > 0)
        : available.filter((a) => compareSemver(a.version, version) < 0);
    if (candidates.length === 0) return null;
    return dir === 1
      ? candidates[candidates.length - 1]!.version
      : candidates[0]!.version;
  };
  const routes: Record<string, SwiftVersionRoute> = {};
  const objects: RenderedObject[] = [];
  for (const v of ordered) {
    const archive = fileOfType(v, "source-archive");
    const route: SwiftVersionRoute = {
      state: v.state,
      archive: archive ? { sha256: archive.sha256, size: archive.size } : null,
      signature: await signatureOf(v, ctx),
      manifests: await manifestsOf(v, ctx),
      predecessor: neighbour(v.version, -1),
      successor: neighbour(v.version, 1),
    };
    routes[v.version] = route;
    objects.push({
      key: keys.release(v.version),
      body: JSON.stringify(releaseMetadata(pkg, v, route)),
      contentType: "application/json",
    });
  }
  const routing: SwiftRouting = {
    id: pkg.name,
    latest: latestVersion(pkg),
    versions: routes,
  };
  objects.unshift(
    {
      key: keys.releases,
      body: JSON.stringify(releaseList(pkg)),
      contentType: "application/json",
    },
    {
      key: keys.routing,
      body: JSON.stringify(routing),
      contentType: "application/json",
    },
  );
  return objects;
}
