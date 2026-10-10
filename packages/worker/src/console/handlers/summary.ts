/**
 * `GET /manage/api/summary`: one fact per service for every product the session can see, for
 * Home's product cards (`console/lib/summary.ts`; ADMIN.md A-8, sliced).
 *
 * Visibility is the registry list's (`GET /products`): the platform-admin gate, then every product
 * `listProducts` returns. The grouped queries read across products, so the answer is filtered to
 * exactly that list: a session that cannot list a product never learns its counts, and a deleted
 * product's leftover rows never surface. Read-only; the session, CSRF and rate limit run in
 * `console/api.ts` first.
 */

import type { Env } from "../../platform/env.js";
import type { Db } from "../../db/types.js";
import { listProducts } from "../../core/repo.js";
import { isPlatformAdmin } from "../authz.js";
import type { AdminSession } from "../../core/console/session.js";
import { productSummaries } from "../lib/summary.js";
import {
  adminJson,
  err,
  forbidden,
  notFound,
} from "../../core/console/respond.js";

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
  if (!isPlatformAdmin(env, session))
    return forbidden("platform admin required");
  const products = await listProducts(db);
  return adminJson({
    products: await productSummaries(db, products, now),
  });
}
