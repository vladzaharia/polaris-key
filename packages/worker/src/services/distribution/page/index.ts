/// <reference types="@cloudflare/workers-types" />

/**
 * The public download page (P2b-06, README §6.3, notes/A3 §3.2):
 *
 *     GET  https://dl.plrs.im/<p>/distribution/download     the HTML page, BYTES HOST ONLY
 *     GET  https://dl.plrs.im/<p>                           the same page (alias)
 *     GET  /<p>/distribution/download.json                   the page's model, CONSOLE HOST
 *
 * ── WHY THE PAGE IS ON THE BYTES HOST, AND WHY IT IS SANDBOXED THERE ────────────────────────
 *
 * The page is the first HTML a stranger can load that shows repo-authored text (`.pkey/
 * distribution` listings), so it must never be served on the console's origin, beside `/manage`
 * and its session cookie (notes/A3 §7.2): on the console host both page paths are the ordinary
 * not-found (`routes.ts` returns `null`). It is served on the cookie-free bytes host instead, as a
 * `document` byte route (`core/assets/bytesHost.ts`), where the dispatcher admits exactly this kind of
 * answer and nothing looser: `text/html` with a policy that keeps the host's guarantees —
 *
 *   - `sandbox` (no `allow-scripts`, no `allow-same-origin`): the document has an opaque origin
 *     and runs no script, which is the compensation THREAT-MODEL §3 records for `dl.plrs.im`
 *     being same-site with the console host. The page needs no script: platform detection is
 *     server-side (`detect.ts`) and the iPad case is a CSS media query. The two sandbox tokens it
 *     keeps let a click do what the page is for — `allow-downloads` (the download buttons) and
 *     `allow-top-navigation-to-custom-protocols` (the `altstore://`, `obtainium://`, … links);
 *     neither runs script or lifts the opaque origin;
 *   - `default-src 'none'` with the one stylesheet allowed by its hash: no request leaves the
 *     page, to any host but one. Since HA-07 the header shows the product's hosted icon, so
 *     while there is one the policy adds `img-src <image host>` (`pageCsp`): the image host
 *     serves only public raster images, cookie-less, under its own sandbox policy;
 *   - `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'none'`.
 *
 * Every string is escaped and every link built by the Worker (`model.ts`, `render.ts`). The
 * bytes host strips cookies both ways, so the page can neither read nor set one.
 *
 * ── WHY THE MODEL IS ON THE CONSOLE HOST ────────────────────────────────────────────────────
 *
 * `download.json` is a read-only public JSON document like the storefront feeds, which are served
 * on the console host and never on the bytes host; the bytes host refuses JSON success answers
 * by rule (only inert byte types pass), and this route does not need an exception to it. SDK
 * "get it here" prompts and P6-04's "Play now" read it with the product's CORS allowlist, as they
 * read the feeds. The HTML is rendered from the SAME builder (`buildDownloadModel`).
 *
 * ── COST ────────────────────────────────────────────────────────────────────────────────────
 *
 * Both are public, so both count against the feeds' per-IP budget (`distributionFeed`, fails
 * open), check delivery access on every request (never cached), and keep the built model in the
 * feed cache (`feeds/cache.ts`) under a stamp that also covers the key inventory.
 */

import { RESERVED_PRODUCT_SLUGS } from "@polaris-key/manifest";
import type { ServiceContext } from "../../../core/registry.js";
import type {
  ByteRoute,
  ByteRouteContext,
} from "../../../core/assets/bytesHost.js";
import { bytesHostname } from "../../../core/assets/bytesHost.js";
import { normalizeHostname } from "../../../core/assets/bytesHostname.js";
import { cspImageOrigin } from "../../../core/securityHeaders.js";
import { sha256Base64 } from "../../../platform/hash.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { ServiceHooks } from "../../../core/hooks.js";
import { errorResponse, notFound } from "../../../core/errors.js";
import { clientNetwork, rateLimitOk } from "../../../core/rateLimit.js";
import { feedReaders, type FeedReadContext } from "../feeds/select.js";
import {
  cachedFeedText,
  feedCacheKey,
  feedStateStamp,
} from "../feeds/cache.js";
import { feedResponse } from "../feeds/index.js";
import { detectPlatform } from "../../../core/platformDetect.js";
import {
  PRESENTATION_ICON_SLOTS,
  firstHostedImage,
  hostedImageOrigin,
  hostedImageUrl,
  hostedImages,
} from "../../../core/assets/hostedImages.js";
import { buildDownloadModel, memoHooks, type DownloadModel } from "./model.js";
import { PAGE_CSS, renderDownloadPage } from "./render.js";

/** The page's public per-IP budget: the storefront feeds' (a D1-read budget, fails open). */
const PAGE_RATE_LIMIT = { limit: 60, windowSec: 60 } as const;
const PAGE_CACHE = "public, max-age=300";

/** The sandbox tokens the page keeps (see the file comment). Never `allow-scripts`. */
export const PAGE_SANDBOX =
  "sandbox allow-downloads allow-top-navigation-to-custom-protocols";

let cssHash: Promise<string> | null = null;

/**
 * The page's Content-Security-Policy: script-free, sandboxed, the stylesheet by hash. With
 * `imgOrigin` (the image host, while hosted copies are served: HA-07) the product's icon may load
 * from exactly it, `img-src <origin>`; nothing else is ever an image source. The dispatcher
 * checks the result (`inertDocumentPolicy`) against the same origin.
 */
export async function pageCsp(
  imgOrigin: string | null = null,
): Promise<string> {
  cssHash ??= sha256Base64(PAGE_CSS);
  const img = cspImageOrigin(imgOrigin);
  return [
    "default-src 'none'",
    `style-src 'sha256-${await cssHash}'`,
    ...(img ? [`img-src ${img}`] : []),
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    PAGE_SANDBOX,
  ].join("; ");
}

/**
 * The product's icon for the page's header (HA-07): its hosted copy on the image host, chosen as
 * the image host's `/icon` alias chooses it (`presentation.icon`, else `listing.icon`), at the
 * width the page draws it (64 px at 2x). `null` without a copy, or while nothing is served from
 * the image host; the page then has no icon, as before. Read per request, never cached with the
 * model, so `download.json` (and the transcripts that record it) do not change.
 */
async function pageIcon(
  env: Env,
  db: Db,
  product: string,
): Promise<string | null> {
  if ((await hostedImageOrigin(env, db)) === null) return null;
  const icon = firstHostedImage(
    await hostedImages(env, db, product, PRESENTATION_ICON_SLOTS),
    PRESENTATION_ICON_SLOTS,
  );
  return icon ? hostedImageUrl(env, product, icon, PAGE_ICON_WIDTH) : null;
}

/** The icon's drawn size in CSS px (`.icon` in `PAGE_CSS`) times two. */
export const PAGE_ICON_WIDTH = 128;

/**
 * The console host's origin, where the storefront feeds live (`CONSOLE_ORIGIN`, e.g.
 * `https://key.plrs.im`), or `null` when unset, unusable, or the bytes host itself: the page then
 * leaves the feed rows out rather than linking a host that does not serve them.
 */
export function consoleOriginOf(env: Env): string | null {
  const raw = env.CONSOLE_ORIGIN;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (normalizeHostname(u.hostname) === bytesHostname(env)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

function bytesOriginOf(env: Env): string | null {
  return bytesHostname(env) && env.BLOB_ORIGIN
    ? new URL(env.BLOB_ORIGIN).origin
    : null;
}

/** The key inventory's state, folded into the feed stamp (a fingerprint edit shows at once). */
async function keysStamp(db: Db, product: string): Promise<string> {
  const row = await db.first<{ k: string }>(
    `SELECT COUNT(*) || ':' || COALESCE(MAX(modified_at), 0) AS k
       FROM dist_keys WHERE product = ?`,
    product,
  );
  return row?.k ?? "0:0";
}

interface ModelRequest {
  db: Db;
  env: Env;
  product: { slug: string; name: string };
  hooks: ServiceHooks;
  consoleOrigin: string | null;
  /** The origin the cache key is scoped to (one model per host). */
  cacheOrigin: string;
}

/** The model as JSON text (cached), or `null` = not-found. The access check is never cached. */
async function modelText(r: ModelRequest): Promise<string | null> {
  const hooks = memoHooks(r.hooks);
  const fctx: FeedReadContext = {
    db: r.db,
    product: r.product,
    hooks,
    origin: r.cacheOrigin,
    env: r.env,
  };
  const readers = await feedReaders(fctx);
  if (!readers) return null;
  // The feeds' stamp, plus the key inventory and the feed origin the model links to.
  const stamp = [
    await feedStateStamp(
      r.db,
      r.product.slug,
      readers.catalog,
      readers.notesPublic,
    ),
    await keysStamp(r.db, r.product.slug),
    r.consoleOrigin ?? "-",
  ].join(".");
  const key = feedCacheKey(
    r.cacheOrigin,
    `/${r.product.slug}/distribution/download.json`,
    null,
    stamp,
  );
  return cachedFeedText(key, async () => {
    const model = await buildDownloadModel({
      db: r.db,
      env: r.env,
      product: r.product,
      hooks,
      consoleOrigin: r.consoleOrigin,
      bytesOrigin: bytesOriginOf(r.env),
    });
    return model === null ? null : `${JSON.stringify(model, null, 2)}\n`;
  });
}

async function withinBudget(
  env: Env,
  slug: string,
  req: Request,
  now: number,
): Promise<boolean> {
  return rateLimitOk(
    env,
    slug,
    { bucket: "distributionFeed", id: clientNetwork(req), ...PAGE_RATE_LIMIT },
    now,
  );
}

/** `GET /<p>/distribution/download.json` on the console host. */
export async function handleDownloadModel(
  ctx: ServiceContext,
): Promise<Response> {
  const { req, env, db, product, hooks, now } = ctx;
  if (!(await withinBudget(env, product.slug, req, now)))
    return errorResponse(429, "rate_limited", "too many requests");
  const origin = new URL(req.url).origin;
  const text = await modelText({
    db,
    env,
    product: { slug: product.slug, name: product.name },
    hooks,
    consoleOrigin: origin,
    cacheOrigin: origin,
  });
  return text === null ? notFound() : feedResponse(req, text);
}

/** `GET /<p>[/distribution/download]` on the bytes host: the page. */
async function handlePage(
  req: Request,
  ctx: ByteRouteContext,
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return notFound();
  const { env, db, product, hooks, now } = ctx;
  if (!(await withinBudget(env, product.slug, req, now)))
    return errorResponse(429, "rate_limited", "too many requests");
  const text = await modelText({
    db,
    env,
    product: { slug: product.slug, name: product.name },
    hooks,
    consoleOrigin: consoleOriginOf(env),
    cacheOrigin: new URL(req.url).origin,
  });
  if (text === null) return notFound();
  const model = JSON.parse(text) as DownloadModel;
  const iconUrl = await pageIcon(env, db, product.slug);
  const html = renderDownloadPage(model, detectPlatform(req.headers), {
    iconUrl,
  });
  return new Response(req.method === "HEAD" ? null : html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": await pageCsp(
        iconUrl ? await hostedImageOrigin(env, db) : null,
      ),
      "cache-control": PAGE_CACHE,
      // The page differs by platform: a shared cache must key on what detection read.
      vary: "Sec-CH-UA-Platform, Sec-CH-UA-Mobile, User-Agent",
      "x-frame-options": "DENY",
    },
  });
}

/** `/<p>` and `/<p>/distribution/download` (a trailing slash allowed) → the product. A reserved
 *  slug (`/manage`, `/docs`, `/login`, …) is never a product, so it is not even looked up. */
const PAGE_PATH = /^\/([a-z0-9-]+)(?:\/distribution\/download)?\/?$/;

/**
 * The page's entry in the bytes-host allowlist (`mount.ts` `BYTE_ROUTES`). A `document` route:
 * the dispatcher admits its HTML only under a policy it checks itself (`core/assets/bytesHost.ts`).
 */
export const DOWNLOAD_PAGE_ROUTE: ByteRoute = {
  name: "distribution.page",
  service: "distribution",
  document: true,
  match(pathname) {
    const m = PAGE_PATH.exec(pathname);
    if (!m || RESERVED_PRODUCT_SLUGS.includes(m[1]!)) return null;
    return { product: m[1]!, params: {} };
  },
  handle: handlePage,
};
