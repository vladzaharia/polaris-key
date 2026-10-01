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
      },
    }),
    "manifest",
    now,
  );
}
