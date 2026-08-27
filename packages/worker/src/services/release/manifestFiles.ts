/**
 * Where a product's manifest lives in its repo (wire contract v3 §8).
 *
 * ONE directory: `.pkey/`. The interim suite design's `.polaris/` rename was withdrawn by
 * Amendment A1 along with the rest of the naming layer, and the dual-read it needed went with
 * it — two candidate directories per document meant every miss cost a second GitHub round trip
 * and made "which file is actually live" a question you had to trace through a fallback chain.
 *
 * Extension order inside the directory is a pure format preference: JSON beats YAML beats YML,
 * per document independently, so a repo may hold `product.yaml` next to `schema.json`.
 */

/** The manifest documents a repo may carry. */
export type ManifestFileName = "schema" | "product" | "release";

/** The manifest directory. */
export const MANIFEST_DIR = ".pkey";

/** Extensions, most-preferred first (JSON beats YAML). */
const EXTENSIONS = ["json", "yaml", "yml"] as const;

/** Every candidate path for one manifest document, in the order they should be tried. */
export function manifestPaths(name: ManifestFileName): string[] {
  return EXTENSIONS.map((ext) => `${MANIFEST_DIR}/${name}.${ext}`);
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
 * Matches the directory itself as well as anything under it: GitHub reports a whole-directory
 * rename as the bare path, and a delivery that (re)creates `.pkey/` must trigger a resync.
 */
export function isManifestPath(path: string): boolean {
  return path === MANIFEST_DIR || path.startsWith(`${MANIFEST_DIR}/`);
}
