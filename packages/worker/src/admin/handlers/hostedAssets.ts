/**
 * The product's hosted assets in the console (HA-05, HA-08; notes/S-20 §6.4, §6.8):
 *
 *   GET  /manage/api/products/<slug>/assets          every hosted asset of the product, with
 *        where it came from, its status and the pull it still owes. Read-only; the console's
 *        Presentation page (HA-06) reads it to show a slot's copy, its failure (`failed` /
 *        `stale` with the reason code) and whether a newer manifest ref is still being pulled.
 *        HA-06 adds the upload, Refresh and Revert actions beside it.
 *   POST /manage/api/products/<slug>/assets/mirror   the operator's "mirror now" (HA-08): every
 *        release file that still owes a copy of ours is queued at once, back-off or not, at most
 *        `MIRROR_OPERATOR_MAX_PER_RUN` per request (`services/release/mirror.ts`). Answers how many
 *        were queued and how many still owe one; audited as `assets.mirror`.
 *
 * CORE, like `activity`: a product has hosted assets whether or not it runs Distribution
 * (`presentation.icon` is `.pkey/product`'s). The mirror action is composed here, in the admin
 * layer, because the files and their GitHub access are Release's. Gated by the dispatcher like
 * every product-scoped resource; the POST is CSRF-checked there like every mutation.
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../env.js";
import { ErrorCode } from "../../core/errors.js";
import { listHostedAssetViews } from "../../core/hostedAssetPulls.js";
import { mirrorNow } from "../../services/release/mirror.js";
import { audit } from "../audit.js";
import { adminJson, err } from "../lib/respond.js";
import type { AdminSession } from "../session.js";

export async function handleHostedAssets(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  rest: string[],
  now: number,
): Promise<Response> {
  if (rest.length === 1 && rest[0] === "mirror") {
    if (req.method !== "POST")
      return err(405, "method_not_allowed", "POST to queue the mirrors");
    const result = await mirrorNow(env, db, slug, now);
    if (!result.ok)
      return result.reason === "disabled"
        ? err(
            409,
            "mirror_disabled",
            "release-file mirroring is off for this product (Release is off)",
          )
        : err(
            503,
            "unavailable",
            "no blob store or asset queue is bound on this deployment",
          );
    await audit(
      db,
      slug,
      session,
      now,
      "assets.mirror",
      { kind: "product", id: slug },
      `Queued ${result.queued} release file${result.queued === 1 ? "" : "s"} for a copy of Polaris Key's own (${result.owed} still owe one)`,
    );
    return adminJson({ queued: result.queued, owed: result.owed });
  }
  if (rest.length > 0) return err(404, ErrorCode.NotFound);
  if (req.method !== "GET" && req.method !== "HEAD")
    return err(405, "method_not_allowed", "assets are read-only here");
  return adminJson({ assets: await listHostedAssetViews(db, slug) });
}
