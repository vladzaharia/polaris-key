/// <reference types="@cloudflare/workers-types" />

/**
 * Storefront feed routes (P2b-05, README §3.8 "Storefront feeds"), under `/<p>/distribution`:
 *
 *     GET /altstore/<channel>/source.json        AltStore Classic / SideStore source
 *     GET /altstore-pal/<channel>/source.json    AltStore PAL source (with marketplaceID)
 *     GET /obtainium/<channel>.json              the Obtainium add-link app config
 *     GET /fdroid/<channel>/repo/<path…>         the F-Droid repository relay (`fdroid.ts`)
 *     GET /scoop/<channel>.json                  a Scoop app manifest
 *     GET /flathub/<channel>.json                Flathub x-checker-data JSON
 *     GET|POST /feeds/fdroid/<channel>           CI: the F-Droid generator's inputs / register
 *
 * Every feed is PUBLIC (no client here authenticates) and so exists only while the app's
 * delivery access is public; it is rendered per channel from Release's truth and Distribution's
 * state (`select.ts`) by a pure renderer (`render.ts`). `?outlet=<id>` picks one outlet when a
 * product declares several of a kind (`altstore` and `altstore-beta`, say); by default the outlet
 * whose id is the kind is used, else the first by id.
 *
 * Responses: `application/json`, a strong ETag of the body's SHA-256 (304 on `If-None-Match`),
 * `Cache-Control: public, max-age=300` (AltStore makes an update live the moment it reads it),
 * `nosniff` and the platform security headers. CORS is Core's per-product allowlist
 * (`core/cors.ts`); there is no per-route wildcard. Served on the console host only: none of
 * these is registered on the bytes host.
 *
 * Cost: the delivery-access check runs on every request; the rendered document is then served
 * from the feed cache (`cache.ts`, keyed by path, `?outlet=` and a stamp of the state a feed must
 * follow at once), so a cached answer is a handful of D1 reads and a miss a bounded selection
 * (`select.ts`).
 */

import type { ServiceContext } from "../../../core/registry.js";
import { errorResponse, notFound } from "../../../core/errors.js";
import { appSecurityHeaders } from "../../../core/platform.js";
import { bytesHostname } from "../../../core/bytesHost.js";
import { readCiJson, requireCiScope } from "../../../core/ciScope.js";
import { clientIp, rateLimitOk } from "../../../core/rateLimit.js";
import {
  renderAltStoreSource,
  renderFlathubChecker,
  renderObtainiumConfig,
  renderScoopManifest,
} from "./render.js";
import {
  feedReaders,
  pickOutlet,
  selectFeed,
  type FeedReadContext,
} from "./select.js";
import { fdroidInputs, registerFdroid, serveFdroidRelay } from "./fdroid.js";
import { cachedFeedText, feedCacheKey, feedStateStamp } from "./cache.js";

/** The first path segments this module answers (after `/<p>/distribution`). */
export const FEED_AREAS = [
  "altstore",
  "altstore-pal",
  "obtainium",
  "fdroid",
  "scoop",
  "flathub",
  "feeds",
] as const;

const FEED_CACHE = "public, max-age=300";
/** Public feed reads per IP: a cost budget (D1 reads), not a secret — fails open. */
const FEED_RATE_LIMIT = { limit: 60, windowSec: 60 } as const;
/** A register body: at most 256 small file entries and a ticket. */
const MAX_REGISTER_BODY_BYTES = 64 * 1024;

function decode(segment: string): string | null {
  try {
    const v = decodeURIComponent(segment);
    return v.length > 0 && v.length <= 64 ? v : null;
  } catch {
    return null;
  }
}

/** `<channel>.json` → the channel, or `null`. */
function channelOfFile(segment: string): string | null {
  return segment.endsWith(".json")
    ? decode(segment.slice(0, -".json".length))
    : null;
}

function harden(res: Response): Response {
  const headers = appSecurityHeaders(new Headers(res.headers));
  headers.set("x-content-type-options", "nosniff");
  return new Response(res.body, { status: res.status, headers });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** A feed document's body: pretty JSON and a final newline. */
function feedBody(doc: unknown): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** A feed document `body`: strong ETag of the body, revalidating cache. */
export async function feedResponse(
  req: Request,
  body: string,
): Promise<Response> {
  const etag = `"${await sha256Hex(body)}"`;
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": FEED_CACHE,
    etag,
    "x-content-type-options": "nosniff",
  };
  const inm = req.headers.get("if-none-match");
  if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag))
    return harden(new Response(null, { status: 304, headers }));
  return harden(
    new Response(req.method === "HEAD" ? null : body, {
      status: 200,
      headers,
    }),
  );
}

/** `.../distribution/<area>/…` as the absolute URL of this feed (its self-reference). */
function selfUrl(req: Request): string {
  const u = new URL(req.url);
  return `${u.origin}${u.pathname}${u.searchParams.get("outlet") ? `?outlet=${encodeURIComponent(u.searchParams.get("outlet") as string)}` : ""}`;
}

/** Reverse-DNS of the request host: `key.plrs.im` → `im.plrs.key`. */
function reverseHost(req: Request): string {
  return new URL(req.url).hostname.split(".").reverse().join(".");
}

/**
 * Distribution's feed routes. `null` when the path is not a feed path (the registry contract:
 * Core decides what "no route here" means); a feed path that names nothing is the plain
 * not-found.
 */
export async function handleFeedRoutes(
  ctx: ServiceContext,
): Promise<Response | null> {
  const { req, rest } = ctx;
  const area = rest[0] as (typeof FEED_AREAS)[number];
  if (!(FEED_AREAS as readonly string[]).includes(area)) return null;

  if (area === "feeds") {
    if (rest.length !== 3 || rest[1] !== "fdroid") return null;
    if (req.method !== "GET" && req.method !== "POST") return null;
    const channel = decode(rest[2] as string);
    if (channel === null) return harden(notFound());
    return harden(await handleFeedsCi(ctx, channel));
  }

  // Everything else is a public read.
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  const shape =
    area === "fdroid"
      ? rest.length >= 4 && rest[2] === "repo"
      : area === "altstore" || area === "altstore-pal"
        ? rest.length === 3 && rest[2] === "source.json"
        : rest.length === 2;
  if (!shape) return null;

  if (
    !(await rateLimitOk(
      ctx.env,
      ctx.product.slug,
      { bucket: "distributionFeed", id: clientIp(req), ...FEED_RATE_LIMIT },
      ctx.now,
    ))
  )
    return harden(errorResponse(429, "rate_limited", "too many feed requests"));

  const origin = new URL(req.url).origin;
  const fctx: FeedReadContext = {
    db: ctx.db,
    product: { slug: ctx.product.slug, name: ctx.product.name },
    hooks: ctx.hooks,
    origin,
    env: ctx.env,
  };
  const outletParam = new URL(req.url).searchParams.get("outlet");

  if (area === "fdroid") {
    const channel = decode(rest[1] as string);
    if (channel === null) return harden(notFound());
    return serveFdroidRelay(
      { ...fctx, req, env: ctx.env },
      channel,
      rest.slice(3),
    );
  }

  const channel =
    area === "altstore" || area === "altstore-pal"
      ? decode(rest[1] as string)
      : channelOfFile(rest[1] as string);
  if (channel === null) return harden(notFound());
  // Never cached: a deliverable made non-public has no feed from this request on.
  const readers = await feedReaders(fctx);
  if (!readers) return harden(notFound());
  const key = feedCacheKey(
    origin,
    new URL(req.url).pathname,
    outletParam,
    await feedStateStamp(
      ctx.db,
      ctx.product.slug,
      readers.catalog,
      readers.notesPublic,
    ),
  );
  const body = await cachedFeedText(key, async () => {
    const doc = await renderArea(ctx, fctx, area, channel, outletParam);
    return doc === null ? null : feedBody(doc);
  });
  return body === null ? harden(notFound()) : feedResponse(req, body);
}

async function renderArea(
  ctx: ServiceContext,
  fctx: FeedReadContext,
  area: "altstore" | "altstore-pal" | "obtainium" | "scoop" | "flathub",
  channel: string,
  outletParam: string | null,
): Promise<unknown | null> {
  const { req, env, product } = ctx;
  switch (area) {
    case "altstore":
    case "altstore-pal": {
      const sel = await selectFeed(fctx, channel, {
        kinds: [area],
        outletId: outletParam,
        platform: "ios",
        liveness: "availability",
      });
      if (!sel) return null;
      const marketplaceId = sel.outlet.identity.marketplaceId;
      if (area === "altstore-pal" && typeof marketplaceId !== "string")
        return null;
      return renderAltStoreSource({
        flavour: area === "altstore" ? "classic" : "pal",
        sourceUrl: selfUrl(req),
        identifier: `${reverseHost(req)}.${product.slug}.${area}.${sel.channel}${
          outletParam ? `.${sel.outlet.id}` : ""
        }`,
        productName: product.name,
        listing: sel.outlet.listing,
        bundleId:
          typeof sel.outlet.identity.bundleId === "string"
            ? sel.outlet.identity.bundleId
            : null,
        ...(area === "altstore-pal"
          ? { marketplaceId: marketplaceId as string }
          : {}),
        entries: sel.entries,
      });
    }

    case "obtainium":
      return obtainiumConfig(fctx, channel, outletParam);

    case "scoop": {
      const sel = await selectFeed(fctx, channel, {
        kinds: ["direct"],
        outletId: outletParam,
        platform: "windows",
        liveness: "availability",
        limit: 1,
        allBuilds: true,
        accepts: (o) =>
          !Array.isArray(o.identity.platforms) ||
          o.identity.platforms.includes("windows"),
      });
      if (!sel) return null;
      const scoop = sel.outlet.identity.scoop as
        | { bin?: string | string[]; shortcuts?: [string, string][] }
        | undefined;
      return renderScoopManifest({
        feedUrl: selfUrl(req),
        productName: product.name,
        listing: sel.outlet.listing,
        ...(scoop?.bin !== undefined ? { bin: scoop.bin } : {}),
        ...(scoop?.shortcuts !== undefined
          ? { shortcuts: scoop.shortcuts }
          : {}),
        entries: sel.entries,
      });
    }

    case "flathub": {
      const sel = await selectFeed(fctx, channel, {
        kinds: ["flathub"],
        outletId: outletParam,
        platform: "linux",
        // The checker tells Flathub where OUR bytes are; it cannot wait for Flathub to say the
        // build is live there (that is what the checker leads to).
        liveness: "bytes",
        limit: 1,
        allBuilds: true,
      });
      if (!sel) return null;
      return renderFlathubChecker(sel.entries);
    }
  }
}

/**
 * The Obtainium app config of one channel (`GET …/obtainium/<channel>.json`), or `null` (the
 * route's not-found). Exported for the download page (P2b-06), whose "Add to Obtainium" link
 * carries this same document as `obtainium://app/<url-encoded JSON>`.
 */
export async function obtainiumConfig(
  fctx: FeedReadContext,
  channel: string,
  outletParam: string | null,
): Promise<unknown | null> {
  const sel = await selectFeed(fctx, channel, {
    kinds: ["obtainium"],
    outletId: outletParam,
    platform: "android",
    liveness: "availability",
    limit: 1,
  });
  if (!sel) return null;
  const head = sel.entries[0];
  const packageName =
    (typeof sel.outlet.identity.packageName === "string"
      ? sel.outlet.identity.packageName
      : null) ??
    (typeof head?.metadata?.packageName === "string"
      ? head.metadata.packageName
      : null);
  if (!packageName) return null;
  const listing = sel.outlet.listing ?? {};
  const name = listing.name ?? fctx.product.name;
  const author = listing.developerName ?? name;
  // A live F-Droid repository on this channel is the better source: real version codes,
  // arch selection and stable/beta filtering. The channel is the one just resolved, so only
  // the outlet's existence is asked here, never a second selection.
  const repo = await pickOutlet(fctx.db, fctx.product.slug, {
    kinds: ["fdroid-repo"],
  });
  if (repo)
    return renderObtainiumConfig({
      source: "fdroid-repo",
      packageName,
      name,
      author,
      repoUrl: `${fctx.origin}/${fctx.product.slug}/distribution/fdroid/${encodeURIComponent(sel.channel)}/repo`,
      stable: sel.channel === "stable",
    });
  const buildId =
    (typeof sel.outlet.identity.artifact === "string"
      ? sel.outlet.identity.artifact
      : null) ?? head?.buildId;
  if (!buildId) return null;
  const bytesBase =
    bytesHostname(fctx.env) && fctx.env.BLOB_ORIGIN
      ? new URL(fctx.env.BLOB_ORIGIN).origin
      : fctx.origin;
  return renderObtainiumConfig({
    source: "direct",
    packageName,
    name,
    author,
    apkUrl: `${bytesBase}/${fctx.product.slug}/distribution/builds/${encodeURIComponent(sel.channel)}/${encodeURIComponent(buildId)}`,
  });
}

/** `GET|POST /<p>/distribution/feeds/fdroid/<channel>` — `distribution:feeds`. */
async function handleFeedsCi(
  ctx: ServiceContext,
  channel: string,
): Promise<Response> {
  const { req, env, db, product, hooks, now } = ctx;
  const principal = await requireCiScope(
    req,
    env,
    db,
    product.slug,
    "distribution:feeds",
    now,
  );
  if (principal instanceof Response) return principal;
  const fctx: FeedReadContext = {
    db,
    product: { slug: product.slug, name: product.name },
    hooks,
    origin: new URL(req.url).origin,
    env,
  };
  if (req.method === "GET") return fdroidInputs(fctx, channel);
  const body = await readCiJson(req, MAX_REGISTER_BODY_BYTES);
  if (body instanceof Response) return body;
  return registerFdroid({ ...fctx, now, principal }, channel, body);
}
