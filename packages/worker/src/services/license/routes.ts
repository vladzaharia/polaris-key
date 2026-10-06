/// <reference types="@cloudflare/workers-types" />

/**
 * License's own sub-router, over the path segments AFTER `/<product>/license`.
 *
 * Returning `null` rather than a 404 for an unmatched segment is the registry contract
 * (`core/registry.ts`): only Core knows whether "no route here" should be a not-found, and
 * centralising that is what makes a disabled service, an unregistered slug and a bad path
 * indistinguishable from outside.
 *
 * Method checks stay inside each handler, exactly as they were before the move, so a `GET
 * /license/activate` still answers `405` rather than falling through to a 404.
 */

import type { ServiceContext } from "../../core/registry.js";
import {
  handleActivate,
  handleDeauthorize,
  handleToken,
} from "./activation.js";
import { handleLicenseDocument } from "./document.js";
import { handleEnroll } from "./enroll.js";

export async function handleLicenseRoutes(
  ctx: ServiceContext,
): Promise<Response | null> {
  const { req, env, db, product, rest, now, waitUntil, settings } = ctx;
  if (rest.length !== 1) return null;
  switch (rest[0]) {
    case "activate":
      return handleActivate(req, env, db, product, now, waitUntil, settings);
    case "enroll":
      return handleEnroll(req, env, db, product, now, waitUntil);
    case "token":
      return handleToken(req, env, db, product, now);
    case "deauthorize":
      return handleDeauthorize(req, env, db, product);
    case "document":
      return handleLicenseDocument(req, env, db, product, now);
    default:
      return null;
  }
}
