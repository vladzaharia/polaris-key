/**
 * `GET /manage/api/products/<slug>/assets` (HA-05; notes/S-20 §6.4): every hosted asset of the
 * product, with where it came from, its status and the pull it still owes. Read-only; the
 * console's Presentation page (HA-06) reads it to show a slot's copy, its failure
 * (`failed` / `stale` with the reason code) and whether a newer manifest ref is still being
 * pulled. HA-06 adds the upload, Refresh and Revert actions beside it.
 *
 * CORE, like `activity`: a product has hosted assets whether or not it runs Distribution
 * (`presentation.icon` is `.pkey/product`'s). Platform-admin gated by the dispatcher.
 */

import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../core/errors.js";
import { listHostedAssetViews } from "../../core/hostedAssetPulls.js";
import { adminJson, err } from "../lib/respond.js";

export async function handleHostedAssets(
  req: Request,
  db: Db,
  slug: string,
  rest: string[],
): Promise<Response> {
  if (rest.length > 0) return err(404, ErrorCode.NotFound);
  if (req.method !== "GET" && req.method !== "HEAD")
    return err(405, "method_not_allowed", "assets are read-only here");
  return adminJson({ assets: await listHostedAssetViews(db, slug) });
}
