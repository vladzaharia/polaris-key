/**
 * `GET /manage/api/products/<slug>/integration` (ST-40): the Integration read model. Per enabled
 * feature, the console prerequisites, the domain facts and where it is Verified, from the
 * services' integration contributors and the product's SDK sightings. Read-only; the page that
 * renders it is ST-41's.
 */

import { adminJson, err, notFound } from "../../core/console/respond.js";
import { buildIntegrationView } from "../../core/integration/readModel.js";
import { loadProductPublic } from "../../core/products.js";
import { serviceContext } from "../../core/registry.js";
import { SERVICES } from "../../mount.js";
import type { AdminCtx } from "../routes.js";

export async function handleIntegration(c: AdminCtx): Promise<Response> {
  if (c.req.method !== "GET" && c.req.method !== "HEAD")
    return err(405, "method_not_allowed", "the integration view is read-only");
  const product = await loadProductPublic(c.db, c.product!.slug);
  if (!product) return notFound();
  const { env, db, now } = c;
  const hooks = serviceContext("host", SERVICES, product.services, {
    env,
    db,
    product,
    now,
  }).hooks;
  return adminJson(
    await buildIntegrationView({
      env,
      db,
      registry: SERVICES,
      product,
      hooks,
      now,
    }),
  );
}
