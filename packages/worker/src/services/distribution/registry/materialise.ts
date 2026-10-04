/// <reference types="@cloudflare/workers-types" />
/**
 * Render-on-write index documents (F-02 framework, plans/F-01.md §6.5).
 *
 * Each ecosystem's index documents (npm packuments, PyPI pages, Swift release lists,
 * `maven-metadata.xml`, OCI tag lists, Godot JSON) are rendered from D1 into R2 when a package
 * changes, and served from there. This file is the framework; F-04 to F-09 implement
 * `RegistryRenderer`, each in its own `registry/<ecosystem>/` directory.
 *
 *   - WHERE: `registry/<ecosystem>/<owner>/<key>` in the blob bucket. That prefix is unlocked
 *     and separate from the bucket-locked `blobs/`, `bundles/`, `deltas/` and `gated/`, and
 *     from `staging/` (DEPLOYMENT §3: `registry/` never gets an age lock or lifecycle rule).
 *   - THE STAMP: every object of one render carries `x-pkey-render-stamp`, a hash of the
 *     package's rows, and the render's own record (`.render/<deliverable>.json`, listing its
 *     keys) carries it too. The cron's self-check compares that record's stamp with D1.
 *   - ATOMICITY AND RECOVERY: a render writes every object, then its record. A drain deletes
 *     the queue rows it consumed only after that, matched on `enqueued_at ≤ start`, so a crash
 *     leaves them queued and the next drain retries (`drainRegistry`).
 *   - READ PATH: a missing object is rendered from D1 on read, written back and counted
 *     (`registryCounters.renderMiss`), so a lost object heals itself (`readRegistryObject`).
 *
 * THE TRIGGER is F-03's: Release enqueues into the Core-owned `registry_render_queue` in the
 * same D1 batch as each publish, yank or channel move, and the composition root drains it after
 * the request and on every cron run. Until F-03 creates that table and wires the drain, the
 * drain is reachable only through the `RegistryQueue` interface below, and Release state only
 * through `PackageSource` (F-03 implements it over `releaseCatalog.packageVersions`).
 */

import type {
  RegistryEcosystem,
  RegistryRoute,
} from "../../../core/registryHost.js";

/** The R2 prefix every rendered object lives under. */
export const REGISTRY_PREFIX = "registry/";

/** R2 custom metadata: the render stamp, the body's type and its SHA-256. */
export const RENDER_STAMP_META = "x-pkey-render-stamp";
export const CONTENT_TYPE_META = "x-pkey-content-type";
export const SHA256_META = "x-pkey-sha256";

/** One file of a package version (`release_packages.files_json`, plans/F-01.md §6.3). */
export interface PackageFile {
  readonly name: string;
  readonly type: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType?: string;
  readonly classifier?: string;
  readonly extension?: string;
  readonly sha1?: string;
  readonly sha512?: string;
  readonly md5?: string;
}

/** One published version of a package. Never deleted: a yank changes `state`. */
export interface PackageVersion {
  readonly version: string;
  readonly state: "live" | "yanked" | "deprecated";
  readonly stateMessage: string | null;
  readonly files: readonly PackageFile[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly publishedAt: number;
}

/** A package as a renderer sees it: every version, and the tags its channels map to
 *  (`stable` → `latest`, any other channel → a tag of its own name). */
export interface RegistryPackage {
  readonly product: string;
  readonly ecosystem: RegistryEcosystem;
  readonly deliverableId: string;
  readonly name: string;
  readonly nameNorm: string;
  readonly versions: readonly PackageVersion[];
  readonly tags: Readonly<Record<string, string>>;
}

/** One object a renderer produces, under `registry/<ecosystem>/<owner>/`. */
export interface RenderedObject {
  /** Relative to the owner's prefix: no leading `/`, no empty, `.` or `..` segment. */
  readonly key: string;
  readonly body: string | Uint8Array;
  /** A type on `REGISTRY_HOST_TYPES`, or `PYPI_HTML_TYPE` for F-05's HTML page. */
  readonly contentType: string;
}

/**
 * The feed settings a renderer may read (F-09): the feed's namespace and per-ecosystem
 * extensions (`dist_registry_feeds.namespace_json` / `ext_json`). Godot's documents carry the
 * publisher and the category, which live there, not in the package rows.
 */
export interface RenderFeed {
  readonly namespace: Readonly<Record<string, unknown>>;
  readonly ext: Readonly<Record<string, unknown>>;
}

/** What a renderer needs besides the package. */
export interface RenderContext {
  /** `PKG_ORIGIN`'s origin, for absolute URLs (npm `dist.tarball`). */
  readonly origin: string;
  /**
   * The feed's settings, when the caller supplied a `MaterialiseDeps.feed` source (`null`: the
   * feed has no row). Absent for a caller that does not; a renderer that needs it renders
   * nothing then, and the read path's freshness check renders it again with the settings.
   */
  readonly feed?: RenderFeed | null;
}

/** One ecosystem's renderer and routes (F-04 to F-09). */
export interface RegistryRenderer {
  readonly ecosystem: RegistryEcosystem;
  render(
    pkg: RegistryPackage,
    ctx: RenderContext,
  ): readonly RenderedObject[] | Promise<readonly RenderedObject[]>;
  readonly routes: readonly RegistryRoute[];
}

/** Release's package state, read-only (F-03: `releaseCatalog.packageVersions`). */
export interface PackageSource {
  /** One package by its deliverable, or `null` when it is not a package of `product`. */
  package(
    product: string,
    deliverableId: string,
  ): Promise<RegistryPackage | null>;
}

/** Everything a render touches. */
export interface MaterialiseDeps {
  readonly bucket: R2Bucket;
  readonly renderers: ReadonlyMap<RegistryEcosystem, RegistryRenderer>;
  readonly source: PackageSource;
  readonly origin: string;
  /**
   * Optional (F-09): the feed settings a render reads (`RenderContext.feed`). When given, they
   * are part of the render stamp too, so a settings change makes the stored render stale.
   */
  readonly feed?: (
    product: string,
    ecosystem: RegistryEcosystem,
  ) => Promise<RenderFeed | null>;
}

/** Per-isolate counters (`registry.render_miss`). No request data. */
export const registryCounters = { renderMiss: 0 };

const SEGMENT = /^[A-Za-z0-9@%+_.~:=-]+$/;

/** A relative object key a renderer may write, checked segment by segment. */
export function isRenderKey(key: string): boolean {
  if (key === "" || key.length > 900) return false;
  return key
    .split("/")
    .every((s) => s !== "." && s !== ".." && SEGMENT.test(s));
}

/** The R2 key of `key` in `owner`'s `ecosystem` feed; throws on a key a renderer may not use. */
export function registryObjectKey(
  ecosystem: RegistryEcosystem,
  owner: string,
  key: string,
): string {
  if (!isRenderKey(key) || !SEGMENT.test(owner))
    throw new Error("registry: invalid object key");
  return `${REGISTRY_PREFIX}${ecosystem}/${owner}/${key}`;
}

/** The R2 key of one package's render record. */
export function renderRecordKey(
  ecosystem: RegistryEcosystem,
  owner: string,
  deliverableId: string,
): string {
  return registryObjectKey(ecosystem, owner, `.render/${deliverableId}.json`);
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** JSON with object keys sorted at every level, so equal state hashes equally. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The render stamp of a package: a hash of everything a renderer can see — the package, and the
 * feed settings when the render was given them (`feed` omitted hashes the package alone, as
 * before F-09).
 */
export async function renderStamp(
  pkg: RegistryPackage,
  feed?: RenderFeed | null,
): Promise<string> {
  const seen = feed === undefined ? pkg : { package: pkg, feed };
  return (await sha256Hex(canonical(seen))).slice(0, 32);
}

/** The feed settings `deps` supplies for `pkg`, or `undefined` when it supplies none. */
async function feedFor(
  deps: MaterialiseDeps,
  product: string,
  ecosystem: RegistryEcosystem,
): Promise<RenderFeed | null | undefined> {
  return deps.feed ? deps.feed(product, ecosystem) : undefined;
}

export type MaterialiseResult =
  | {
      readonly status: "rendered";
      readonly stamp: string;
      readonly keys: readonly string[];
    }
  | { readonly status: "absent" }
  | { readonly status: "no-renderer" };

/**
 * Render one package into R2: every object, then the render record. `absent` when the
 * deliverable is not a package of `product` (nothing is written); `no-renderer` when its
 * ecosystem has no renderer in this build.
 */
export async function materialise(
  deps: MaterialiseDeps,
  product: string,
  deliverableId: string,
): Promise<MaterialiseResult> {
  const pkg = await deps.source.package(product, deliverableId);
  if (pkg === null) return { status: "absent" };
  return renderPackage(deps, pkg, await feedFor(deps, product, pkg.ecosystem));
}

/** Render one loaded package (and the feed settings it was read with) into R2. */
async function renderPackage(
  deps: MaterialiseDeps,
  pkg: RegistryPackage,
  feed: RenderFeed | null | undefined,
): Promise<MaterialiseResult> {
  const product = pkg.product;
  const deliverableId = pkg.deliverableId;
  const renderer = deps.renderers.get(pkg.ecosystem);
  if (!renderer) return { status: "no-renderer" };
  const stamp = await renderStamp(pkg, feed);
  const objects = await renderer.render(pkg, {
    origin: deps.origin,
    ...(feed !== undefined ? { feed } : {}),
  });
  const keys: string[] = [];
  for (const obj of objects) {
    const key = registryObjectKey(pkg.ecosystem, product, obj.key);
    const bytes =
      typeof obj.body === "string"
        ? new TextEncoder().encode(obj.body)
        : obj.body;
    const sha256 = await sha256Hex(bytes);
    await deps.bucket.put(key, bytes, {
      sha256,
      httpMetadata: { contentType: obj.contentType },
      customMetadata: {
        [RENDER_STAMP_META]: stamp,
        [CONTENT_TYPE_META]: obj.contentType,
        [SHA256_META]: sha256,
      },
    });
    keys.push(key);
  }
  await deps.bucket.put(
    renderRecordKey(pkg.ecosystem, product, deliverableId),
    JSON.stringify({ stamp, keys }),
    {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { [RENDER_STAMP_META]: stamp },
    },
  );
  return { status: "rendered", stamp, keys };
}

/** Where one object lives, and the package it belongs to (for render-on-miss). */
export interface RegistryObjectRef {
  readonly ecosystem: RegistryEcosystem;
  readonly owner: string;
  readonly key: string;
  readonly deliverableId: string;
}

/**
 * One rendered object, from R2; when it is missing, the package is rendered from D1 first,
 * the miss counted, and the object read again. `null` when the package does not render it.
 */
export async function readRegistryObject(
  deps: MaterialiseDeps,
  ref: RegistryObjectRef,
): Promise<R2ObjectBody | null> {
  const key = registryObjectKey(ref.ecosystem, ref.owner, ref.key);
  const hit = await deps.bucket.get(key);
  if (hit) return hit;
  registryCounters.renderMiss++;
  const result = await materialise(deps, ref.owner, ref.deliverableId);
  if (result.status !== "rendered" || !result.keys.includes(key)) return null;
  return deps.bucket.get(key);
}

/**
 * One rendered object, checked FRESH against D1 (F-09): the package (and its feed settings) are
 * read and stamped, and an object that is missing or carries another stamp is rendered again
 * first and counted as a miss. A route uses it where a stale document must never be served even
 * though no drain has re-rendered it yet. `null` when the package does not render the key.
 */
export async function readFreshRegistryObject(
  deps: MaterialiseDeps,
  ref: RegistryObjectRef,
): Promise<R2ObjectBody | null> {
  const key = registryObjectKey(ref.ecosystem, ref.owner, ref.key);
  const pkg = await deps.source.package(ref.owner, ref.deliverableId);
  if (pkg === null || pkg.ecosystem !== ref.ecosystem) return null;
  const feed = await feedFor(deps, ref.owner, pkg.ecosystem);
  const stamp = await renderStamp(pkg, feed);
  const hit = await deps.bucket.get(key);
  if (hit && hit.customMetadata?.[RENDER_STAMP_META] === stamp) return hit;
  if (hit) await hit.body.cancel().catch(() => undefined);
  registryCounters.renderMiss++;
  const result = await renderPackage(deps, pkg, feed);
  if (result.status !== "rendered" || !result.keys.includes(key)) return null;
  return deps.bucket.get(key);
}

/** Is the stored render of a package out of date with D1 (or missing)? */
export async function renderIsStale(
  deps: MaterialiseDeps,
  product: string,
  deliverableId: string,
): Promise<boolean> {
  const pkg = await deps.source.package(product, deliverableId);
  if (pkg === null) return false;
  const head = await deps.bucket.head(
    renderRecordKey(pkg.ecosystem, product, deliverableId),
  );
  return (
    head?.customMetadata?.[RENDER_STAMP_META] !==
    (await renderStamp(pkg, await feedFor(deps, product, pkg.ecosystem)))
  );
}

/** The most packages one self-check re-renders (§6.5). */
export const SELF_CHECK_LIMIT = 50;

/**
 * The cron's self-check: re-render each candidate whose stored stamp differs from D1, at most
 * `limit` per run. Returns the packages re-rendered.
 */
export async function selfCheck(
  deps: MaterialiseDeps,
  candidates: ReadonlyArray<{ product: string; deliverableId: string }>,
  limit: number = SELF_CHECK_LIMIT,
): Promise<Array<{ product: string; deliverableId: string }>> {
  const done: Array<{ product: string; deliverableId: string }> = [];
  for (const c of candidates) {
    if (done.length >= limit) break;
    if (!(await renderIsStale(deps, c.product, c.deliverableId))) continue;
    await materialise(deps, c.product, c.deliverableId);
    done.push(c);
  }
  return done;
}

/** One queued render (`registry_render_queue`, Core-owned, created by F-03). */
export interface RegistryQueueItem {
  readonly product: string;
  readonly deliverableId: string;
  readonly enqueuedAt: number;
}

/** The queue as the drain sees it. F-03 implements it over `core/registryQueue.ts`. */
export interface RegistryQueue {
  /** Up to `limit` queued rows, oldest first. */
  pending(limit: number): Promise<RegistryQueueItem[]>;
  /** Delete the rows of one package enqueued at or before `upTo`. */
  consumed(product: string, deliverableId: string, upTo: number): Promise<void>;
}

/**
 * Drain the queue: render each queued package once, then delete the rows it consumed (those
 * enqueued at or before the render's start). A failed render leaves its rows for the next
 * drain; the others still complete. Returns how many packages rendered and failed.
 */
export async function drainRegistry(
  queue: RegistryQueue,
  deps: MaterialiseDeps,
  opts: { limit?: number; now?: () => number } = {},
): Promise<{ rendered: number; failed: number }> {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const items = await queue.pending(opts.limit ?? 100);
  const seen = new Set<string>();
  let rendered = 0;
  let failed = 0;
  for (const item of items) {
    const id = `${item.product}\u0000${item.deliverableId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const start = now();
    try {
      await materialise(deps, item.product, item.deliverableId);
      await queue.consumed(item.product, item.deliverableId, start);
      rendered++;
    } catch {
      failed++;
    }
  }
  return { rendered, failed };
}

/**
 * A stored object as an answer: its own type, a strong ETag of its SHA-256 and the index-document
 * `Cache-Control` (§6.7), or `private, no-store` for a non-public read.
 */
export function renderedObjectResponse(
  obj: R2ObjectBody,
  cache: "public" | "private",
): Response {
  const meta = obj.customMetadata ?? {};
  const sha256 = meta[SHA256_META] ?? "";
  const headers: Record<string, string> = {
    "content-type": meta[CONTENT_TYPE_META] ?? "application/octet-stream",
    "cache-control":
      cache === "public"
        ? "public, max-age=60, stale-while-revalidate=60"
        : "private, no-store",
  };
  if (cache === "public" && /^[0-9a-f]{64}$/.test(sha256))
    headers.etag = `"${sha256}"`;
  return new Response(obj.body, { status: 200, headers });
}
