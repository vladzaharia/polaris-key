/// <reference types="@cloudflare/workers-types" />

/**
 * Update's routes, as a table (`core/http/routes.ts`), over the path AFTER `/<product>/update`.
 *
 *     /update/appcast.xml[?arch=]           (+ the permanent alias `/<p>/appcast.xml`)
 *     /update/<channel>/appcast.xml[?arch=] (+ the permanent alias `/<p>/<channel>/appcast.xml`)
 *     /update/version                        (+ the permanent alias `/<p>/version`)
 *     /update/<channel>/feed.jws?platform=   (P3-03, the signed channel feed; no alias)
 *     /update/<channel>/winsparkle.xml, /update/<channel>/velopack/releases.<vch>.json,
 *     /update/<channel>/app.appinstaller, /update/<channel>/<buildId>.AppImage.zsync
 *                                            (P3-09, the app-updater feeds: `updaterFeeds.ts`)
 *     /update/<channel>/velopack/<FileName>  (notes/S-11 §5.1: 302 to a listed Velopack package)
 *
 * The appcasts and the version check have two paths since P3-09: a product that publishes
 * release records gets the EXTENDED appcast (`updaterFeeds.ts`, rendered from the records and
 * Distribution's per-outlet state), and the version check's extended answer when it names
 * `?platform=` (`?arch=`, `?outlet=` and `?build=` only refine it); every other request runs the
 * legacy, GitHub-resolved path
 * (`feed.ts`) unchanged.
 *
 * The aliases arrive here already rewritten into the canonical segments by the core router
 * (`router.ts`), so both spellings run this file's single code path and are byte-identical by
 * construction rather than by two implementations agreeing.
 */

import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";
import type { ReleaseAccess } from "@polaris-key/protocol/release";
import { serviceRoutes } from "../../core/http/routes.js";
import type { ServiceContext } from "../../core/registry.js";
import { handleUpdate } from "./feed.js";
import { handleFeedRoute } from "./feedDoc.js";
import { updateParams } from "./eligibility.js";
import {
  ZSYNC_NAME,
  isExtendedVersionRequest,
  isVelopackFileName,
  recordedAppReleases,
  serveAppInstaller,
  serveExtendedVersion,
  serveSparkle,
  serveVelopack,
  serveVelopackPackage,
  serveWinSparkle,
  serveZsync,
  zsyncBuildId,
} from "./updaterFeeds.js";
import { appcastArch } from "./feed.js";

/** Channel names the router will hand through, matching the product-slug class. */
const CHANNEL = /^[a-z0-9-]+$/;

/**
 * Who may read an appcast: Distribution's delivery access for the app (P2b-04). `undefined`
 * when Distribution is off — impossible for a coherent product (`update_requires_distribution`),
 * and the gateway then fails closed to `entitled`.
 */
async function appcastAccess(
  ctx: ServiceContext,
): Promise<ReleaseAccess | undefined> {
  return (
    (await ctx.hooks.delivery()?.accessMode(APP_DELIVERABLE_ID)) ?? undefined
  );
}

/** The channel-less appcast (`/update/appcast.xml`, the alias `/<p>/appcast.xml`). */
async function appcast(ctx: ServiceContext): Promise<Response> {
  const { req, env, db, product } = ctx;
  const recorded = await recordedAppReleases(ctx);
  if (recorded.length > 0)
    return serveSparkle(ctx, "stable", appcastArch(req), recorded);
  return handleUpdate(
    req,
    env,
    db,
    product,
    "appcast",
    updateParams(req, "appcast"),
    undefined,
    await appcastAccess(ctx),
    ctx.waitUntil,
  );
}

/** `/update/<channel>/appcast.xml` (the alias `/<p>/<channel>/appcast.xml`). */
async function channelAppcast(
  ctx: ServiceContext,
  channel: string,
): Promise<Response> {
  const { req, env, db, product } = ctx;
  const recorded = await recordedAppReleases(ctx);
  if (recorded.length > 0)
    return serveSparkle(ctx, channel, appcastArch(req), recorded);
  return handleUpdate(
    req,
    env,
    db,
    product,
    "channelAppcast",
    updateParams(req, "channelAppcast", channel),
    undefined,
    await appcastAccess(ctx),
    ctx.waitUntil,
  );
}

/** The version check: extended when `?platform=` names it and the product publishes records. */
async function version(ctx: ServiceContext): Promise<Response | null> {
  const { req, env, db, product } = ctx;
  // `?channel=` is held to the same alphabet as a PATH channel; a value the path form
  // could not express is refused here (→ the registry's 404) before any resolution.
  const channel = new URL(req.url).searchParams.get("channel");
  if (channel !== null && !CHANNEL.test(channel)) return null;
  // Extended only when `?platform=` is named AND the product publishes release records;
  // otherwise the legacy answer, so every URL that worked before keeps working.
  if (isExtendedVersionRequest(req)) {
    const recorded = await recordedAppReleases(ctx);
    if (recorded.length > 0)
      return serveExtendedVersion(ctx, channel ?? "stable", recorded);
  }
  return handleUpdate(
    req,
    env,
    db,
    product,
    "version",
    updateParams(req, "version"),
  );
}

const CHANNEL_PARAM = { channel: CHANNEL };

export const UPDATE_ROUTES = serviceRoutes("update", [
  {
    path: "appcast.xml",
    methods: ["GET"],
    alsoHead: true,
    auth: { kind: "handler" },
    handler: appcast,
  },
  {
    path: "version",
    methods: ["GET"],
    alsoHead: true,
    auth: { kind: "none" },
    handler: version,
  },
  // The signed channel feed (P3-03). No channel name contains a dot (`CHANNEL_NAME_PATTERN`), so
  // `feed.jws` sits beside `appcast.xml` without reserving a word.
  {
    path: ":channel/feed.jws",
    methods: ["GET"],
    alsoHead: true,
    auth: { kind: "handler" },
    other: "none",
    params: CHANNEL_PARAM,
    handler: (ctx, { params }) =>
      handleFeedRoute(ctx, params.channel as string),
  },
  {
    path: ":channel/appcast.xml",
    methods: ["GET"],
    alsoHead: true,
    auth: { kind: "handler" },
    params: CHANNEL_PARAM,
    handler: (ctx, { params }) => channelAppcast(ctx, params.channel as string),
  },
  // P3-09, the app-updater feeds. A request that is not a read is the not-found.
  {
    path: ":channel/winsparkle.xml",
    methods: ["GET"],
    alsoHead: true,
    auth: { kind: "handler" },
    other: "none",
    params: CHANNEL_PARAM,
    handler: async (ctx, { params }) =>
      serveWinSparkle(
        ctx,
        params.channel as string,
        await recordedAppReleases(ctx),
      ),
  },
  {
    path: ":channel/app.appinstaller",
    methods: ["GET"],
    alsoHead: true,
    auth: { kind: "handler" },
    other: "none",
    params: CHANNEL_PARAM,
    handler: async (ctx, { params }) =>
      serveAppInstaller(
        ctx,
        params.channel as string,
        await recordedAppReleases(ctx),
      ),
  },
  {
    path: ":channel/:name",
    doc: "{channel}/{buildId}.AppImage.zsync",
    methods: ["GET"],
    alsoHead: true,
    auth: { kind: "handler" },
    other: "none",
    params: { ...CHANNEL_PARAM, name: ZSYNC_NAME },
    handler: async (ctx, { params }) =>
      serveZsync(
        ctx,
        params.channel as string,
        zsyncBuildId(params.name as string),
        await recordedAppReleases(ctx),
      ),
  },
  // `releases.<vch>.json`, or a listed package (notes/S-11 §5.1: 302 to it).
  {
    path: ":channel/velopack/:file",
    doc: [
      "{channel}/velopack/releases.{velopackChannel}.json",
      "{channel}/velopack/{fileName}",
    ],
    methods: ["GET"],
    alsoHead: true,
    auth: { kind: "handler" },
    other: "none",
    params: CHANNEL_PARAM,
    handler: async (ctx, { params }) => {
      const channel = params.channel as string;
      const file = params.file as string;
      if (/^releases\./.test(file))
        return serveVelopack(
          ctx,
          channel,
          file,
          await recordedAppReleases(ctx),
        );
      // The package name is checked before ANY read, the recorded-releases D1 read included.
      if (!isVelopackFileName(file)) return null;
      return serveVelopackPackage(
        ctx,
        channel,
        file,
        await recordedAppReleases(ctx),
      );
    },
  },
]);
