/**
 * One entry point over the services the release surface is now split across (P2.T1, D-05;
 * P2b-04).
 *
 * The behaviour pins in `release.test.ts`, `updateFeed.test.ts` and the R6/R9/R10 attack suites
 * are assertions about a RESPONSE — a hardened header, a 404 instead of a 500, a rate-limit lane,
 * a redirect that must not happen. None of them is an assertion about which module produced it,
 * and re-pointing forty call sites at three different functions would have restated that fact
 * forty times without testing it once.
 *
 * So the dispatch lives here, in the tests, and the suites keep calling one function with one
 * `kind`:
 *
 *   - `install`, `cli` and `dmg` moved to Distribution in P2b-04. They are driven through the REAL
 *     router and registry at their PERMANENT ALIAS spellings (`/<p>/install.sh`,
 *     `/<p>/release/dl/<version>/<binary>-<arch>[.dmg]`), which is what "every existing
 *     download and install.sh test passes through the alias paths" means. The product runs
 *     Release, Distribution and Update, as P2b-01's backfill left every Release product.
 *   - the feed's three (`appcast`, `channelAppcast`, `version`) are Update's handler, given the
 *     delivery access the router would read through Distribution's hook (`accessMode("app")`).
 *   - `changelog` is Release's.
 *
 * The split it hides is asserted directly where it belongs: `router.test.ts` proves each path
 * reaches the right service, and `boundaries.test.ts` proves the directories cannot reach into
 * each other.
 */

import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";
import type { Product } from "../src/core/products.js";
import type { ServicesMap } from "../src/core/services.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import type { ReleaseParams } from "../src/services/release/gateway.js";
import { handleRelease } from "../src/services/release/index.js";
import { handleUpdate } from "../src/services/update/index.js";
import { buildHooks } from "../src/core/hooks.js";
import { dispatchService } from "../src/core/registry.js";
import { matchRoute } from "../src/router.js";
import { SERVICES } from "../src/mount.js";

export type ReleaseKind =
  | "appcast"
  | "channelAppcast"
  | "cli"
  | "dmg"
  | "version"
  | "changelog"
  | "install";

/** What every product these suites drive runs (P2b-01's backfill: Release ⇒ Distribution). */
const RELEASE_CHAIN: ServicesMap = {
  license: { enabled: true },
  config: { enabled: true },
  release: { enabled: true },
  distribution: { enabled: true },
  update: { enabled: true },
  identity: { enabled: false },
  sync: { enabled: false },
};

const UPDATE_KINDS = new Set<ReleaseKind>([
  "appcast",
  "channelAppcast",
  "version",
]);

/** The alias spelling of a Distribution surface, from the kind and params the suites pass. */
function aliasPath(
  slug: string,
  kind: "cli" | "dmg" | "install",
  params: ReleaseParams,
): string {
  if (kind === "install") return `/${slug}/install.sh`;
  const selector = params.version ?? params.channel ?? "latest";
  const leaf = `${slug}-${params.arch ?? ""}${kind === "dmg" ? ".dmg" : ""}`;
  return `/${slug}/release/dl/${selector}/${leaf}`;
}

/** Drive a Distribution surface through the router at its alias path, GitHub at `fetchImpl`. */
async function viaAlias(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  kind: "cli" | "dmg" | "install",
  params: ReleaseParams,
  fetchImpl: FetchImpl,
): Promise<Response> {
  const url = new URL(req.url);
  url.pathname = aliasPath(product.slug, kind, params);
  const route = matchRoute(url.pathname);
  if (route.kind !== "service")
    throw new Error(`${url.pathname} is not a service route`);
  const saved = globalThis.fetch;
  globalThis.fetch = fetchImpl as typeof fetch;
  try {
    return await dispatchService(SERVICES, route.slug, RELEASE_CHAIN, {
      req: new Request(url.toString(), req),
      env,
      db,
      product,
      rest: route.rest,
      now: Math.floor(Date.now() / 1000),
      ...(route.alias ? { alias: true } : {}),
    });
  } finally {
    globalThis.fetch = saved;
  }
}

export async function handleReleaseSurface(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  kind: ReleaseKind,
  params: ReleaseParams,
  fetchImpl: FetchImpl = fetch,
): Promise<Response> {
  if (UPDATE_KINDS.has(kind)) {
    const delivery = buildHooks(SERVICES, RELEASE_CHAIN, {
      env,
      db,
      product,
      now: Math.floor(Date.now() / 1000),
    }).delivery();
    return handleUpdate(
      req,
      env,
      db,
      product,
      kind as "appcast" | "channelAppcast" | "version",
      params,
      fetchImpl,
      await delivery?.accessMode(APP_DELIVERABLE_ID),
    );
  }
  if (kind === "changelog")
    return handleRelease(req, env, db, product, "changelog", params, fetchImpl);
  return viaAlias(
    req,
    env,
    db,
    product,
    kind as "cli" | "dmg" | "install",
    params,
    fetchImpl,
  );
}

/**
 * The delivery-access row a fixture's `release_config.artifacts_access` stands for. P2b-04 moved
 * the artifacts mode to `dist_access` (0038 backfilled every product from that column), so a
 * fixture that seeds the column seeds the row too, exactly as the migration would have.
 */
export async function seedDeliveryAccess(
  db: Db,
  product: string,
  mode: string | null | undefined,
): Promise<void> {
  await db.run(
    `INSERT INTO dist_access (product, deliverable_id, mode, entitlement, source, modified_at)
     VALUES (?, 'app', ?, NULL, 'manifest', 0)
     ON CONFLICT (product, deliverable_id) DO UPDATE SET mode = excluded.mode`,
    product,
    mode === "authenticated" || mode === "licensed" || mode === "entitled"
      ? mode
      : "public",
  );
}
