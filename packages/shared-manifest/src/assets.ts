/**
 * Asset refs (HA-04, notes/S-20 decision 5): how a `.pkey/` document names an image Polaris Key
 * hosts. One grammar serves `.pkey/product` `presentation.icon` and the `.pkey/distribution`
 * listing's `icon`, `header` and `screenshots[]`.
 *
 * A ref is either a string or an object `{ src, sha256? }`, and `src` is one of:
 *
 *   - an **https URL** (`kind: "url"`): the listing's existing URL rules, at most 2048
 *     characters, https only;
 *   - a **repo path** (`kind: "repo"`): a relative POSIX path into the product's own repository,
 *     resolved at the commit being synced (HA-05). An optional leading `./`, no leading `/`, no
 *     `.` or `..` segment, at most 512 characters, and an image extension
 *     (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.avif`, lower case).
 *
 * `sha256` (64 lower-case hex digits) pins the bytes: the ingest refuses a pull whose hash
 * differs. Nothing here fetches anything; the validator checks the spelling and the normaliser
 * records the kind, so the Worker can route each ref to the right puller.
 *
 * This module emits no validation codes itself. `index.ts` and `distribution.ts` call
 * `assetRefProblem` and add the code, so the schema-parity sweep (AGENTS rule 9) sees every code
 * in the two files it reads. The pattern strings are exported so the parity suite can check that
 * the JSON Schemas spell them identically.
 */

/** The image extensions a repo path may end in (lower case only). */
export const ASSET_REF_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "avif",
] as const;

/** The longest repo path a ref may name. */
export const MAX_ASSET_REPO_PATH = 512;

/** The longest https URL a ref may name (the listing's URL bound). */
export const MAX_ASSET_URL = 2048;

/**
 * A repo path: an optional `./`, then `/`-separated segments of `[A-Za-z0-9._~@+-]`, none of
 * them `.` or `..`, ending in an image extension. The character class already rules out a
 * leading `/`, an empty segment, a backslash, a colon (so no scheme) and whitespace.
 */
export const ASSET_REPO_PATH_PATTERN =
  "^(?:\\./)?(?!(?:[^/]*/)*\\.{1,2}(?:/|$))[A-Za-z0-9._~@+-]+(?:/[A-Za-z0-9._~@+-]+)*\\.(?:png|jpe?g|webp|gif|avif)$";

/** An https URL, spelled as the listing's other URL fields are. */
export const ASSET_URL_PATTERN = "^https://[^\\s\\u0000-\\u001f\\u007f]+$";

/** The optional content hash: SHA-256 as 64 lower-case hex digits. */
export const ASSET_SHA256_PATTERN = "^[0-9a-f]{64}$";

/** A `#rrggbb` colour (`presentation.accent`, `presentation.accentDark`, `listing.tintColor`). */
export const HEX_COLOUR_PATTERN = "^#[0-9A-Fa-f]{6}$";

const REPO_PATH_RE = new RegExp(ASSET_REPO_PATH_PATTERN);
const URL_RE = new RegExp(ASSET_URL_PATTERN);
const SHA256_RE = new RegExp(ASSET_SHA256_PATTERN);
const HEX_COLOUR_RE = new RegExp(HEX_COLOUR_PATTERN);

/** Where an asset ref's bytes come from. */
export type AssetRefKind = "url" | "repo";

/** An asset ref, normalised: the kind is decided once, here, and never re-derived downstream. */
export interface ManifestAssetRef {
  kind: AssetRefKind;
  /** The URL as written, or the repo path without a leading `./`. */
  src: string;
  /** The pinned SHA-256, when the manifest declares one. */
  sha256?: string;
}

/** Is `v` an https URL a ref may name? */
export function isAssetUrl(v: unknown): v is string {
  if (typeof v !== "string" || v.length > MAX_ASSET_URL || !URL_RE.test(v))
    return false;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}

/** Is `v` a repo path a ref may name? */
export function isAssetRepoPath(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length <= MAX_ASSET_REPO_PATH &&
    REPO_PATH_RE.test(v)
  );
}

/** Is `v` a `#rrggbb` colour? */
export function isHexColour(v: unknown): v is string {
  return typeof v === "string" && HEX_COLOUR_RE.test(v);
}

function srcKind(v: unknown): AssetRefKind | null {
  if (isAssetUrl(v)) return "url";
  if (isAssetRepoPath(v)) return "repo";
  return null;
}

const SRC_RULE = `an https URL of at most ${MAX_ASSET_URL} characters, or a relative repo path of at most ${MAX_ASSET_REPO_PATH} characters with no leading / and no . or .. segment, ending in .${ASSET_REF_EXTENSIONS.join(", .")}`;

/** What is wrong with an asset ref, or `null` when it is one. The message completes "<field> …". */
export function assetRefProblem(v: unknown): string | null {
  if (typeof v === "string") {
    return srcKind(v) ? null : `must be ${SRC_RULE}`;
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    return `must be a string or an object { src, sha256 }`;
  }
  const r = v as Record<string, unknown>;
  const extra = Object.keys(r).filter((k) => k !== "src" && k !== "sha256");
  if (extra.length) return `has unknown keys (${extra.join(", ")})`;
  if (srcKind(r.src) === null) return `src must be ${SRC_RULE}`;
  if (
    r.sha256 !== undefined &&
    (typeof r.sha256 !== "string" || !SHA256_RE.test(r.sha256))
  )
    return "sha256 must be 64 lower-case hex digits";
  return null;
}

/** The normalised ref, or `null` when `v` is not a valid one. */
export function normalizeAssetRef(v: unknown): ManifestAssetRef | null {
  if (assetRefProblem(v) !== null) return null;
  const raw =
    typeof v === "string" ? { src: v } : (v as Record<string, unknown>);
  const src = raw.src as string;
  const kind = srcKind(src)!;
  const out: ManifestAssetRef = {
    kind,
    src: kind === "repo" && src.startsWith("./") ? src.slice(2) : src,
  };
  if (typeof raw.sha256 === "string") out.sha256 = raw.sha256;
  return out;
}

/**
 * The https URL an asset ref points at, or `undefined`. It accepts a normalised ref (only
 * `kind: "url"` has a URL; a repo path has none until HA-05 hosts the bytes) and, for listing
 * rows stored before HA-04, a bare URL string.
 */
export function assetRefUrl(v: unknown): string | undefined {
  if (isAssetUrl(v)) return v;
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  return r.kind === "url" && isAssetUrl(r.src) ? r.src : undefined;
}
