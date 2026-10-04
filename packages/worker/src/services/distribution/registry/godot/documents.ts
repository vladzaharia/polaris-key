/**
 * The Godot feed's documents (F-09, plans/F-01.md §6.8): pure functions from a package (Release's
 * truth, read through `releaseCatalog`) and the feed's settings to the JSON both editor API shapes
 * and GodotEnv read. No I/O here; `render.ts` writes the per-package documents into R2 and
 * `routes.ts` serves them, and composes the owner-wide lists (the two searches, `configure` and
 * `index.json`) from the same functions.
 *
 * THE TWO EDITOR SHAPES (the SDK supports Godot 4.4 to 4.7, so the feed serves both):
 *   - Godot ≤ 4.6 reads the Asset Library API (godotengine/godot-asset-library `API.md`):
 *     `configure`, `asset?…` and `asset/<id>`. The editor's C++ takes `asset_id`, `author_id`
 *     and `category_id` as 32-bit ints and compares `download_hash` (SHA-256) against the zip it
 *     downloaded whenever the field is non-empty; ours always is. Every value is a string, as the
 *     official library sends them, because the editor keys its category map by the JSON value.
 *   - Godot 4.7+ reads the Asset Store API (store.godotengine.org/api/v1, OpenAPI 1.1.0):
 *     the root, `tags/`, `licenses/`, `search/query/`, `assets/<publisher>/<asset>/` and
 *     `releases/<publisher>/<asset>/`. It verifies NO hash (the editor hands an empty sha256 to
 *     `add_release`): a 4.7+ install relies on TLS alone (THREAT-MODEL §3).
 *
 * YANK, DEPRECATE AND CHANNELS (plans/F-01.md §6.7, S-12 §8.2): a yanked version is removed from
 * every listing (both searches, both asset documents, the release list and `index.json`); its
 * content-addressed bytes stay fetchable, as every byte URL on the host is immutable. A package
 * whose every version is yanked drops out of the lists, and its asset documents are the not-found.
 * Godot has no deprecation notion: a deprecated version stays listed and its message leads the
 * description (≤ 4.6, when it is the shown version), the release `notes` (4.7+) and the
 * `deprecated` field of `index.json`. The version a listing shows is the `latest` tag (the
 * `stable` channel's head) while it is listed, else the newest listed version. A 4.7+ release is
 * `stable` when it is that version or carries no SemVer pre-release suffix.
 *
 * TENANT TEXT. `plugin.cfg`'s name, author and description are the publisher's. They only ever
 * leave as JSON string values; `body_bbcode` escapes BBCode's brackets and `body_html` escapes
 * HTML, so the 4.7 editor renders them as text (THREAT-MODEL §3, "Tenant-supplied text").
 */

import type {
  PackageFile,
  PackageVersion,
  RegistryPackage,
} from "../materialise.js";

/** The Asset Library categories (the official library's ids, so a familiar filter works). */
export const GODOT_CATEGORIES: ReadonlyArray<{
  readonly id: string;
  readonly name: string;
  readonly type: "0" | "1";
}> = [
  { id: "1", name: "2D Tools", type: "0" },
  { id: "2", name: "3D Tools", type: "0" },
  { id: "3", name: "Shaders", type: "0" },
  { id: "4", name: "Materials", type: "0" },
  { id: "5", name: "Tools", type: "0" },
  { id: "6", name: "Scripts", type: "0" },
  { id: "7", name: "Misc", type: "0" },
  { id: "8", name: "Templates", type: "1" },
  { id: "9", name: "Projects", type: "1" },
  { id: "10", name: "Demos", type: "1" },
];

export const SUPPORT_LEVELS = ["official", "community", "testing"] as const;
export type SupportLevel = (typeof SUPPORT_LEVELS)[number];

/** The defaults a feed with no Godot extensions gets. */
export const GODOT_DEFAULTS = {
  categoryId: "5",
  supportLevel: "community" as SupportLevel,
  license: "Unspecified",
};

/** The feed, as the Godot documents need it (`dist_registry_feeds` namespace + `ext_json`). */
export interface GodotFeedView {
  /** The product slug: the `<owner>` segment of every URL. */
  readonly owner: string;
  /** `namespace.publisher`: the 4.7 store path's publisher and the ≤ 4.6 default author. */
  readonly publisher: string;
  /** `ext.categoryId`: an addon category id of `GODOT_CATEGORIES` (default Tools). */
  readonly categoryId: string;
  /** `ext.supportLevel` (default `community`). `featured` reads as `official`, as the API does. */
  readonly supportLevel: SupportLevel;
  /** `ext.license`: ≤ 4.6 `cost` and 4.7 `license_type` (default `Unspecified`). */
  readonly license: string;
  /** `ext.minGodotVersion` (`4.4`, `4.4.1`), or null: no lower bound is advertised. */
  readonly minGodotVersion: string | null;
  /** `PKG_ORIGIN`'s origin, for absolute URLs. */
  readonly origin: string;
}

const PUBLISHER = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const GODOT_VERSION = /^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$/;

/**
 * The view of a feed's settings, or `null` when the feed has no usable publisher (no Godot
 * document can be built without one; ingest refuses a package then too). Unknown or malformed
 * extensions fall back to the defaults.
 */
export function godotFeedView(
  owner: string,
  origin: string,
  feed: {
    readonly namespace: Readonly<Record<string, unknown>>;
    readonly ext: Readonly<Record<string, unknown>>;
  } | null,
): GodotFeedView | null {
  if (!feed) return null;
  const publisher = feed.namespace.publisher;
  if (typeof publisher !== "string" || !PUBLISHER.test(publisher)) return null;
  const ext = feed.ext;
  const category =
    typeof ext.categoryId === "string" || typeof ext.categoryId === "number"
      ? String(ext.categoryId)
      : GODOT_DEFAULTS.categoryId;
  const support =
    ext.supportLevel === "featured" ? "official" : ext.supportLevel;
  const license =
    typeof ext.license === "string" &&
    ext.license.trim() !== "" &&
    ext.license.length <= 64
      ? ext.license.trim()
      : GODOT_DEFAULTS.license;
  return {
    owner,
    publisher,
    categoryId: GODOT_CATEGORIES.some(
      (c) => c.id === category && c.type === "0",
    )
      ? category
      : GODOT_DEFAULTS.categoryId,
    supportLevel: (SUPPORT_LEVELS as readonly unknown[]).includes(support)
      ? (support as SupportLevel)
      : GODOT_DEFAULTS.supportLevel,
    license,
    minGodotVersion:
      typeof ext.minGodotVersion === "string" &&
      GODOT_VERSION.test(ext.minGodotVersion)
        ? ext.minGodotVersion
        : null,
    origin,
  };
}

// ── Identity and URLs ────────────────────────────────────────────────────────────────────────

/**
 * The ≤ 4.6 numeric id of a package: FNV-1a over its deliverable id, folded into 1…2^31-1 (the
 * editor holds it in a C++ `int`). Stable for the package's life; a collision inside one owner's
 * feed is refused by `assetIdsOf`.
 */
export function legacyAssetId(deliverableId: string): string {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(deliverableId)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return String(h & 0x7fffffff || 1);
}

/** The ≤ 4.6 author id: the same fold over the publisher. */
export function legacyAuthorId(publisher: string): string {
  return legacyAssetId(`publisher:${publisher}`);
}

/** Every package's legacy id, dropping any two that collide (neither is reachable by id then). */
export function assetIdsOf(
  deliverableIds: readonly string[],
): Map<string, string> {
  const byId = new Map<string, string[]>();
  for (const d of deliverableIds) {
    const id = legacyAssetId(d);
    byId.set(id, [...(byId.get(id) ?? []), d]);
  }
  const out = new Map<string, string>();
  for (const [id, ds] of byId) if (ds.length === 1) out.set(ds[0]!, id);
  return out;
}

function base(view: GodotFeedView): string {
  return `${view.origin}/godot/${view.owner}`;
}

/** A zip's content-addressed URL: `files/<sha256>/<name>`. */
export function zipUrl(view: GodotFeedView, file: PackageFile): string {
  const name = encodeURIComponent(file.name).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${base(view)}/files/${file.sha256}/${name}`;
}

/** An icon's content-addressed URL: `icons/<sha256>.png`. */
export function iconUrl(view: GodotFeedView, file: PackageFile): string {
  return `${base(view)}/icons/${file.sha256}.png`;
}

export function storeAssetUrl(view: GodotFeedView, slug: string): string {
  return `${base(view)}/store/api/v1/assets/${view.publisher}/${slug}/`;
}

// ── Versions ─────────────────────────────────────────────────────────────────────────────────

export function zipOf(v: PackageVersion): PackageFile | null {
  return v.files.find((f) => f.type === "godot-zip") ?? null;
}

export function iconOf(v: PackageVersion): PackageFile | null {
  return v.files.find((f) => f.type === "godot-icon") ?? null;
}

/** The versions a listing may show: not yanked and with a zip, NEWEST publication first. */
export function listedVersions(pkg: RegistryPackage): PackageVersion[] {
  return pkg.versions
    .filter((v) => v.state !== "yanked" && zipOf(v) !== null)
    .reverse();
}

/** The version a listing shows: the `latest` tag while listed, else the newest listed one. */
export function shownVersion(pkg: RegistryPackage): PackageVersion | null {
  const listed = listedVersions(pkg);
  const latest = pkg.tags.latest;
  return listed.find((v) => v.version === latest) ?? listed[0] ?? null;
}

/** A SemVer pre-release (`1.2.0-beta.1`): everything after the first `-` of the core. */
function isPrerelease(version: string): boolean {
  return /^[0-9]+(?:\.[0-9]+)*-/.test(version);
}

export function isStable(pkg: RegistryPackage, v: PackageVersion): boolean {
  return v.version === pkg.tags.latest || !isPrerelease(v.version);
}

/** The 1-based position of a version in publication order (the ≤ 4.6 edit counter, the 4.7 id). */
function ordinal(pkg: RegistryPackage, v: PackageVersion): number {
  return pkg.versions.indexOf(v) + 1;
}

function str(
  meta: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const v = meta[key];
  return typeof v === "string" && v !== "" ? v : null;
}

/** The display title, author and description `plugin.cfg` gave (fallbacks: the id, the publisher). */
export function presentation(
  pkg: RegistryPackage,
  v: PackageVersion,
  view: GodotFeedView,
): { title: string; author: string; description: string } {
  return {
    title: str(v.metadata, "displayName") ?? pkg.name,
    author: str(v.metadata, "author") ?? view.publisher,
    description: str(v.metadata, "description") ?? "",
  };
}

function deprecationNote(v: PackageVersion): string {
  if (v.state !== "deprecated") return "";
  return `Deprecated${v.stateMessage ? `: ${v.stateMessage}` : "."}`;
}

/** `YYYY-MM-DD HH:MM:SS`, UTC (the Asset Library's `modify_date`). */
function legacyDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
}

/** `YYYY-MM-DDTHH:MM:SS`, UTC (the Asset Store's date-times). */
function isoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 19);
}

/** Text as BBCode that renders literally: `[` and `]` become `[lb]` and `[rb]`. */
export function escapeBbcode(text: string): string {
  return text.replace(/[[\]]/g, (c) => (c === "[" ? "[lb]" : "[rb]"));
}

/** Text as HTML that renders literally. */
export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

// ── Godot ≤ 4.6: the Asset Library API ───────────────────────────────────────────────────────

export function legacyCategoryName(id: string): string {
  return GODOT_CATEGORIES.find((c) => c.id === id)?.name ?? "Tools";
}

/** `GET configure?type=…`: the categories of `type` (`addon` when absent, as the API does). */
export function legacyConfigure(type: string | null): {
  categories: Array<{ id: string; name: string; type: string }>;
} {
  const want = type === "project" ? ["1"] : type === "any" ? ["0", "1"] : ["0"];
  return {
    categories: GODOT_CATEGORIES.filter((c) => want.includes(c.type)).map(
      (c) => ({ ...c }),
    ),
  };
}

/** One `asset?…` search result, or `null` when the package has no listed version. */
export function legacySummary(
  pkg: RegistryPackage,
  view: GodotFeedView,
  assetId: string,
): Record<string, string> | null {
  const v = shownVersion(pkg);
  if (!v) return null;
  const p = presentation(pkg, v, view);
  const icon = iconOf(v);
  return {
    asset_id: assetId,
    title: p.title,
    author: p.author,
    author_id: legacyAuthorId(view.publisher),
    category: legacyCategoryName(view.categoryId),
    category_id: view.categoryId,
    godot_version: view.minGodotVersion ?? "4.0",
    rating: "0",
    cost: view.license,
    support_level: view.supportLevel,
    icon_url: icon ? iconUrl(view, icon) : "",
    version: String(ordinal(pkg, v)),
    version_string: v.version,
    modify_date: legacyDate(v.publishedAt),
  };
}

/** `GET asset/<id>`: the shown version, with `download_url` and `download_hash` (SHA-256). */
export function legacyAsset(
  pkg: RegistryPackage,
  view: GodotFeedView,
  assetId: string,
): Record<string, unknown> | null {
  const summary = legacySummary(pkg, view, assetId);
  const v = shownVersion(pkg);
  const zip = v && zipOf(v);
  if (!summary || !v || !zip) return null;
  const p = presentation(pkg, v, view);
  const note = deprecationNote(v);
  return {
    asset_id: summary.asset_id,
    type: "addon",
    title: summary.title,
    author: summary.author,
    author_id: summary.author_id,
    version: summary.version,
    version_string: summary.version_string,
    category: summary.category,
    category_id: summary.category_id,
    godot_version: summary.godot_version,
    rating: summary.rating,
    cost: summary.cost,
    description: note ? `${note}\n\n${p.description}`.trimEnd() : p.description,
    support_level: summary.support_level,
    download_provider: "Custom",
    download_commit: v.version,
    download_hash: zip.sha256,
    browse_url: storeAssetUrl(view, pkg.name),
    issues_url: "",
    icon_url: summary.icon_url,
    searchable: "1",
    modify_date: summary.modify_date,
    download_url: zipUrl(view, zip),
    previews: [],
  };
}

/** A Godot version as `[major, minor, patch]`, or null. */
export function parseGodotVersion(
  s: string | null | undefined,
): number[] | null {
  if (!s) return null;
  const m = /^(\d{1,2})(?:\.(\d{1,2}))?(?:\.(\d{1,2}))?/.exec(s.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** Does an editor of `requested` accept the feed (same major, at or above `minGodotVersion`)? */
export function compatible(
  view: GodotFeedView,
  requested: string | null,
): boolean {
  const want = parseGodotVersion(requested);
  if (!want) return true;
  const min = parseGodotVersion(view.minGodotVersion) ?? [4, 0, 0];
  if (want[0] !== min[0]) return false;
  for (let i = 1; i < 3; i++) {
    if (want[i]! > min[i]!) return true;
    if (want[i]! < min[i]!) return false;
  }
  return true;
}

export interface LegacyQuery {
  readonly type: string | null;
  readonly category: string | null;
  readonly support: string | null;
  readonly filter: string | null;
  readonly user: string | null;
  readonly cost: string | null;
  readonly godotVersion: string | null;
  readonly maxResults: string | null;
  readonly page: string | null;
  readonly offset: string | null;
  readonly sort: string | null;
  readonly reverse: boolean;
}

/** The query names the ≤ 4.6 search reads (its cache key). */
export const LEGACY_QUERY_NAMES = [
  "type",
  "category",
  "support",
  "filter",
  "user",
  "cost",
  "godot_version",
  "max_results",
  "page",
  "offset",
  "sort",
  "reverse",
] as const;

export function legacyQueryOf(params: URLSearchParams): LegacyQuery {
  return {
    type: params.get("type"),
    category: params.get("category"),
    support: params.get("support"),
    filter: params.get("filter"),
    user: params.get("user"),
    cost: params.get("cost"),
    godotVersion: params.get("godot_version"),
    maxResults: params.get("max_results"),
    page: params.get("page"),
    offset: params.get("offset"),
    sort: params.get("sort"),
    reverse: params.has("reverse"),
  };
}

function boundedInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === null || !/^\d{1,9}$/.test(raw.trim())) return fallback;
  return Math.min(max, Math.max(min, Number(raw.trim())));
}

/** A package with its legacy id, as the searches see it. */
export interface ListedPackage {
  readonly pkg: RegistryPackage;
  readonly assetId: string;
}

/**
 * `GET asset?…`: filter the owner's short list in memory, then sort and page it. Supports
 * `type`, `category`, `support` (`+`-joined; `featured` reads as `official`), `filter` (trimmed,
 * case-insensitive over title, author and description), `user`, `cost`, `godot_version`,
 * `max_results` (1…500, default 10), `page` (0-based) or `offset`, `sort` (`updated` default,
 * `name`, `cost`, `rating`) and `reverse`.
 */
export function legacySearch(
  packages: readonly ListedPackage[],
  view: GodotFeedView,
  q: LegacyQuery,
): Record<string, unknown> {
  const support = (q.support ?? "")
    .split(/[ +]/)
    .map((s) => (s === "featured" ? "official" : s))
    .filter((s) => s !== "");
  const filter = (q.filter ?? "").trim().toLowerCase();
  const rows: Array<{ s: Record<string, string>; updated: number }> = [];
  if (q.type !== "project" && compatible(view, q.godotVersion)) {
    for (const { pkg, assetId } of packages) {
      const s = legacySummary(pkg, view, assetId);
      const v = shownVersion(pkg);
      if (!s || !v) continue;
      if (q.category && q.category !== "0" && q.category !== s.category_id)
        continue;
      if (support.length && !support.includes(s.support_level!)) continue;
      if (q.user && q.user !== s.author && q.user !== view.publisher) continue;
      if (q.cost && q.cost !== s.cost) continue;
      if (filter) {
        const p = presentation(pkg, v, view);
        const hay = `${p.title}\n${p.author}\n${p.description}\n${pkg.name}`;
        if (!hay.toLowerCase().includes(filter)) continue;
      }
      rows.push({ s, updated: v.publishedAt });
    }
  }
  const sort = q.sort ?? "updated";
  rows.sort((a, b) => {
    if (sort === "name" || sort === "cost") {
      const k = sort === "name" ? "title" : "cost";
      return (
        a.s[k]!.localeCompare(b.s[k]!) ||
        a.s.asset_id!.localeCompare(b.s.asset_id!)
      );
    }
    // `updated` (and `rating`, which every asset here shares): newest first.
    return b.updated - a.updated || a.s.title!.localeCompare(b.s.title!);
  });
  if (q.reverse) rows.reverse();
  const pageLength = boundedInt(q.maxResults, 10, 1, 500);
  const total = rows.length;
  const pages = Math.ceil(total / pageLength);
  const offset =
    q.offset !== null
      ? boundedInt(q.offset, 0, 0, 1_000_000)
      : boundedInt(q.page, 0, 0, 1_000_000) * pageLength;
  return {
    result: rows.slice(offset, offset + pageLength).map((r) => r.s),
    page: Math.floor(offset / pageLength),
    pages,
    page_length: pageLength,
    total_items: total,
    // The ≤ 4.6 editor reads `total` for its pager; the official library sends `total_items`.
    total,
  };
}

// ── Godot 4.7+: the Asset Store API ──────────────────────────────────────────────────────────

/** `GET /` of the store API: the overview the 4.7 editor requests to verify a repository. */
export function storeOverview(): Record<string, string> {
  return {
    version: "1.1.0",
    openapi_spec: "https://store.godotengine.org/api/v1/openapi.json",
    docs_swagger: "https://store.godotengine.org/api/v1/swagger",
    docs_redoc: "https://store.godotengine.org/api/v1/redoc",
  };
}

function publisherData(view: GodotFeedView): Record<string, unknown> {
  return {
    slug: view.publisher,
    name: view.publisher,
    thumbnail: "",
    store_url: `${base(view)}/index.json`,
    verified: false,
  };
}

/** `AssetData`, or `null` when the package has no listed version. */
export function storeAssetData(
  pkg: RegistryPackage,
  view: GodotFeedView,
): Record<string, unknown> | null {
  const v = shownVersion(pkg);
  if (!v) return null;
  const p = presentation(pkg, v, view);
  const icon = iconOf(v);
  return {
    slug: pkg.name,
    publisher: publisherData(view),
    name: p.title,
    type: 0,
    description: p.description,
    price_cent: 0,
    license_type: view.license,
    license_url: "",
    thumbnail: icon ? iconUrl(view, icon) : "",
    reviews_score: 0,
    tags: [],
    store_url: storeAssetUrl(view, pkg.name),
  };
}

/** `GET assets/<publisher>/<asset>/`: `AssetDataDetailed`. */
export function storeAsset(
  pkg: RegistryPackage,
  view: GodotFeedView,
): Record<string, unknown> | null {
  const data = storeAssetData(pkg, view);
  const v = shownVersion(pkg);
  const listed = listedVersions(pkg);
  if (!data || !v) return null;
  const p = presentation(pkg, v, view);
  const note = deprecationNote(v);
  const text = note ? `${note}\n\n${p.description}`.trimEnd() : p.description;
  return {
    ...data,
    body_html: text === "" ? "" : `<p>${escapeHtml(text)}</p>`,
    body_bbcode: escapeBbcode(text),
    donation_text: "",
    donation_url: "",
    source: "",
    featured_thumbnail: "",
    media: [],
    video_id: "",
    created: isoDate(listed[listed.length - 1]!.publishedAt),
    last_updated: isoDate(v.publishedAt),
    featured: false,
    video_playback_url: "",
    video_embed_url: "",
    video_thumbnail_url: "",
  };
}

/**
 * `ReleaseData` for every listed version: the stable releases newest first, then the pre-releases
 * newest first. The 4.7 editor preselects the FIRST release of the list in its install dialog (F-09's
 * editor check: with a beta newest, "Download" installed `1.2.0-beta.1` and labelled it Unstable
 * only in the dropdown), so a stable release leads whenever one is listed.
 */
export function storeReleases(
  pkg: RegistryPackage,
  view: GodotFeedView,
): Array<Record<string, unknown>> {
  const releases = listedVersions(pkg).map((v) => {
    const zip = zipOf(v)!;
    return {
      id: ordinal(pkg, v),
      version: v.version,
      stable: isStable(pkg, v),
      size: Math.round((zip.size / 1_000_000) * 1e6) / 1e6,
      created: isoDate(v.publishedAt).slice(0, 10),
      min_godot_version: view.minGodotVersion,
      max_godot_version: null,
      notes: deprecationNote(v),
      changes_html: "",
      changes_bbcode: "",
      download_url: zipUrl(view, zip),
    };
  });
  return [
    ...releases.filter((r) => r.stable),
    ...releases.filter((r) => !r.stable),
  ];
}

/** `releases/…?stable_only=&compatibility=`, filtered from the rendered list. */
export function filterReleases(
  releases: ReadonlyArray<Record<string, unknown>>,
  view: GodotFeedView,
  stableOnly: boolean,
  compatibility: string | null,
): Array<Record<string, unknown>> {
  if (!compatible(view, compatibility)) return [];
  return releases.filter((r) => !stableOnly || r.stable === true);
}

/** A boolean query value as the store API reads it. */
export function queryFlag(raw: string | null, fallback: boolean): boolean {
  if (raw === null) return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export interface StoreQuery {
  readonly query: string;
  readonly type: string | null;
  readonly featuredOnly: boolean;
  readonly stableOnly: boolean;
  readonly compatibility: string | null;
  readonly sort: string;
  readonly licenses: readonly string[];
  readonly page: number;
  readonly batchSize: number;
}

/** The query names the 4.7 search reads (its cache key). `licenses` repeats, so the key joins
 *  every value (`storeSearchKeyNames` callers use the raw query for it). */
export const STORE_QUERY_NAMES = [
  "query",
  "type",
  "featured_only",
  "require_release",
  "stable_only",
  "compatibility",
  "sort",
  "licenses",
  "page",
  "batch_size",
] as const;

export function storeQueryOf(params: URLSearchParams): StoreQuery {
  return {
    query: params.get("query") ?? "",
    type: params.get("type"),
    featuredOnly: queryFlag(params.get("featured_only"), false),
    stableOnly: queryFlag(params.get("stable_only"), false),
    compatibility: params.get("compatibility"),
    sort: params.get("sort") ?? "relevance",
    licenses: params.getAll("licenses").filter((l) => l !== ""),
    page: boundedInt(params.get("page"), 1, 1, 1_000_000),
    batchSize: boundedInt(params.get("batch_size"), 24, 0, 100),
  };
}

/**
 * `GET search/query/?…`: filter the owner's short list in memory. `query` is split on spaces;
 * a `#tag` term matches nothing (these assets carry no tags), any other term must appear in the
 * name, slug, description or publisher. `type=1` (projects) and `featured_only` match nothing;
 * `stable_only`, `compatibility` and `licenses` filter; `sort` orders by update or creation
 * (`relevance` and the review orders fall back to the name). Paging is `page` and `batch_size`;
 * there is no `scroll` token (`scroll: null`).
 */
export function storeSearch(
  packages: readonly ListedPackage[],
  view: GodotFeedView,
  q: StoreQuery,
): Record<string, unknown> {
  const terms = q.query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t !== "");
  const hits: Array<{
    asset: Record<string, unknown>;
    updated: number;
    created: number;
    name: string;
  }> = [];
  const typeOk = q.type === null || q.type === "" || q.type === "0";
  if (typeOk && !q.featuredOnly && compatible(view, q.compatibility)) {
    for (const { pkg } of packages) {
      const asset = storeAssetData(pkg, view);
      const v = shownVersion(pkg);
      const listed = listedVersions(pkg);
      if (!asset || !v) continue;
      if (q.stableOnly && !listed.some((x) => isStable(pkg, x))) continue;
      if (q.licenses.length && !q.licenses.includes(view.license)) continue;
      const p = presentation(pkg, v, view);
      const hay =
        `${p.title}\n${pkg.name}\n${p.description}\n${view.publisher}`.toLowerCase();
      if (!terms.every((t) => !t.startsWith("#") && hay.includes(t))) continue;
      hits.push({
        asset,
        updated: v.publishedAt,
        created: listed[listed.length - 1]!.publishedAt,
        name: p.title,
      });
    }
  }
  hits.sort((a, b) => {
    switch (q.sort) {
      case "updated_desc":
        return b.updated - a.updated || a.name.localeCompare(b.name);
      case "updated_asc":
        return a.updated - b.updated || a.name.localeCompare(b.name);
      case "created_desc":
        return b.created - a.created || a.name.localeCompare(b.name);
      case "created_asc":
        return a.created - b.created || a.name.localeCompare(b.name);
      default:
        return a.name.localeCompare(b.name);
    }
  });
  const start = (q.page - 1) * q.batchSize;
  return {
    count: String(hits.length),
    hits: hits.slice(start, start + q.batchSize).map((h) => ({
      asset: h.asset,
      highlights: {
        name: null,
        description: null,
        body: null,
        publisher_name: null,
      },
    })),
    tag_filters: [],
    scroll: null,
  };
}

/** `GET licenses/`: the license this feed's listed assets use, with its count. */
export function storeLicenses(
  packages: readonly ListedPackage[],
  view: GodotFeedView,
): Array<{ count: number; type: string }> {
  const count = packages.filter(({ pkg }) => shownVersion(pkg) !== null).length;
  return count ? [{ count, type: view.license }] : [];
}

// ── GodotEnv: index.json ─────────────────────────────────────────────────────────────────────

/** One package's `index.json` entry, or `null` when it has no listed version. */
export function indexEntry(
  pkg: RegistryPackage,
  view: GodotFeedView,
): Record<string, unknown> | null {
  const shown = shownVersion(pkg);
  if (!shown) return null;
  const p = presentation(pkg, shown, view);
  const listed = new Set(listedVersions(pkg).map((v) => v.version));
  const tags: Record<string, string> = {};
  for (const [tag, version] of Object.entries(pkg.tags).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  ))
    if (listed.has(version)) tags[tag] = version;
  const versions = listedVersions(pkg).map((v) => {
    const zip = zipOf(v)!;
    const icon = iconOf(v);
    const note = deprecationNote(v);
    return {
      version: v.version,
      stable: isStable(pkg, v),
      url: zipUrl(view, zip),
      sha256: zip.sha256,
      size: zip.size,
      ...(icon ? { icon: iconUrl(view, icon) } : {}),
      publishedAt: `${isoDate(v.publishedAt)}Z`,
      ...(note ? { deprecated: v.stateMessage ?? "" } : {}),
    };
  });
  return {
    name: pkg.name,
    title: p.title,
    author: p.author,
    description: p.description,
    latest: shown.version,
    tags,
    versions,
    // Paste into GodotEnv's `addons.json` under `addons` (the key must be the addon id).
    godotenv: {
      [pkg.name]: {
        url: zipUrl(view, zipOf(shown)!),
        source: "zip",
        subfolder: `addons/${pkg.name}`,
      },
    },
  };
}

/** `GET index.json`: every listed package of the owner's feed, by name. */
export function godotIndex(
  packages: readonly ListedPackage[],
  view: GodotFeedView,
): Record<string, unknown> {
  return {
    format: "pkey-godot-index/1",
    owner: view.owner,
    publisher: view.publisher,
    assetLibrary: `${base(view)}/asset-library/api`,
    assetStore: `${base(view)}/store/api/v1`,
    packages: [...packages]
      .sort((a, b) =>
        a.pkg.name < b.pkg.name ? -1 : a.pkg.name > b.pkg.name ? 1 : 0,
      )
      .map(({ pkg }) => indexEntry(pkg, view))
      .filter((e): e is Record<string, unknown> => e !== null),
  };
}
