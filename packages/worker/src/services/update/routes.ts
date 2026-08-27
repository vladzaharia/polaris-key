/// <reference types="@cloudflare/workers-types" />

/**
 * Update's own sub-router, over the path segments AFTER `/<product>/update`.
 *
 *     /update/appcast.xml[?arch=]           (+ the permanent alias `/<p>/appcast.xml`)
 *     /update/<channel>/appcast.xml[?arch=] (+ the permanent alias `/<p>/<channel>/appcast.xml`)
 *     /update/version                        (+ the permanent alias `/<p>/version`)
 *
 * The aliases arrive here already rewritten into the canonical segments by the core router
 * (`router.ts`), so both spellings run this file's single code path and are byte-identical by
 * construction rather than by two implementations agreeing.
 */

import type { ServiceContext } from "../../core/registry.js";
import { handleUpdate } from "./feed.js";
import { updateParams } from "./eligibility.js";

/** Channel names the router will hand through, matching the product-slug class. */
const CHANNEL = /^[a-z0-9-]+$/;

export async function handleUpdateRoutes(
  ctx: ServiceContext,
): Promise<Response | null> {
  const { req, env, db, product, rest } = ctx;

  if (rest.length === 1) {
    if (rest[0] === "appcast.xml") {
      return handleUpdate(
        req,
        env,
        db,
        product,
        "appcast",
        updateParams(req, "appcast"),
      );
    }
    if (rest[0] === "version") {
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

  if (
    rest.length === 2 &&
    rest[1] === "appcast.xml" &&
    CHANNEL.test(rest[0] ?? "")
  ) {
    const channel = rest[0] as string;
    return handleUpdate(
      req,
      env,
      db,
      product,
      "channelAppcast",
      updateParams(req, "channelAppcast", channel),
    );
  }

  return null;
}
