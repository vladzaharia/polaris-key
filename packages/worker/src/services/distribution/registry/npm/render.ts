/**
 * The npm feed's documents (F-04, plans/F-01.md §6.7 and §6.8): the packument, in full and
 * abbreviated form, rendered from one package's rows.
 *
 * WHAT A CLIENT READS. npm, pnpm, Yarn Berry and Bun fetch `<registry>/<escaped name>` and follow
 * `versions[v].dist.tarball` literally (pacote's registry fetcher). They verify the bytes against
 * `dist.integrity` (an SRI string; ssri picks the strongest algorithm it knows) and fall back to
 * `dist.shasum` (SHA-1) only when there is no integrity. Both come from F-03's digests:
 * `integrity` is `sha512-<base64>` when the ingest computed SHA-512, else `sha256-<base64>` of
 * the blob key (always present and R2-verified), so a version always carries one.
 *
 *   - THE FULL PACKUMENT (`application/json`, the npm registry's "package metadata"):
 *     `_id`, `name`, `description`, `dist-tags`, `versions`, `time`.
 *   - THE ABBREVIATED ONE (`application/vnd.npm.install-v1+json`, the "corgi"): `name`,
 *     `modified`, `dist-tags` and, per version, only the fields an installer reads (the npm
 *     registry's documented list, those of them the extractor keeps).
 *
 * WHAT THE VERSION FIELDS ARE. Only the extractor's allowlist (`packages/cli/src/package/npm.ts`
 * `KEPT`), copied from the validated metadata; `name` and `version` always come from the row,
 * never from the metadata, and the feed adds `_id`, `dist` and `deprecated`.
 *
 * STATES (plans/F-01.md §6.7; npm has no yank):
 *   - `live`: as published;
 *   - `deprecated`: `deprecated` carries the publisher's message;
 *   - `yanked`: still listed and installable by exact version, so a lockfile keeps working, but
 *     never the target of a dist-tag, and `deprecated` carries the yank reason, so every client
 *     warns and range resolution prefers another version.
 *
 * DIST-TAGS come from the channels (`stable` → `latest`, any other channel → a tag of its name;
 * `catalogSource.ts`). A tag pointing at a yanked or unknown version is dropped. npm clients
 * expect a `latest` tag; when no channel provides one, it is the newest non-yanked release
 * version (no prerelease), else the newest non-yanked prerelease no other tag names, else absent.
 *
 * TARBALL URLS are absolute on `PKG_ORIGIN` and conventional,
 * `<origin>/npm/<owner>/@scope/name/-/name-<version>.tgz`: Yarn Berry rebuilds that exact path
 * for a conventional URL instead of storing it, so any other spelling would break it.
 */

import type {
  PackageFile,
  PackageVersion,
  RegistryPackage,
  RenderContext,
  RenderedObject,
} from "../materialise.js";

/** The full packument's type, and the abbreviated one's. */
export const NPM_FULL_TYPE = "application/json";
export const NPM_ABBREVIATED_TYPE = "application/vnd.npm.install-v1+json";

/** The render keys of one package's two documents, under `registry/npm/<owner>/`. */
export function packumentKey(nameNorm: string, abbreviated: boolean): string {
  return `${nameNorm}/${abbreviated ? "abbreviated" : "full"}.json`;
}

/** The file type F-03's npm extractor gives the tarball. */
export const NPM_TARBALL_TYPE = "npm-tarball";

/** The `deprecated` message of a yanked version whose yank gave no reason. */
export const YANKED_MESSAGE = "This version was yanked by its publisher.";
/** The `deprecated` message of a deprecated version with no message (npm needs a non-empty one). */
export const DEPRECATED_MESSAGE = "This version is deprecated.";

/** The version fields the full packument copies from the metadata (the extractor's `KEPT`). */
const FULL_FIELDS = [
  "description",
  "license",
  "keywords",
  "homepage",
  "repository",
  "main",
  "types",
  "exports",
  "bin",
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "engines",
  "os",
  "cpu",
] as const;

/** The version fields the abbreviated packument copies (npm's documented abbreviated set). */
const ABBREVIATED_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "devDependencies",
  "peerDependencies",
  "bin",
  "engines",
  "os",
  "cpu",
] as const;

/** A scoped npm name's parts, or `null` (`@scope/name` → `{scope: "@scope", bare: "name"}`). */
export function splitScopedName(
  name: string,
): { scope: string; bare: string } | null {
  const m = /^(@[^/]+)\/([^/]+)$/.exec(name);
  return m ? { scope: m[1]!, bare: m[2]! } : null;
}

/** The conventional tarball file name of one version (`name-1.2.3.tgz`, no scope). */
export function tarballFileName(name: string, version: string): string {
  const bare = splitScopedName(name)?.bare ?? name;
  return `${bare}-${version}.tgz`;
}

/** The absolute tarball URL of one version on the registry host. */
export function tarballUrl(
  origin: string,
  owner: string,
  name: string,
  version: string,
): string {
  const parts = splitScopedName(name);
  const path = parts
    ? `${encodeURIComponent(parts.scope)}/${encodeURIComponent(parts.bare)}`
    : encodeURIComponent(name);
  return `${origin}/npm/${encodeURIComponent(owner)}/${path.replace(/^%40/, "@")}/-/${encodeURIComponent(tarballFileName(name, version))}`;
}

/** The version's tarball record, or `undefined` when it has none. */
export function tarballOf(v: PackageVersion): PackageFile | undefined {
  return v.files.find((f) => f.type === NPM_TARBALL_TYPE);
}

function hexToBase64(hex: string): string {
  let bin = "";
  for (let i = 0; i < hex.length; i += 2)
    bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return btoa(bin);
}

const HEX = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`);
const SHA512_HEX = HEX(128);
const SHA256_HEX = HEX(64);
const SHA1_HEX = HEX(40);

/** `dist` of one version: the absolute tarball URL, the SRI integrity and the SHA-1. */
function distOf(
  pkg: RegistryPackage,
  v: PackageVersion,
  file: PackageFile,
  ctx: RenderContext,
): Record<string, unknown> {
  const sha512 = file.sha512?.toLowerCase();
  const sha1 = file.sha1?.toLowerCase();
  const integrity =
    sha512 && SHA512_HEX.test(sha512)
      ? `sha512-${hexToBase64(sha512)}`
      : SHA256_HEX.test(file.sha256)
        ? `sha256-${hexToBase64(file.sha256)}`
        : undefined;
  return {
    ...(integrity ? { integrity } : {}),
    ...(sha1 && SHA1_HEX.test(sha1) ? { shasum: sha1 } : {}),
    tarball: tarballUrl(ctx.origin, pkg.product, pkg.name, v.version),
  };
}

/** The `deprecated` message of a version, or `undefined` when it is live. */
export function deprecationOf(v: PackageVersion): string | undefined {
  if (v.state === "live") return undefined;
  const msg = v.stateMessage?.trim();
  if (msg) return msg;
  return v.state === "yanked" ? YANKED_MESSAGE : DEPRECATED_MESSAGE;
}

function pick(
  metadata: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of fields) if (metadata[k] !== undefined) out[k] = metadata[k];
  return out;
}

const PRERELEASE = /^\d+\.\d+\.\d+-/;

/**
 * The `dist-tags` of a package: its channel tags, minus any that points at a yanked or unknown
 * version, plus a `latest` when no channel gave one (see the file comment).
 */
export function distTags(
  pkg: RegistryPackage,
  servable: readonly PackageVersion[],
): Record<string, string> {
  const byVersion = new Map(servable.map((v) => [v.version, v]));
  const tags: Record<string, string> = {};
  for (const [tag, version] of Object.entries(pkg.tags).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const v = byVersion.get(version);
    if (v && v.state !== "yanked") tags[tag] = version;
  }
  if (tags.latest === undefined) {
    const live = servable.filter((v) => v.state !== "yanked");
    const release = live.filter((v) => !PRERELEASE.test(v.version));
    // A prerelease another channel's tag already names stays that channel's: it is reachable as
    // `@<channel>`, and making it `latest` too would promote a build nobody promoted (F-10: our
    // SDKs' `-main.N` builds are `main`, never `latest`, even before the first stable release).
    const named = new Set(Object.values(tags));
    const untagged = live.filter((v) => !named.has(v.version));
    const newest = (release.length ? release : untagged).at(-1);
    if (newest) tags.latest = newest.version;
  }
  return Object.fromEntries(
    Object.entries(tags).sort(([a], [b]) =>
      a === "latest" ? -1 : b === "latest" ? 1 : a < b ? -1 : a > b ? 1 : 0,
    ),
  );
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

/** The two packuments of one package, as plain objects (the golden tests compare these). */
export function packuments(
  pkg: RegistryPackage,
  ctx: RenderContext,
): { full: Record<string, unknown>; abbreviated: Record<string, unknown> } {
  // A version without a tarball cannot be installed, so it is not listed at all.
  const servable = pkg.versions.filter((v) => tarballOf(v) !== undefined);
  const tags = distTags(pkg, servable);
  const fullVersions: Record<string, unknown> = {};
  const abbreviatedVersions: Record<string, unknown> = {};
  const time: Record<string, string> = {};
  let created: number | null = null;
  let modified: number | null = null;
  for (const v of servable) {
    const dist = distOf(pkg, v, tarballOf(v)!, ctx);
    const deprecated = deprecationOf(v);
    fullVersions[v.version] = {
      ...pick(v.metadata, FULL_FIELDS),
      name: pkg.name,
      version: v.version,
      _id: `${pkg.name}@${v.version}`,
      ...(deprecated !== undefined ? { deprecated } : {}),
      dist,
    };
    abbreviatedVersions[v.version] = {
      name: pkg.name,
      version: v.version,
      ...pick(v.metadata, ABBREVIATED_FIELDS),
      ...(deprecated !== undefined ? { deprecated } : {}),
      dist,
    };
    time[v.version] = iso(v.publishedAt);
    created =
      created === null ? v.publishedAt : Math.min(created, v.publishedAt);
    modified =
      modified === null ? v.publishedAt : Math.max(modified, v.publishedAt);
  }
  const latest =
    tags.latest !== undefined
      ? servable.find((v) => v.version === tags.latest)
      : undefined;
  const description = latest?.metadata.description;
  const timeDoc =
    created !== null && modified !== null
      ? { created: iso(created), modified: iso(modified), ...time }
      : {};
  return {
    full: {
      _id: pkg.name,
      name: pkg.name,
      ...(typeof description === "string" ? { description } : {}),
      "dist-tags": tags,
      versions: fullVersions,
      time: timeDoc,
    },
    abbreviated: {
      name: pkg.name,
      ...(modified !== null ? { modified: iso(modified) } : {}),
      "dist-tags": tags,
      versions: abbreviatedVersions,
    },
  };
}

/** The renderer's objects: the full and the abbreviated packument. */
export function renderNpm(
  pkg: RegistryPackage,
  ctx: RenderContext,
): RenderedObject[] {
  const { full, abbreviated } = packuments(pkg, ctx);
  return [
    {
      key: packumentKey(pkg.nameNorm, false),
      body: JSON.stringify(full),
      contentType: NPM_FULL_TYPE,
    },
    {
      key: packumentKey(pkg.nameNorm, true),
      body: JSON.stringify(abbreviated),
      contentType: NPM_ABBREVIATED_TYPE,
    },
  ];
}
