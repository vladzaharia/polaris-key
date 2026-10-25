/// <reference types="@cloudflare/workers-types" />

/**
 * Distribution's routes, as a table (`core/http/routes.ts`), over the path AFTER `/<product>/distribution`.
 *
 *     /distribution/install.sh                               (P2b-04, `bytes.ts`)
 *     /distribution/dl/:version/:binary-:arch[.dmg]
 *     /distribution/builds/:selector/:buildId                GET|HEAD, also on the bytes host
 *     /distribution/files/:releaseId/:name                   GET|HEAD, also on the bytes host
 *     /distribution/blobs/sha256/:hash                       GET|HEAD, also on the bytes host
 *     /distribution/packs/:pack/:variant/payload/:sha256     GET|HEAD, also on the bytes host
 *                                                            (P4-18, `payload.ts`)
 *     /distribution/rollouts/:outlet/:channel                POST, `pkeyci_` + distribution:rollout
 *     /distribution/rollouts/:outlet/:channel/{pause,resume,halt,complete}   POST, same
 *     /distribution/report                                   POST, `pkeyci_` + distribution:report
 *                                                            (P2b-03, `availability.ts`; A-18h's
 *                                                            store steps, `storeSteps.ts`)
 *     /distribution/listing/:store                           GET, `pkeyci_` + distribution:report:
 *                                                            a CI-plane store's listing projection
 *                                                            (A-18h, `listing/ci.ts`)
 *     /distribution/pr/:store?channel=c&outlet=id            GET, `pkeyci_` + distribution:report:
 *                                                            a PR-plane generator's inputs (A-18i,
 *                                                            `prInputs.ts`)
 *     /distribution/hooks/:connector                         POST, a store webhook, signed by
 *                                                            the store (P5-02, `connectors/`;
 *                                                            `asc` today)
 *     /distribution/hooks/sentry                             POST, a Sentry alert, signed with
 *                                                            the integration's client secret;
 *                                                            opens halt candidates (P6-03,
 *                                                            `sentry.ts`)
 *     /distribution/{altstore,altstore-pal}/:channel/source.json   GET, storefront feeds
 *     /distribution/{obtainium,scoop,flathub}/:channel.json         (P2b-05, `feeds/`)
 *     /distribution/fdroid/:channel/repo/:path…              GET, the F-Droid repository relay
 *     /distribution/feeds/fdroid/:channel                    GET|POST, `pkeyci_` +
 *                                                            distribution:feeds
 *     /distribution/listing/assets                           POST, `pkeyci_` +
 *                                                            distribution:listing: register the
 *                                                            listing assets CI derived (A-18d,
 *                                                            `listing/assets.ts`)
 *     /distribution/download.json                            GET, the public download page's
 *                                                            model (P2b-06, `page/`)
 *
 * The download page itself (`/distribution/download`, and `/<p>`) is served ONLY on the bytes
 * host (`page/index.ts` `DOWNLOAD_PAGE_ROUTE`): here both are the not-found, so no repo-authored
 * HTML is ever served on the console's origin.
 *
 * The permanent aliases (`/<p>/release/{install.sh,dl,builds,files,blobs}/…`, `/<p>/install.sh`)
 * reach this file already rewritten into the canonical segments by the core router, so there is
 * one code path per surface. Returning `null` for an unmatched path is the registry contract:
 * only Core decides what "no route here" means.
 */

import type { ServiceContext } from "../../core/registry.js";
import { errorResponse, ErrorCode, json, notFound } from "../../core/errors.js";
import {
  serviceRoutes,
  type RouteMatch,
  type ServiceRouteDecl,
} from "../../core/http/routes.js";
import {
  byteTargetOf,
  serveDistributionBytes,
  type ByteTarget,
} from "./bytes.js";
import {
  applyRollout,
  ROLLOUT_VERBS,
  type RolloutRefusal,
  type RolloutVerb,
} from "./rollouts.js";
import { applyReport } from "./availability.js";
import { ciListingProjection, ciListingStore } from "./listing/ci.js";
import { prInputs, prInputStore } from "./prInputs.js";
import { connectorOf } from "./connectors/index.js";
import { handleSentryWebhook } from "./sentry.js";
import { handleFdroidFeedsCi, serveFeedRead } from "./feeds/index.js";
import { handleDownloadModel } from "./page/index.js";
import {
  MAX_LISTING_ASSETS_BODY_BYTES,
  registerListingAssets,
} from "./listing/assets.js";

/** A rollout body is tiny (`{deliverable?, releaseId?, bp?}`); a report carries at most two small
 *  JSON objects (`platformRef`, `detail`). */
const MAX_CI_BODY_BYTES = 16 * 1024;

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function rolloutRefusal(r: RolloutRefusal): Response {
  return errorResponse(r.status, r.code, r.message, {
    reason: r.reason,
    ...(r.fields ? { fields: r.fields } : {}),
  });
}

// ── The bytes ────────────────────────────────────────────────────────────────────────────────
//
// `byteTargetOf` is the one parser of a byte path, shared with the bytes host (`bytesHost.ts`) so
// the two can never disagree; each row's `accept` runs it, and a path it does not name is no
// route. P2-05's byte routes answer only GET and HEAD, with a 405 that names them; the legacy
// installer and download never checked the method, and the handler still does not.

const BYTES_ONLY_READS = (): Response =>
  new Response(null, {
    status: 405,
    headers: { allow: "GET, HEAD", "cache-control": "no-store" },
  });

function byteRow(
  kind: ByteTarget["kind"],
  row: Pick<ServiceRouteDecl, "path" | "doc" | "methods" | "alsoHead">,
  reads: boolean,
): ServiceRouteDecl {
  return {
    ...row,
    cors: true,
    auth: { kind: "handler" },
    other: reads ? BYTES_ONLY_READS : "handler",
    accept: (ctx) => byteTargetOf(ctx.rest)?.kind === kind,
    handler: ({ req, env, db, product, hooks, now, rest }) =>
      serveDistributionBytes(
        { req, env, db, product, hooks, now },
        byteTargetOf(rest) as ByteTarget,
      ),
  };
}

// ── CI plane ─────────────────────────────────────────────────────────────────────────────────

/** `POST /<p>/distribution/rollouts/<outlet>/<channel>[/<verb>]` — `distribution:rollout`. */
async function ciRollout(
  ctx: ServiceContext,
  m: RouteMatch,
  verb: RolloutVerb,
): Promise<Response> {
  const { db, product, hooks, now } = ctx;
  const body = await m.readJson();
  if (body instanceof Response) return body;
  const outlet = decodeSegment(m.params.outlet as string);
  const channel = decodeSegment(m.params.channel as string);
  if (outlet === null || channel === null)
    return errorResponse(404, ErrorCode.NotFound, "no such rollout", {
      reason: "unknown_outlet",
    });
  const result = await applyRollout(
    { db, product: product.slug, hooks, now },
    verb,
    {
      outlet,
      channel,
      deliverable: body.deliverable,
      releaseId: body.releaseId,
      bp: body.bp,
    },
    { kind: "ci", principal: m.principal! },
  );
  if (!result.ok) return rolloutRefusal(result);
  return json({ ok: true, rollout: result.rollout });
}

/**
 * `POST /<p>/distribution/report` — `distribution:report` (in the default CI grant). Records
 * availability or a submission state for (release, outlet), or the fingerprint CI signed with
 * (`availability.ts` `applyReport`). A refused report writes nothing.
 */
async function ciReport(ctx: ServiceContext, m: RouteMatch): Promise<Response> {
  const { db, product, hooks, now } = ctx;
  const body = await m.readJson();
  if (body instanceof Response) return body;
  const result = await applyReport(
    { db, product: product.slug, hooks, now },
    body,
    m.principal!,
  );
  if (!result.ok) return rolloutRefusal(result);
  return json(result);
}

/**
 * `GET /<p>/distribution/pr/<store>?channel=<c>[&outlet=<id>]` — `distribution:report`. What a
 * PR-plane generator needs for the channel's newest release on the outlet (A-18i, `prInputs.ts`).
 * The not-found while the app's delivery access is not public, or for no such channel or outlet.
 */
async function ciPrInputs(
  ctx: ServiceContext,
  m: RouteMatch,
): Promise<Response> {
  const { req, env, db, product, hooks } = ctx;
  const store = prInputStore(decodeSegment(m.params.store as string) ?? "");
  if (!store) return notFound();
  const url = new URL(req.url);
  const channel = url.searchParams.get("channel") ?? "stable";
  const outlet = url.searchParams.get("outlet");
  if (
    channel.length === 0 ||
    channel.length > 64 ||
    (outlet !== null && (outlet.length === 0 || outlet.length > 64))
  )
    return notFound();
  const inputs = await prInputs(
    {
      db,
      product: { slug: product.slug, name: product.name },
      hooks,
      origin: url.origin,
      env,
    },
    store,
    channel,
    outlet,
  );
  if (!inputs) return notFound();
  return json({ ok: true, inputs });
}

// ── The table ────────────────────────────────────────────────────────────────────────────────

const READS = ["GET"] as const;

/** A public feed read: GET (and an undocumented HEAD), the shape checked by the pattern. */
function feedRow(
  path: string,
  area: Parameters<typeof serveFeedRead>[1],
  doc: string,
): ServiceRouteDecl {
  return {
    path,
    doc,
    cors: true,
    methods: READS,
    alsoHead: true,
    auth: { kind: "none" },
    other: "none",
    handler: (ctx) => serveFeedRead(ctx, area),
  };
}

export const DISTRIBUTION_ROUTES = serviceRoutes("distribution", [
  byteRow("install", { path: "install.sh", methods: ["GET"] }, false),
  byteRow("dl", { path: "dl/:version/:asset", methods: ["GET"] }, false),
  byteRow(
    "build",
    { path: "builds/:selector/:buildId", methods: ["GET"], alsoHead: true },
    true,
  ),
  byteRow(
    "file",
    { path: "files/:releaseId/:name", methods: ["GET"], alsoHead: true },
    true,
  ),
  byteRow(
    "blob",
    { path: "blobs/sha256/:sha256", methods: ["GET", "HEAD"] },
    true,
  ),
  byteRow(
    "payload",
    {
      path: "packs/:pack/:variant/payload/:sha256",
      methods: ["GET", "HEAD"],
    },
    true,
  ),

  // The CI rollout routes (`distribution:rollout`): the set, then the four verbs.
  {
    path: "rollouts/:outlet/:channel",
    methods: ["POST"],
    auth: { kind: "ci", scope: "distribution:rollout" },
    bodyCap: MAX_CI_BODY_BYTES,
    other: "none",
    handler: (ctx, m) => ciRollout(ctx, m, "set"),
  },
  ...ROLLOUT_VERBS.map(
    (verb): ServiceRouteDecl => ({
      path: `rollouts/:outlet/:channel/${verb}`,
      methods: ["POST"],
      auth: { kind: "ci", scope: "distribution:rollout" },
      bodyCap: MAX_CI_BODY_BYTES,
      other: "none",
      handler: (ctx, m) => ciRollout(ctx, m, verb),
    }),
  ),
  {
    path: "report",
    methods: ["POST"],
    auth: { kind: "ci", scope: "distribution:report" },
    bodyCap: MAX_CI_BODY_BYTES,
    other: "none",
    handler: ciReport,
  },
  // The listing assets `pkey listing assets` derived and uploaded (A-18d).
  {
    path: "listing/assets",
    methods: ["POST"],
    auth: { kind: "ci", scope: "distribution:listing" },
    bodyCap: MAX_LISTING_ASSETS_BODY_BYTES,
    other: "none",
    handler: async ({ env, db, product, now }, m) => {
      const body = await m.readJson();
      if (body instanceof Response) return body;
      return registerListingAssets(
        { env, db, product: product.slug, now, principal: m.principal! },
        body,
      );
    },
  },
  // A-18h: a CI-plane store's projection of the listing model (`listing/ci.ts`). A store it does
  // not know is the not-found, before any credential.
  {
    path: "listing/:store",
    methods: ["GET"],
    auth: { kind: "ci", scope: "distribution:report" },
    other: "none",
    accept: (_ctx, p) =>
      ciListingStore(decodeSegment(p.store as string) ?? "") !== null,
    handler: async ({ db, product }, m) =>
      json({
        ok: true,
        listing: await ciListingProjection(
          db,
          product.slug,
          ciListingStore(decodeSegment(m.params.store as string) ?? "")!,
        ),
      }),
  },
  // A-18i: a PR-plane generator's inputs (`prInputs.ts`).
  {
    path: "pr/:store",
    methods: ["GET"],
    auth: { kind: "ci", scope: "distribution:report" },
    other: "none",
    accept: (_ctx, p) =>
      Boolean(prInputStore(decodeSegment(p.store as string) ?? "")),
    handler: ciPrInputs,
  },

  // The Sentry alert hook (P6-03) opens halt candidates; it is not a store connector.
  {
    path: "hooks/sentry",
    methods: ["POST"],
    auth: { kind: "signature" },
    other: "none",
    handler: (ctx) => handleSentryWebhook(ctx),
  },
  // A store webhook. `null` (Core's not-found) for an unknown connector, one without a webhook,
  // or a product the connector is not set up for — the connector decides the last. `asc` is the
  // one connector today, and the one the spec documents.
  {
    path: "hooks/:connector",
    doc: "hooks/asc",
    methods: ["POST"],
    auth: { kind: "signature" },
    other: "none",
    accept: (_ctx, p) =>
      connectorOf(p.connector as string)?.webhook !== undefined,
    handler: (ctx, m) =>
      connectorOf(m.params.connector as string)!.webhook!(ctx),
  },

  // The storefront feeds and the F-Droid relay (P2b-05, `feeds/`).
  feedRow(
    "altstore/:channel/source.json",
    "altstore",
    "altstore/{channel}/source.json",
  ),
  feedRow(
    "altstore-pal/:channel/source.json",
    "altstore-pal",
    "altstore-pal/{channel}/source.json",
  ),
  feedRow("obtainium/:file", "obtainium", "obtainium/{channel}.json"),
  feedRow("scoop/:file", "scoop", "scoop/{channel}.json"),
  feedRow("flathub/:file", "flathub", "flathub/{channel}.json"),
  feedRow(
    "fdroid/:channel/repo/:file/**",
    "fdroid",
    "fdroid/{channel}/repo/{path}",
  ),
  // The CI plane's F-Droid feed: reads its own `pkeyci_` token after the channel decodes.
  {
    path: "feeds/fdroid/:channel",
    methods: ["GET", "POST"],
    auth: { kind: "handler" },
    other: "none",
    handler: (ctx) => handleFdroidFeedsCi(ctx),
  },

  // The download page's model (P2b-06). The page itself never answers here: it is served ONLY on
  // the bytes host (`page/index.ts` `DOWNLOAD_PAGE_ROUTE`), so no repo-authored HTML is ever
  // served on the console's origin.
  {
    path: "download.json",
    cors: true,
    methods: ["GET"],
    alsoHead: true,
    auth: { kind: "none" },
    other: "none",
    handler: (ctx) => handleDownloadModel(ctx),
  },
  {
    path: "download",
    methods: ["GET"],
    auth: { kind: "none" },
    other: "none",
    handler: async () => null,
  },
]);
