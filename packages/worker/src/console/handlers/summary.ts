/**
 * `GET /manage/api/summary`: one fact per service for every product the session can see, for
 * Home's product cards (`console/lib/summary.ts`; ADMIN.md A-8, sliced).
 *
 * Visibility is the registry list's (`GET /products`): every product `listProducts` returns that
 * the principal holds an area of (`canSeeProduct`, ST-29). The grouped queries read across products, so the answer is filtered to
 * exactly that list: a session that cannot list a product never learns its counts, and a deleted
 * product's leftover rows never surface. Read-only; the session, CSRF and rate limit run in
 * `console/api.ts` first.
 */

import type { Env } from "../../platform/env.js";
import type { Db } from "../../db/types.js";
import { listProducts } from "../../core/repo.js";
import { canSeeProduct } from "../authz.js";
import type { AdminSession } from "../../core/console/session.js";
import { productSummaries } from "../lib/summary.js";
import { adminJson, err, notFound } from "../../core/console/respond.js";

export async function handleSummary(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  rest: string[],
  now: number,
): Promise<Response> {
  if (rest.length > 0) return notFound();
  // GET only, as the spec documents it and as the registry list answers (HEAD included).
  if (req.method !== "GET")
    return err(405, "method_not_allowed", "the summary is read-only");
  void env;
  const products = (await listProducts(db)).filter((p) =>
    canSeeProduct(session.principal, p),
  );
  return adminJson({
    products: await productSummaries(db, products, now),
  });
}
