/**
 * `GET /manage/api/products/<slug>/distribution/updaters` (P2-11): the Updates page's read. The
 * updaters the product's shipped platforms can use, each platform with its Verified state.
 * Composed here because it reads Release's facts and Distribution's update-health counters, and a
 * service reads neither through the other (rule 6). Area `ship`; counts are devices, no ids.
 */

import { adminJson, err, notFound } from "../../core/console/respond.js";
import { loadProductPublic } from "../../core/products.js";
import { serviceContext } from "../../core/registry.js";
import { SERVICES } from "../../mount.js";
import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import {
  liveBuilds,
  productPlatforms,
  updateChecks,
} from "../../services/distribution/public.js";
import type { AdminCtx } from "../routes.js";
import { updatersView, type UpdatersView } from "../lib/updaterModel.js";

export async function updatersRead(
  env: Env,
  db: Db,
  slug: string,
  now: number,
): Promise<UpdatersView | null> {
  const product = await loadProductPublic(db, slug);
  if (!product) return null;
  const hooks = serviceContext("host", SERVICES, product.services, {
    env,
    db,
    product,
    now,
  }).hooks;
  const builds = await liveBuilds(hooks);
  const facts = await productPlatforms({
    db,
    product: slug,
    hooks,
    now,
    builds,
  });
  return updatersView(
    facts.platforms,
    await updateChecks(env, slug, hooks, now),
  );
}

export async function handleUpdaters(c: AdminCtx): Promise<Response> {
  if (c.req.method !== "GET" && c.req.method !== "HEAD")
    return err(405, "method_not_allowed", "the updaters read is read-only");
  const view = await updatersRead(c.env, c.db, c.product!.slug, c.now);
  if (!view) return notFound();
  return adminJson({ product: c.product!.slug, now: c.now, ...view });
}
