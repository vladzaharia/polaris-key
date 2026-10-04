/**
 * The OCI feed's rendered documents (F-08, plans/F-01.md §6.5 and §6.8): pure functions from a
 * package's D1 state to the two objects the materialiser writes under
 * `registry/oci/<owner>/<repository>/`.
 *
 *   - `_tags.json`: the repository's tag list, `{name: "<owner>/<repository>", tags: [...]}`, the
 *     body of `GET /v2/<name>/tags/list` before pagination (distribution-spec "end-8a"), sorted
 *     in lexical (code point) order as the spec asks;
 *   - `_refs.json`: every tag's pointer, `{<tag>: {digest, mediaType, size}}`, which
 *     `GET /v2/<name>/manifests/<tag>` resolves through.
 *
 * Both names start with `_`, which no OCI path component can (`[a-z0-9]` first), so a nested
 * repository's prefix can never collide with them.
 *
 * TAGS (§6.3, §6.7):
 *   - every version that is not yanked is a tag of its own name, pointing at its `metadata.root`.
 *     Version tags NEVER move: a version is unique forever, so its root never changes;
 *   - every channel head is a moving tag: `stable` → `latest`, any other channel → a tag of its
 *     own name (`RegistryPackage.tags`, built from `releaseCatalog.packageChannelHeads`, which
 *     already leaves yanked versions out). A channel tag that equals a version tag is dropped:
 *     the version tag wins, because it never moves;
 *   - a yanked version has no tag at all. OCI has no yank marker, so this is the only way a
 *     client can learn of it; its manifests and blobs stay reachable BY DIGEST, so a pinned
 *     `name@sha256:…` reference keeps working (PEP 592's rule for exact pins);
 *   - a deprecated version is served exactly like a live one: OCI has no deprecation field, and
 *     a manifest cannot be annotated after the fact without changing its digest.
 * A version whose root is not one of its own manifest or index files, or whose media type is not
 * a manifest type the host may serve, is left out rather than guessed at.
 */

import type {
  PackageVersion,
  RegistryPackage,
  RenderedObject,
} from "../materialise.js";

/** The media types a manifest answer may carry: exactly the four on `REGISTRY_HOST_TYPES`. */
export const OCI_MANIFEST_TYPES: ReadonlySet<string> = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);

/** The file types (`release_packages.files_json`) that are manifests or indexes. */
export const OCI_MANIFEST_FILE_TYPES: ReadonlySet<string> = new Set([
  "oci-manifest",
  "oci-index",
]);

/** An OCI tag (distribution-spec): `[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}`. */
export const OCI_TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** A sha256 digest, the only algorithm this registry stores. */
export const OCI_DIGEST_RE = /^sha256:([0-9a-f]{64})$/;

/** A repository path under the owner (`@polaris-key/manifest`'s OCI name grammar). */
export const OCI_REPOSITORY_RE =
  /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*)*$/;

/** The object keys of one repository, relative to the owner's prefix. */
export function tagsKey(repository: string): string {
  return `${repository}/_tags.json`;
}
export function refsKey(repository: string): string {
  return `${repository}/_refs.json`;
}

/** Where one tag points. */
export interface OciRef {
  readonly digest: string;
  readonly mediaType: string;
  readonly size: number;
}

/** The body of `_tags.json`. */
export interface OciTagList {
  readonly name: string;
  readonly tags: readonly string[];
}

/** The pointer a version's tag gets, or `null` when its root cannot be served. */
function versionRef(v: PackageVersion): OciRef | null {
  const root = typeof v.metadata.root === "string" ? v.metadata.root : "";
  const hex = OCI_DIGEST_RE.exec(root)?.[1];
  if (hex === undefined) return null;
  const file = v.files.find(
    (f) => f.sha256 === hex && OCI_MANIFEST_FILE_TYPES.has(f.type),
  );
  if (!file) return null;
  const mediaType =
    file.mediaType ??
    (typeof v.metadata.mediaType === "string" ? v.metadata.mediaType : "");
  if (!OCI_MANIFEST_TYPES.has(mediaType)) return null;
  return { digest: `sha256:${hex}`, mediaType, size: file.size };
}

/** Code-point order, the lexical order the tag list is specified in. */
function lexical(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Every tag of a package and where it points, in lexical order of tag. */
export function ociRefs(pkg: RegistryPackage): Record<string, OciRef> {
  const refs = new Map<string, OciRef>();
  for (const v of pkg.versions) {
    if (v.state === "yanked" || !OCI_TAG_RE.test(v.version)) continue;
    const ref = versionRef(v);
    if (ref) refs.set(v.version, ref);
  }
  const versionTags = new Set(refs.keys());
  for (const [tag, version] of Object.entries(pkg.tags)) {
    if (!OCI_TAG_RE.test(tag) || versionTags.has(tag)) continue;
    const ref = versionTags.has(version) ? refs.get(version) : undefined;
    if (ref) refs.set(tag, ref);
  }
  const out: Record<string, OciRef> = {};
  for (const tag of [...refs.keys()].sort(lexical)) out[tag] = refs.get(tag)!;
  return out;
}

/** The repository's full name as clients spell it: `<owner>/<repository>`. */
export function ociName(pkg: RegistryPackage): string {
  return `${pkg.product}/${pkg.name}`;
}

/** The two documents of one repository (the `RegistryRenderer`'s output). */
export function renderOci(pkg: RegistryPackage): RenderedObject[] {
  const refs = ociRefs(pkg);
  const tags: OciTagList = { name: ociName(pkg), tags: Object.keys(refs) };
  return [
    {
      key: tagsKey(pkg.name),
      body: `${JSON.stringify(tags)}\n`,
      contentType: "application/json",
    },
    {
      key: refsKey(pkg.name),
      body: `${JSON.stringify(refs)}\n`,
      contentType: "application/json",
    },
  ];
}
