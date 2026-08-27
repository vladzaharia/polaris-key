/**
 * One entry point over the two services the release surface is now split across (P2.T1, D-05).
 *
 * The behaviour pins in `release.test.ts` and the R6/R9/R10 attack suites are assertions about a
 * RESPONSE — a hardened header, a 404 instead of a 500, a rate-limit lane, a redirect that must
 * not happen. None of them is an assertion about which module produced it, and re-pointing forty
 * call sites at two different functions would have restated that fact forty times without
 * testing it once.
 *
 * So the dispatch that used to live inside `handleRelease` lives here instead, in the tests, and
 * the suites keep calling one function with one `kind`. The split it hides is asserted directly
 * where it belongs: `router.test.ts` proves each path reaches the right service, and
 * `boundaries.test.ts` proves the two directories cannot reach into each other.
 */

import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";
import type { Product } from "../src/core/products.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import type { ReleaseParams } from "../src/services/release/gateway.js";
import { handleRelease } from "../src/services/release/index.js";
import { handleUpdate } from "../src/services/update/index.js";

export type ReleaseKind =
  | "appcast"
  | "channelAppcast"
  | "cli"
  | "dmg"
  | "version"
  | "changelog"
  | "install";

const UPDATE_KINDS = new Set<ReleaseKind>([
  "appcast",
  "channelAppcast",
  "version",
]);

export function handleReleaseSurface(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  kind: ReleaseKind,
  params: ReleaseParams,
  fetchImpl: FetchImpl = fetch,
): Promise<Response> {
  return UPDATE_KINDS.has(kind)
    ? handleUpdate(
        req,
        env,
        db,
        product,
        kind as "appcast" | "channelAppcast" | "version",
        params,
        fetchImpl,
      )
    : handleRelease(
        req,
        env,
        db,
        product,
        kind as "cli" | "dmg" | "changelog" | "install",
        params,
        fetchImpl,
      );
}
