/**
 * `GET /manage/api/summary`: one fact per service for every product the session can see, for
 * Home's product cards (`admin/lib/summary.ts`; ADMIN.md A-8, sliced).
 *
 * Visibility is the registry list's (`GET /products`): the platform-admin gate, then every product
 * `listProducts` returns. The grouped queries read across products, so the answer is filtered to
 * exactly that list: a session that cannot list a product never learns its counts, and a deleted
 * product's leftover rows never surface. Read-only; the session, CSRF and rate limit run in
 * `admin/api.ts` first.
 */

import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import { listProducts } from "../../repo.js";
import { isPlatformAdmin } from "../authz.js";
import type { AdminSession } from "../session.js";
import { productSummaries } from "../lib/summary.js";
import { adminJson, err, forbidden, notFound } from "../lib/respond.js";

export async function handleSummary(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  rest: string[],
  now: number,
): Promise<Response> {
  if (rest.length > 0) return notFound();
  if (req.method !== "GET" && req.method !== "HEAD")
    return err(405, "method_not_allowed", "the summary is read-only");
  if (!isPlatformAdmin(env, session))
    return forbidden("platform admin required");
  const products = await listProducts(db);
  return adminJson({
    products: await productSummaries(db, products, now),
  });
}
