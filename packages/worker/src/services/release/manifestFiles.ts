/**
 * Where a product's manifest lives in its repo — and the `.pkey/` → `.polaris/` dual-read
 * (wire contract v3 §8, plan §R3).
 *
 * ── THE RULE: PREFER-NEW, PER FILE ──────────────────────────────────────────────────────────
 *
 * For each of the three documents independently, `.polaris/` is searched first and `.pkey/`
 * second. A repo mid-migration — `.polaris/product.yaml` written, `.pkey/schema.json` not moved
 * yet — resolves to the new product document and the old catalog, which is what a human doing
 * this one file at a time expects.
 *
 * The alternative (pick a directory, then read all three from it) was rejected: it makes the
 * first `.polaris/` file a cliff, where creating one new file silently stops three old ones
 * from being read and a product resyncs to a manifest that is missing its catalog.
 *
 * Extension order inside a directory is unchanged and stays INSIDE the directory loop, so
 * `.polaris/product.yml` beats `.pkey/product.json`. The directory is the migration signal;
 * the extension is only a format preference.
 *
 * `.pkey/` is a permanent fallback, not a deprecation window — every repo that ever adopted
 * Polaris Key has one, and nothing here needs it to go away.
 */

/** The manifest documents a repo may carry. */
export type ManifestFileName = "schema" | "product" | "release";

/** Manifest directories, most-preferred first. */
export const MANIFEST_DIRS = [".polaris", ".pkey"] as const;

/** Extensions, most-preferred first (JSON beats YAML). */
const EXTENSIONS = ["json", "yaml", "yml"] as const;

/** Every candidate path for one manifest document, in the order they should be tried. */
export function manifestPaths(name: ManifestFileName): string[] {
  return MANIFEST_DIRS.flatMap((dir) =>
    EXTENSIONS.map((ext) => `${dir}/${name}.${ext}`),
  );
}

/** The full candidate table, in the shape the ingest paths iterate. */
export const MANIFEST_FILES: Record<ManifestFileName, string[]> = {
  schema: manifestPaths("schema"),
  product: manifestPaths("product"),
  release: manifestPaths("release"),
};

/**
 * Whether a changed repo path could have changed a manifest — the webhook's cheap pre-filter.
 *
 * Matches the directory itself as well as anything under it, for both names: GitHub reports a
 * whole-directory rename as the bare path, and a delivery that renamed `.pkey/` to `.polaris/`
 * is precisely the one that must trigger a resync.
 */
export function isManifestPath(path: string): boolean {
  return MANIFEST_DIRS.some(
    (dir) => path === dir || path.startsWith(`${dir}/`),
  );
}
