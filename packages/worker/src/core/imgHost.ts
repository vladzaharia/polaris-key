/// <reference types="@cloudflare/workers-types" />
/**
 * Host isolation and serving for the image host (HA-02, notes/S-20 §6.5, owner decision 2).
 *
 * The image host (`IMG_ORIGIN`, e.g. `https://img.plrs.im`) is the same Worker on a fourth custom
 * domain, beside the console (`key.plrs.im`), the bytes host (`dl.plrs.im`) and the registry host
 * (`pkg.plrs.im`). It serves ONE kind of byte: a product's public hosted images (`core/
 * hostedAssets.ts`), inline, cookie-less and immutable. A request that arrives here reaches ONLY
 * these paths; `/manage`, `/docs`, the portal, discovery, the byte routes, the registry routes
 * and every service route answer the plain not-found:
 *
 *   GET|HEAD /<product>/a/<sha256>              the original, content-addressed
 *   GET|HEAD /<product>/a/<sha256>/<w>.webp     a width variant of that original (HA-03's ladder)
 *   GET|HEAD /<product>/icon                    302 to the current icon's /a/ URL
 *   GET|HEAD /<product>/header                  302 to the current header's /a/ URL
 *   GET|HEAD /<product>/screenshots/<n>         302 to the current screenshot n (1–16)
 *
 * The routes are Core's own (hosted assets are Core, rule 6), so there is no route table in
 * `mount.ts` and no service enablement: a product with a hosted image serves it whatever services
 * it runs.
 *
 * TENANCY. An `/a/` URL answers only when `<product>` holds a `hosted-asset` ref
 * (`HOSTED_ASSET_REF`) to the object, through a `hosted_assets` row whose slot is an IMAGE slot
 * (`slotClass(slot).accept === "image"`) and whose sniffed type is on `IMG_HOST_TYPES`. Another
 * product's ref is never enough (the same rule `blobs.ts` `hasRef` enforces for the byte routes),
 * and neither is a ref of another kind: release files, packs and bundles are the bytes host's,
 * never this host's. A variant answers only when the original's row lists it in `variants_json`
 * (read by HA-03's `parseVariants`, the one parser: `{w, format: "image/webp", sha256, size}`
 * entries only) AND the same slot holds a ref to the variant's object. Everything else is the
 * plain not-found.
 *
 * NEVER GATED (owner decision 7). The host builds only `blobs/sha256/<hex>` keys (`blobKey`
 * without `gated`), so nothing under `gated/` is reachable here, and it carries no auth code: a
 * gated or licensed object is a 404, never a 401. Hosted assets are never gated by construction
 * (`ingest` records them `gated: false`).
 *
 * HEADERS. Every answer, the not-found and the 500 included, carries:
 *   - `X-Content-Type-Options: nosniff`;
 *   - `Content-Security-Policy: default-src 'none'; sandbox` (`IMG_CSP`): an image a browser
 *     chose to render as a document runs no script and has an opaque origin;
 *   - `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy: cross-origin`: the
 *     images are public, and every page, email and store may embed them. No credentials are ever
 *     allowed, and there are none to allow;
 *   - `Referrer-Policy: no-referrer`;
 *   - no `Set-Cookie` (stripped from every answer). No cookie is read either: nothing here looks
 *     at the request's headers beyond the conditional and the client IP.
 * An image answer adds its sniffed `Content-Type` (from the `hosted_assets` row, never a declared
 * type), `Content-Disposition: inline`, `ETag: "<sha256>"` and `Cache-Control: public,
 * max-age=31536000, immutable, no-transform` (`IMG_IMMUTABLE`; `no-transform` so no edge
 * recompression changes the bytes the URL names). An alias answer is a 302 with `Cache-Control:
 * public, max-age=300` (`IMG_ALIAS_CACHE`).
 *
 * WHY THIS IS STRICT: the host is a `*.plrs.im` sibling of the console, so it is SAME-SITE with it
 * (THREAT-MODEL §3, "The image host"). The compensations are the bytes host's: no cookie in or
 * out, `nosniff`, a sandbox policy on every answer, an explicit inert type allowlist (raster
 * images only: no SVG, HTML, XML or script, at any status) and JSON error bodies.
 *
 * COST. The bytes of an `/a/` answer are kept in the Workers Cache API under their hash, so a
 * popular image is read from R2 once per data centre. The tenancy check is NEVER cached: it runs
 * on every request, so a copy an operator deletes stops answering at once. A cache miss is
 * charged to the `imgHost` rate-limit bucket (per product and client IP, fail open: the images
 * are public, nothing secret is behind the limit).
 */

import { PRODUCT_SLUG_PATTERN } from "@polaris-key/manifest";
import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import { errorResponse, notFound } from "./errors.js";
import { blobKey, checksumHex } from "./blobs.js";
import {
  HOSTED_ASSET_REF,
  VARIANT_FORMAT,
  parseVariants,
  slotClass,
} from "./hostedAssets.js";
import { IMAGE_TYPES } from "./sniff.js";
import { clientIp, rateLimitOk } from "./rateLimit.js";
import { IMG_MAX_WIDTH, imgOrigin } from "./imgHostname.js";

export {
  IMG_MAX_WIDTH,
  imgHostname,
  imgOrigin,
  imgUrl,
  isImgHost,
} from "./imgHostname.js";

/** The policy every image-host answer carries. */
export const IMG_CSP = "default-src 'none'; sandbox";
/** `Cache-Control` of a content-addressed image: the bytes behind the URL never change. */
export const IMG_IMMUTABLE =
  "public, max-age=31536000, immutable, no-transform";
/** `Cache-Control` of a stable alias: it moves when the slot's copy changes. */
export const IMG_ALIAS_CACHE = "public, max-age=300";
/**
 * The types the image host serves: the raster image types `ingest` accepts for an image slot
 * (`sniff.ts` `IMAGE_TYPES`). Never SVG or HTML (a document that can carry script); video waits
 * for HA-17. Any change here is a THREAT-MODEL §9 review trigger.
 */
export const IMG_HOST_TYPES: ReadonlySet<string> = IMAGE_TYPES;

/** R2 reads per product and client IP per minute (cache misses only). */
const IMG_RATE_LIMIT = { limit: 600, windowSec: 60 } as const;

/** Each stable alias and the slots it reads, first match wins (locale `''`, every locale). */
export const IMG_ALIASES = {
  icon: ["presentation.icon", "listing.icon"],
  header: ["listing.header"],
} as const;

/** The highest screenshot an alias addresses: the listing's 16 slots (`hostedAssets.ts`). */
export const IMG_MAX_SCREENSHOT = 16;

/** P0-14's one product slug rule (`PRODUCT_SLUG_PATTERN`), unanchored to embed in a path. */
const SLUG = PRODUCT_SLUG_PATTERN.slice(1, -1);
const ASSET_RE = new RegExp(`^/(${SLUG})/a/([0-9a-f]{64})$`);
const VARIANT_RE = new RegExp(
  `^/(${SLUG})/a/([0-9a-f]{64})/([1-9][0-9]{0,3})\\.webp$`,
);
const ALIAS_RE = new RegExp(`^/(${SLUG})/(icon|header)$`);
const SCREENSHOT_RE = new RegExp(`^/(${SLUG})/screenshots/([1-9][0-9]?)$`);
const SHA256_RE = /^[0-9a-f]{64}$/;

/** What an image-host path names, or `null` for every other path. */
export type ImgPath =
  | { kind: "asset"; product: string; sha256: string; w: number | null }
  | { kind: "alias"; product: string; slots: readonly string[] };

/** Parse an image-host path. Strict: no trailing slash, no encoding, lowercase hex only. */
export function matchImgPath(pathname: string): ImgPath | null {
  let m = ASSET_RE.exec(pathname);
  if (m) return { kind: "asset", product: m[1]!, sha256: m[2]!, w: null };
  m = VARIANT_RE.exec(pathname);
  if (m) {
    const w = Number(m[3]);
    if (w > IMG_MAX_WIDTH) return null;
    return { kind: "asset", product: m[1]!, sha256: m[2]!, w };
  }
  m = ALIAS_RE.exec(pathname);
  if (m)
    return {
      kind: "alias",
      product: m[1]!,
      slots: IMG_ALIASES[m[2] as keyof typeof IMG_ALIASES],
    };
  m = SCREENSHOT_RE.exec(pathname);
  if (m) {
    const n = Number(m[2]);
    if (n > IMG_MAX_SCREENSHOT) return null;
    return {
      kind: "alias",
      product: m[1]!,
      slots: [`listing.screenshot:${n}`],
    };
  }
  return null;
}

/** May `slot`'s copy be served here? Image slots only (never a release file or a video). */
function imageSlot(slot: string): boolean {
  return slotClass(slot)?.accept === "image";
}

/** The slice of the runtime's `ExecutionContext` the host uses to fill the cache. */
export interface ImgExecution {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * The headers every image-host answer leaves with. Applied to not-found, 405, 429 and 500
 * answers as well as images, so no answer on the host is ever missing them.
 */
export function hardenImgHostResponse(res: Response): Response {
  const headers = new Headers();
  res.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k === "set-cookie" || k.startsWith("access-control-")) return;
    headers.append(key, value);
  });
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", IMG_CSP);
  headers.set("access-control-allow-origin", "*");
  headers.set("cross-origin-resource-policy", "cross-origin");
  headers.set("referrer-policy", "no-referrer");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * Dispatch a request that arrived on the image host (`dispatch.ts`). Anything but an image-host
 * path is the plain not-found; a throw (D1, R2) is the platform's flat JSON 500 rather than
 * Cloudflare's HTML error page, hardened like everything else.
 */
export async function dispatchImgHost(
  req: Request,
  env: Env,
  db: Db,
  now: number = Math.floor(Date.now() / 1000),
  exec?: ImgExecution,
): Promise<Response> {
  let res: Response;
  try {
    res = await answer(req, env, db, now, exec);
  } catch {
    res = errorResponse(500, "internal_error");
  }
  return hardenImgHostResponse(res);
}

async function answer(
  req: Request,
  env: Env,
  db: Db,
  now: number,
  exec: ImgExecution | undefined,
): Promise<Response> {
  const path = matchImgPath(new URL(req.url).pathname);
  if (!path) return notFound();
  if (req.method !== "GET" && req.method !== "HEAD")
    return new Response(null, {
      status: 405,
      headers: { allow: "GET, HEAD", "cache-control": "no-store" },
    });
  if (path.kind === "alias") return alias(env, db, path.product, path.slots);
  const found =
    path.w === null
      ? await original(db, path.product, path.sha256)
      : await variant(db, path.product, path.sha256, path.w);
  if (!found) return notFound();
  return serve(req, env, path.product, found, now, exec);
}

/** The object an `/a/` URL resolves to, once tenancy has passed. */
interface Servable {
  sha256: string;
  contentType: string;
}

/** The original at `sha256`, when `product` holds it as an image slot's copy. */
async function original(
  db: Db,
  product: string,
  sha256: string,
): Promise<Servable | null> {
  const rows = await db.all<{ slot: string; content_type: string | null }>(
    `SELECT h.slot AS slot, h.content_type AS content_type
       FROM blob_refs r
       JOIN hosted_assets h
         ON h.product = r.product AND (h.slot || '@' || h.locale) = r.ref_id
      WHERE r.product = ? AND r.storage_key = ? AND r.ref_kind = ? AND h.sha256 = ?`,
    product,
    blobKey(sha256),
    HOSTED_ASSET_REF,
    sha256,
  );
  for (const row of rows)
    if (
      imageSlot(row.slot) &&
      row.content_type !== null &&
      IMG_HOST_TYPES.has(row.content_type)
    )
      return { sha256, contentType: row.content_type };
  return null;
}

/** The `w`-pixel WebP variant of the original at `sha256`, when `product` holds both. */
async function variant(
  db: Db,
  product: string,
  sha256: string,
  w: number,
): Promise<Servable | null> {
  const rows = await db.all<{
    slot: string;
    locale: string;
    variants_json: string | null;
  }>(
    `SELECT slot, locale, variants_json FROM hosted_assets
      WHERE product = ? AND sha256 = ?`,
    product,
    sha256,
  );
  for (const row of rows) {
    if (!imageSlot(row.slot)) continue;
    // HA-03's own reader: a malformed list, or any entry whose `format` is not exactly
    // `VARIANT_FORMAT` ("image/webp"), reads as no variants at all.
    for (const entry of parseVariants(row.variants_json)) {
      if (entry.w !== w) continue;
      const held = await db.first<{ one: number }>(
        `SELECT 1 AS one FROM blob_refs
          WHERE product = ? AND storage_key = ? AND ref_kind = ? AND ref_id = ? LIMIT 1`,
        product,
        blobKey(entry.sha256),
        HOSTED_ASSET_REF,
        `${row.slot}@${row.locale}`,
      );
      if (held) return { sha256: entry.sha256, contentType: VARIANT_FORMAT };
    }
  }
  return null;
}

/**
 * A stable alias: 302 to the content-addressed URL of the slot's current copy (the first slot of
 * `slots` that has one, every-locale row), when that copy would itself answer.
 */
async function alias(
  env: Env,
  db: Db,
  product: string,
  slots: readonly string[],
): Promise<Response> {
  const origin = imgOrigin(env);
  if (origin === null) return notFound();
  for (const slot of slots) {
    const row = await db.first<{ sha256: string | null }>(
      `SELECT sha256 FROM hosted_assets WHERE product = ? AND slot = ? AND locale = ''`,
      product,
      slot,
    );
    if (!row?.sha256 || !SHA256_RE.test(row.sha256)) continue;
    if (!(await original(db, product, row.sha256))) continue;
    return new Response(null, {
      status: 302,
      headers: {
        location: `${origin}/${product}/a/${row.sha256}`,
        "cache-control": IMG_ALIAS_CACHE,
      },
    });
  }
  return notFound();
}

function cacheStore(): Cache | null {
  try {
    const c = (globalThis as { caches?: { default?: Cache } }).caches;
    return c?.default ?? null;
  } catch {
    return null;
  }
}

/** RFC 9110 §13.1.2: weak comparison, `*` matches anything that exists. */
function ifNoneMatchHits(header: string | null, etag: string): boolean {
  if (header === null) return false;
  return header
    .split(",")
    .map((t) => t.trim().replace(/^W\//, ""))
    .some((t) => t === "*" || t === etag);
}

/** Serve one object tenancy has cleared: a 304, the cached bytes, or a verified R2 read. */
async function serve(
  req: Request,
  env: Env,
  product: string,
  found: Servable,
  now: number,
  exec: ImgExecution | undefined,
): Promise<Response> {
  const etag = `"${found.sha256}"`;
  const headers = new Headers({
    etag,
    "cache-control": IMG_IMMUTABLE,
  });
  if (ifNoneMatchHits(req.headers.get("if-none-match"), etag))
    return new Response(null, { status: 304, headers });
  headers.set("content-type", found.contentType);
  headers.set("content-disposition", "inline");

  const cache = cacheStore();
  const cacheKey = new Request(
    `${imgOrigin(env) ?? new URL(req.url).origin}/__pkey-img-cache/${found.sha256}`,
  );
  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => undefined);
    if (hit) {
      const length = hit.headers.get("content-length");
      if (length !== null) headers.set("content-length", length);
      if (req.method === "HEAD") {
        await hit.body?.cancel().catch(() => undefined);
        return new Response(null, { status: 200, headers });
      }
      return new Response(hit.body, { status: 200, headers });
    }
  }

  const bucket = env.BLOBS;
  if (!bucket) return notFound();
  if (
    !(await rateLimitOk(
      env,
      product,
      { bucket: "imgHost", id: clientIp(req), ...IMG_RATE_LIMIT },
      now,
    ))
  )
    return errorResponse(429, "rate_limited", "too many image requests");

  const key = blobKey(found.sha256);
  const head = await bucket.head(key);
  // Fail closed, as `blobResponse` does: an object without a stored checksum did not come
  // through `putVerified`, and one whose checksum is not the hash disagrees with its name.
  if (!head || checksumHex(head) !== found.sha256) return notFound();
  headers.set("content-length", String(head.size));
  if (req.method === "HEAD")
    return new Response(null, { status: 200, headers });
  const obj = await bucket.get(key, { onlyIf: { etagMatches: head.etag } });
  if (!obj || !("body" in obj)) return notFound();
  let body: ReadableStream = obj.body;
  if (cache && exec) {
    const [out, kept] = body.tee();
    body = out;
    exec.waitUntil(
      cache
        .put(
          cacheKey,
          new Response(kept, {
            headers: {
              "content-type": "application/octet-stream",
              "content-length": String(head.size),
              "cache-control": IMG_IMMUTABLE,
            },
          }),
        )
        .catch(() => undefined),
    );
  }
  return new Response(body, { status: 200, headers });
}
