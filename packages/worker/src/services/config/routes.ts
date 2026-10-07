/// <reference types="@cloudflare/workers-types" />

/**
 * Config's own sub-router, over the path segments AFTER `/<product>/config`.
 *
 * Note what is NOT here: a bare `/<product>/config`. The fused v2 document is gone, split into
 * `/config/document` and `/license/document` (§R1), and the old path now falls through to the
 * registry's not-found like any other unmatched segment. That is deliberate — a route that
 * used to return a signed document must not quietly return one of the halves.
 *
 * `/config/report` is likewise absent: device telemetry relocated to `POST /<p>/devices/report`,
 * a Core surface (wire v3 §6), because it was licence anti-fraud data that had merely been
 * living under a config path.
 */

import type { ServiceContext } from "../../core/registry.js";
import { handleConfigDocument } from "./document.js";
import { handleSchema } from "./schema.js";
import { handleMintAuth, handleMintToken } from "./mint.js";

/** Recipe ids are the same restricted alphabet the pre-suite router matched, so a traversal or
 *  an encoded separator cannot reach the recipe lookup. */
const MINT_ID = /^[a-z0-9-]+$/;

export async function handleConfigRoutes(
  ctx: ServiceContext,
): Promise<Response | null> {
  const { req, env, db, product, rest, now, settings } = ctx;

  if (rest.length === 1) {
    switch (rest[0]) {
      case "document":
        return handleConfigDocument(req, env, db, product, now, settings);
      case "schema":
        return handleSchema(db, product);
      default:
        return null;
    }
  }

  // /config/mint/<id>/{token,auth}
  if (rest.length === 3 && rest[0] === "mint" && MINT_ID.test(rest[1] ?? "")) {
    const mintId = rest[1] as string;
    if (rest[2] === "token")
      return handleMintToken(req, env, db, product, mintId, now);
    if (rest[2] === "auth") return handleMintAuth(db, product, mintId);
  }

  return null;
}
