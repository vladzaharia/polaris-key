/// <reference types="@cloudflare/workers-types" />

/**
 * The customer portal's same-origin media route (PX-W1, docs/design/PORTAL.md G1):
 * `GET /media/<product>/<asset>`, where `<asset>` is `icon`, `header`, or `screenshot-<n>` (the
 * storefront product page's screenshots, PS-04: the n-th https screenshot of the listing).
 *
 * ── SINCE HA-07: A REDIRECT TO THE HOSTED COPY ──────────────────────────────────────────────
 *
 * Polaris Key now keeps its own copy of a product's art (HA-01, HA-05) and serves it from the
 * image host (HA-02). While hosting is on and the deployment has an image host
 * (`hostedImageOrigin`), a slot that has a copy the host serves is answered `302` to the image
 * host's stable alias (`https://img…/<product>/icon` or `/header`, which 302s on to the
 * content-addressed copy), and nothing is fetched. The portal then names the image host directly
 * (`library.ts`), but URLs already handed out, and the sign-in card's client record (§12.7.2 names
 * this path), keep working.
 *
 * The proxy below answers everything else, exactly as it did before HA-07 and under every rule
 * below: PER SLOT, a slot with no servable copy (a product not resynced since HA-05 pulled its
 * art, a first pull in flight), so a deploy never blanks a product's art; and every slot in
 * HA-10's rollback (`assets.hosting.enabled` off, or no image host).
 *
 * ── WHY A PROXY AT ALL ──────────────────────────────────────────────────────────────────────
 *
 * The portal shell's CSP is `img-src 'self' data:` plus, since HA-07, exactly the image host's
 * origin (`securityHeaders.ts`), and it never names a developer's host: that would let any
 * product's manifest decide what the signed-in page loads, and would hand each of those hosts the
 * customer's IP and `Referer` for every library view. So wherever there is no hosted copy, a
 * product's art is served from this origin.
 *
 * ── WHY IT IS NOT AN SSRF (THREAT-MODEL "Portal media proxy") ───────────────────────────────
 *
 * A proxy turns "a URL a repository wrote" into "a fetch this Worker makes". Five rules bound it:
 *
 *   1. NO URL IN THE REQUEST. The path names a product and one FIXED listing slot (`icon`,
 *      `header`, or a screenshot's position, at most `MAX_LISTING_SCREENSHOTS`); the source is
 *      the product's own stored listing (`delivery().listing()`, Distribution's `dist_listing`,
 *      written only by manifest ingest). A visitor cannot aim the fetch.
 *   2. ALLOWLISTED SOURCES ONLY. The source must be `https`, on the default port, with no
 *      credentials, on a GitHub-hosted name (`isAllowedStorageHost`: `github.com`,
 *      `*.githubusercontent.com`) — the same one predicate the release-asset fetch and the
 *      portal's download redirect use. An IP literal, `localhost`, a custom domain or the
 *      deployment's own hosts never match it, so the Worker cannot be pointed at itself, at
 *      another zone on the account or at anything internal.
 *   3. REDIRECTS RE-CHECKED. Redirects are followed by hand (at most three) and every hop must
 *      pass rule 2 again, so an allowlisted host cannot bounce the fetch elsewhere.
 *   4. BOUNDED. A 5 s timeout; a `Content-Length` over the asset's cap is refused before the body
 *      is read, and the body is read through a counter that stops at the cap whatever the header
 *      claimed (1 MiB for the icon, 5 MiB for the header and for each screenshot).
 *   5. STRICT TYPE. The bytes must BE a PNG, JPEG, WebP or GIF by their magic numbers; the
 *      upstream `Content-Type` is ignored and the response carries the sniffed type, `nosniff`,
 *      and its own `default-src 'none'; sandbox` policy. SVG is never served (it is a document
 *      that can carry script), and neither is anything else.
 *
 * The images are not re-encoded (the Worker carries no image codec); rule 5 is the "strict
 * content type" alternative the design allows. A browser decodes them as images only, under
 * `nosniff`, from a response that cannot be framed or rendered as a document.
 *
 * ── CACHING ─────────────────────────────────────────────────────────────────────────────────
 *
 * The URLs the library hands out carry `?v=<hash of the source URL>`. A request whose `v` is the
 * current one is `immutable` for a year (a new source URL is a new `v`); any other answer is
 * cached for five minutes. Fetched bytes are kept in the Workers Cache API under the source's
 * hash, so a popular icon is fetched once per data centre, and the upstream fetch is charged to
 * the `portalMedia` rate-limit bucket (per product and client IP) only on a miss. A refusal is
 * never cached and always the same `404`, so it says nothing about why — with one deliberate
 * exception: a rate-limited cache miss is `429 rate_limited`, so a client can back off.
 */

import {
  MAX_LISTING_SCREENSHOTS,
  listingImageUrl,
  listingScreenshotUrls,
} from "@polaris-key/manifest";
import {
  hexEncode,
  isAllowedStorageHost,
  sha256,
  type Db,
  type Env,
} from "../../../core/platform.js";
import { loadProductPublic } from "../../../core/products.js";
import {
  SAFE_FETCH_MAX_REDIRECTS,
  safeFetch,
  type FetchImpl,
} from "../../../core/safeFetch.js";
import { clientNetwork, rateLimitOk } from "../../../core/rateLimit.js";
import {
  PRESENTATION_HEADER_SLOTS,
  PRESENTATION_ICON_SLOTS,
  firstHostedImage,
  hostedImageOrigin,
  hostedImages,
} from "../../../core/hostedImages.js";
import { getPortalProductSettings } from "./repo.js";
import { portalSecurityHeaders } from "./headers.js";
import type { PortalHooksFor } from "./api.js";

/**
 * The two named listing slots, their path names and byte caps. Each slot's source is read with
 * `listingImageUrl` (HA-04): the normalised `icon` / `header` ref when it is an https URL, or the
 * legacy `iconUrl` / `headerUrl` of a listing row stored before HA-04. A repo-path ref has no
 * URL to proxy. The caps and the proxy apply to a slot with no hosted copy, and to every slot in
 * HA-10's rollback; a slot with a copy redirects to it (see the file comment).
 */
export const MEDIA_ASSETS = {
  icon: { maxBytes: 1024 * 1024 },
  header: { maxBytes: 5 * 1024 * 1024 },
} as const;

/** A screenshot's byte cap: the header's. */
export const SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * A proxied slot: `icon`, `header`, or `screenshot-<n>` (PS-04), the n-th of the listing's https
 * screenshots as `listingScreenshotUrls` reads them (HA-04: normalised refs or pre-HA-04 strings,
 * repo paths skipped), `n` below `MAX_LISTING_SCREENSHOTS`.
 */
export type MediaAsset = keyof typeof MEDIA_ASSETS | `screenshot-${number}`;

const SCREENSHOT_RE = /^screenshot-(0|[1-9][0-9]?)$/;

export function isMediaAsset(v: string): v is MediaAsset {
  if (Object.prototype.hasOwnProperty.call(MEDIA_ASSETS, v)) return true;
  const n = SCREENSHOT_RE.exec(v)?.[1];
  return n !== undefined && Number(n) < MAX_LISTING_SCREENSHOTS;
}

/** The slot's byte cap. */
function mediaMaxBytes(asset: MediaAsset): number {
  return asset === "icon" || asset === "header"
    ? MEDIA_ASSETS[asset].maxBytes
    : SCREENSHOT_MAX_BYTES;
}

/** The raw source a slot names in the listing (not yet checked against rule 2). */
function slotSource(
  listing: object | null,
  asset: MediaAsset,
): string | undefined {
  if (asset === "icon" || asset === "header")
    return listingImageUrl(listing, asset);
  return listingScreenshotUrls(listing)[
    Number(asset.slice("screenshot-".length))
  ];
}

/** Redirect hops followed (each re-checked against the allowlist): Core's guarded fetcher's. */
export const MEDIA_MAX_REDIRECTS = SAFE_FETCH_MAX_REDIRECTS;
/** The upstream fetch's budget, headers and body together. */
export const MEDIA_FETCH_TIMEOUT_MS = 5000;
/** `Cache-Control` of an answer whose `v` is current: a new source URL is a new `v`. */
export const MEDIA_IMMUTABLE = "public, max-age=31536000, immutable";
/** `Cache-Control` of an answer requested without the current `v`, and of the HA-07 redirect
 *  (the image host's alias it points at moves when the copy does). */
export const MEDIA_SHORT = "public, max-age=300";

/**
 * The hosted slots behind each asset: the image host's `/icon` and `/header` aliases' own. A
 * screenshot (PS-04) has no image-host alias, so it is always proxied.
 */
const MEDIA_SLOTS: Record<keyof typeof MEDIA_ASSETS, readonly string[]> = {
  icon: PRESENTATION_ICON_SLOTS,
  header: PRESENTATION_HEADER_SLOTS,
};
/** The media response's own policy: an image is never a document, never framed. */
export const MEDIA_CSP = "default-src 'none'; sandbox";

/** Upstream fetches per product and client IP per minute (cache misses only). */
const MEDIA_RATE_LIMIT = 120;

/**
 * The source URL a listing field may be proxied from, or `null` (rule 2 above). Exported so the
 * library hands out a `/media/…` URL only for art this route would actually serve.
 */
export function mediaSourceUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.port !== "") return null;
  if (!isAllowedStorageHost(url.hostname.toLowerCase())) return null;
  return url;
}

/** The `v` a media URL carries: the first 16 hex digits of the source URL's SHA-256. */
export async function mediaVersion(source: string): Promise<string> {
  return hexEncode((await sha256(source)).subarray(0, 8));
}

/** The same-origin URL of a product's art (for the library), or `null` when none would serve. */
export async function mediaUrlFor(
  product: string,
  asset: MediaAsset,
  listing: Record<string, unknown> | null,
): Promise<string | null> {
  const source = mediaSourceUrl(slotSource(listing, asset));
  if (!source) return null;
  const v = await mediaVersion(source.toString());
  return `/media/${encodeURIComponent(product)}/${asset}?v=${v}`;
}

/**
 * The same-origin URLs of the listing's screenshots this route would serve, in listing order
 * (PS-04, the storefront product page). A screenshot the proxy would refuse is left out.
 */
export async function screenshotUrlsFor(
  product: string,
  listing: Record<string, unknown> | null,
): Promise<string[]> {
  const out: string[] = [];
  const count = Math.min(
    listingScreenshotUrls(listing).length,
    MAX_LISTING_SCREENSHOTS,
  );
  for (let n = 0; n < count; n++) {
    const url = await mediaUrlFor(product, `screenshot-${n}`, listing);
    if (url) out.push(url);
  }
  return out;
}

/** The image types served, by magic number (rule 5). */
export function sniffImageType(bytes: Uint8Array): string | null {
  const at = (i: number, ...sig: number[]) =>
    sig.every((b, k) => bytes[i + k] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  // RIFF....WEBP
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50))
    return "image/webp";
  // GIF87a / GIF89a
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (at(4, 0x37, 0x61) || at(4, 0x39, 0x61)))
    return "image/gif";
  return null;
}

/** Headers every media answer carries, image or refusal. */
export function mediaResponseHeaders(extra: Record<string, string>): Headers {
  const headers = portalSecurityHeaders(new Headers(extra));
  headers.set("content-security-policy", MEDIA_CSP);
  headers.set("cross-origin-resource-policy", "same-origin");
  return headers;
}

function refused(status = 404): Response {
  const error = status === 429 ? "rate_limited" : "not_found";
  return new Response(JSON.stringify({ error }), {
    status,
    headers: mediaResponseHeaders({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    }),
  });
}

/**
 * Fetch `source` under rules 2–5: allowlisted hops only, bounded, and sniffed. `null` for any
 * refusal or failure. The fetch itself is Core's guarded fetcher (`core/safeFetch.ts`, HA-01),
 * narrowed to rule 2's GitHub-hosted names on every hop (`allowHost`); the cap, the redirect rule
 * and the 5 s budget are unchanged. Reached for a slot with no hosted copy and in HA-10's rollback
 * (see the file comment).
 */
export async function fetchMedia(
  source: URL,
  maxBytes: number,
  fetchImpl: FetchImpl = fetch,
): Promise<{ bytes: Uint8Array; type: string } | null> {
  const res = await safeFetch(source.toString(), {
    maxBytes,
    timeoutMs: MEDIA_FETCH_TIMEOUT_MS,
    headers: { accept: "image/png, image/jpeg, image/webp, image/gif" },
    allowHost: isAllowedStorageHost,
    fetchImpl,
  });
  if (!res.ok || res.status !== 200) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      chunks.push(value);
    }
  } catch {
    // Past the cap, the timeout, or a broken stream: all one refusal.
    await reader.cancel().catch(() => undefined);
    return null;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  const type = sniffImageType(bytes);
  return type ? { bytes, type } : null;
}

function cacheStore(): Cache | null {
  try {
    const c = (globalThis as { caches?: { default?: Cache } }).caches;
    return c?.default ?? null;
  } catch {
    return null;
  }
}

/**
 * `GET /media/<product>/<asset>`. Public: a product's listing art is public store-page metadata
 * (the download page shows the same), so no session is required — which is also what lets the
 * login card show the product context before sign-in.
 */
export async function handlePortalMedia(
  req: Request,
  env: Env,
  db: Db,
  product: string,
  asset: string,
  now: number,
  hooksFor: PortalHooksFor | undefined,
  fetchImpl: FetchImpl = fetch,
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: mediaResponseHeaders({
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        allow: "GET, HEAD",
      }),
    });
  }
  if (!/^[a-z0-9-]{1,64}$/.test(product) || !isMediaAsset(asset))
    return refused();
  const loaded = await loadProductPublic(db, product);
  if (!loaded) return refused();
  const settings = await getPortalProductSettings(db, product);
  if (settings.portal_enabled !== 1) return refused();

  // HA-07: the hosted copy, through the image host's stable alias. Nothing is fetched.
  if (asset === "icon" || asset === "header") {
    const origin = await hostedImageOrigin(env, db);
    const slots = MEDIA_SLOTS[asset];
    const copy =
      origin === null
        ? null
        : firstHostedImage(await hostedImages(env, db, product, slots), slots);
    if (copy)
      return new Response(null, {
        status: 302,
        headers: mediaResponseHeaders({
          location: `${origin}/${product}/${asset}`,
          "cache-control": MEDIA_SHORT,
        }),
      });
  }

  // No servable copy of this slot, or the rollback (hosting off, no image host): the proxy,
  // exactly as before HA-07.
  if (!hooksFor) return refused();
  const delivery = hooksFor(loaded, now).delivery();
  const listing = delivery ? await delivery.listing() : null;
  const source = mediaSourceUrl(slotSource(listing, asset));
  if (!source) return refused();

  const version = await mediaVersion(source.toString());
  const requested = new URL(req.url).searchParams.get("v");
  const cacheControl = requested === version ? MEDIA_IMMUTABLE : MEDIA_SHORT;

  // The cache holds the BYTES under the source's hash (rule 1: the key is ours, never a query
  // the visitor chose), so `?v=` variations and HEAD requests all land on one entry.
  const cache = cacheStore();
  const key = new Request(
    `${new URL(req.url).origin}/__pkey-media-cache/${product}/${asset}/${version}`,
  );
  let image: { bytes: Uint8Array; type: string } | null = null;
  if (cache) {
    const hit = await cache.match(key).catch(() => undefined);
    if (hit) {
      const bytes = new Uint8Array(await hit.arrayBuffer());
      const type = sniffImageType(bytes);
      if (type) image = { bytes, type };
    }
  }
  if (!image) {
    // `product` names a Durable Object shard, so it is charged only now that it is proven real.
    const ok = await rateLimitOk(
      env,
      product,
      {
        bucket: "portalMedia",
        id: `${product}:${clientNetwork(req)}`,
        limit: MEDIA_RATE_LIMIT,
        windowSec: 60,
      },
      now,
    );
    if (!ok) return refused(429);
    image = await fetchMedia(source, mediaMaxBytes(asset), fetchImpl);
    if (!image) return refused();
    if (cache) {
      await cache
        .put(
          key,
          new Response(image.bytes, {
            headers: {
              "content-type": "application/octet-stream",
              "cache-control": "public, max-age=86400",
            },
          }),
        )
        .catch(() => undefined);
    }
  }
  return new Response(req.method === "HEAD" ? null : image.bytes, {
    status: 200,
    headers: mediaResponseHeaders({
      "content-type": image.type,
      "content-length": String(image.bytes.byteLength),
      "cache-control": cacheControl,
      "content-disposition": "inline",
    }),
  });
}
