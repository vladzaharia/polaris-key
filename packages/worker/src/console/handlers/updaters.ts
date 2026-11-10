/**
 * `GET /manage/api/products/<slug>/distribution/updaters` (P2-11): the Updates page's read. The
 * updaters the product's shipped platforms can use, each platform with its Verified state.
 * Composed here because it reads Release's facts and Distribution's update-health counters, and a
 * service reads neither through the other (rule 6). Area `ship`; counts are devices, no ids.
 */

import { adminJson, err, notFound } from "../../core/console/respond.js";
import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { updateChecks } from "../../services/distribution/public.js";
import { listSightings } from "../../core/integration/sightings.js";
import { hostFacts } from "./channels.js";
import type { AdminCtx } from "../routes.js";
import { updatersView, type UpdatersView } from "../lib/updaterModel.js";

export async function updatersRead(
  env: Env,
  db: Db,
  slug: string,
  now: number,
): Promise<UpdatersView | null> {
  const read = await hostFacts(env, db, slug, now);
  if (!read) return null;
  const checks = await updateChecks(env, slug, read.hooks, now);
  const godot = (await listSightings(db, slug)).some((s) => s.sdk === "godot");
  const access = (await read.hooks.delivery()?.accessMode("app")) ?? null;
  return updatersView(read.facts.platforms, checks, { godot, access });
}

export async function handleUpdaters(c: AdminCtx): Promise<Response> {
  if (c.req.method !== "GET" && c.req.method !== "HEAD")
    return err(405, "method_not_allowed", "the updaters read is read-only");
  const view = await updatersRead(c.env, c.db, c.product!.slug, c.now);
  if (!view) return notFound();
  return adminJson({ product: c.product!.slug, now: c.now, ...view });
}
