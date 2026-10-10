/**
 * The portal's two entry points, wired the way the composition root wires them (P2b-04).
 *
 * The portal's downloads read Distribution's delivery access through a product's descriptor
 * hooks, which `dispatch.ts` hands it (`hooksFor`, built from `mount.ts`'s registry under that
 * product's own enablement). The suites drive `handlePortalApi` / `handlePortalDownload`
 * directly, so they import them from here instead: same signatures, same composition.
 */

import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";
import { buildHooks } from "../src/core/hooks.js";
import { serializeServices } from "../src/core/services.js";
import { setServices } from "../src/repo.js";
import { SERVICES } from "../src/mount.js";
import { pk as kvKey } from "../src/kv.js";
import {
  handlePortalApi as portalApi,
  handlePortalDownload as portalDownload,
  type PortalHooksFor,
} from "../src/services/identity/portal/api.js";

/** One product's hooks, built for the given environment and database. */
export function portalHooksFor(env: Env, db: Db): PortalHooksFor {
  return (product, now) =>
    buildHooks(SERVICES, product.services, { env, db, product, now });
}

export function handlePortalApi(
  req: Request,
  env: Env,
  db: Db,
  path: string,
  now: number,
): Promise<Response> {
  return portalApi(req, env, db, path, now, portalHooksFor(env, db));
}

export function handlePortalDownload(
  req: Request,
  env: Env,
  db: Db,
  token: string,
  now: number,
): Promise<Response> {
  return portalDownload(req, env, db, token, now, portalHooksFor(env, db));
}

/**
 * Turn on what serves a product's downloads: Release (the records) and Distribution (the bytes
 * and the delivery access, P2b-04). P2b-01 backfilled Distribution onto every Release product;
 * a fixture that seeds release rows for the portal to hand out declares both.
 */
export async function enableDownloads(
  db: Db,
  slug: string,
  now = 0,
): Promise<void> {
  await setServices(
    db,
    slug,
    serializeServices({
      services: {
        license: { enabled: true },
        config: { enabled: true },
        release: { enabled: true },
        distribution: { enabled: true },
        update: { enabled: false },
        identity: { enabled: false },
        sync: { enabled: false },
      },
    }),
    "manifest",
    now,
  );
}

/**
 * Record the product's GitHub repository visibility the way Release caches it
 * (`ghCache.isPublicRepository`, one hour in HOT), with a resolved `release_config` so the
 * lookup reaches the cache. The portal redirects a browser to a stored GitHub URL only for a
 * public repository; a private one answers that browser with GitHub's 404.
 */
export async function seedRepositoryVisibility(
  env: Env,
  db: Db,
  slug: string,
  visibility: "public" | "private",
  repo: { owner: string; name: string } = {
    owner: "vladzaharia",
    name: slug,
  },
): Promise<void> {
  await db.run(
    `INSERT INTO release_config
       (product, gh_owner, gh_repo, gh_installation_id, metadata_access, artifacts_access)
     VALUES (?, ?, ?, 42, 'public', 'public')
     ON CONFLICT (product) DO UPDATE SET
       gh_owner = COALESCE(release_config.gh_owner, excluded.gh_owner),
       gh_repo = COALESCE(release_config.gh_repo, excluded.gh_repo),
       gh_installation_id = COALESCE(release_config.gh_installation_id, 42)`,
    slug,
    repo.owner,
    repo.name,
  );
  const cfg = await db.first<{ gh_owner: string; gh_repo: string }>(
    "SELECT gh_owner, gh_repo FROM release_config WHERE product = ?",
    slug,
  );
  await env.HOT.put(
    kvKey(
      slug,
      "gh-repo-public",
      `${cfg!.gh_owner}/${cfg!.gh_repo}`.toLowerCase(),
    ),
    visibility === "public" ? "1" : "0",
  );
}
