/// <reference types="@cloudflare/workers-types" />

/**
 * Update's own sub-router, over the path segments AFTER `/<product>/update`.
 *
 *     /update/appcast.xml[?arch=]           (+ the permanent alias `/<p>/appcast.xml`)
 *     /update/<channel>/appcast.xml[?arch=] (+ the permanent alias `/<p>/<channel>/appcast.xml`)
 *     /update/version                        (+ the permanent alias `/<p>/version`)
 *     /update/<channel>/feed.jws?platform=   (P3-03, the signed channel feed; no alias)
 *     /update/<channel>/winsparkle.xml, /update/<channel>/velopack/releases.<vch>.json,
 *     /update/<channel>/app.appinstaller, /update/<channel>/<buildId>.AppImage.zsync
 *                                            (P3-09, the app-updater feeds: `updaterFeeds.ts`)
 *
 * The appcasts and the version check have two paths since P3-09: a product that publishes
 * release records gets the EXTENDED appcast (`updaterFeeds.ts`, rendered from the records and
 * Distribution's per-outlet state), and the version check's extended answer when it asks with
 * `?platform=`, `?arch=` or `?outlet=`; every other request runs the legacy, GitHub-resolved path
 * (`feed.ts`) unchanged.
 *
 * The aliases arrive here already rewritten into the canonical segments by the core router
 * (`router.ts`), so both spellings run this file's single code path and are byte-identical by
 * construction rather than by two implementations agreeing.
 */

import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";
import type { ReleaseAccess } from "@polaris-key/protocol/release";
import type { ServiceContext } from "../../core/registry.js";
import { handleUpdate } from "./feed.js";
import { handleFeedRoute } from "./feedDoc.js";
import { updateParams } from "./eligibility.js";
import {
  handleUpdaterFeedRoutes,
  isExtendedVersionRequest,
  recordedAppReleases,
  serveExtendedVersion,
  serveSparkle,
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

export async function handleUpdateRoutes(
  ctx: ServiceContext,
): Promise<Response | null> {
  const { req, env, db, product, rest } = ctx;

  if (rest.length === 1) {
    if (rest[0] === "appcast.xml") {
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
    if (rest[0] === "version") {
      // `?channel=` is held to the same alphabet as a PATH channel; a value the path form
      // could not express is refused here (→ the registry's 404) before any resolution.
      const channel = new URL(req.url).searchParams.get("channel");
      if (channel !== null && !CHANNEL.test(channel)) return null;
      if (isExtendedVersionRequest(req)) {
        const recorded = await recordedAppReleases(ctx);
        return recorded.length > 0
          ? serveExtendedVersion(ctx, channel ?? "stable", recorded)
          : null;
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
    return null;
  }

  // The signed channel feed (P3-03). No channel name contains a dot (`CHANNEL_NAME_PATTERN`), so
  // `feed.jws` sits beside `appcast.xml` without reserving a word.
  if (
    rest.length === 2 &&
    rest[1] === "feed.jws" &&
    CHANNEL.test(rest[0] ?? "")
  )
    return handleFeedRoute(ctx, rest[0] as string);

  if (rest.length >= 2 && CHANNEL.test(rest[0] ?? "")) {
    const feed = await handleUpdaterFeedRoutes(
      ctx,
      rest[0] as string,
      rest.slice(1),
    );
    if (feed) return feed;
  }

  if (
    rest.length === 2 &&
    rest[1] === "appcast.xml" &&
    CHANNEL.test(rest[0] ?? "")
  ) {
    const channel = rest[0] as string;
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

  return null;
}
