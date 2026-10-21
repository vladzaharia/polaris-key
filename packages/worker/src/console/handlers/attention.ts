/**
 * `GET /manage/api/attention` (UX-12, ST-44): what needs the operator across every product the
 * session can see, composed on the server (`console/lib/attention.ts`). Visibility is the registry
 * list's (`canSeeProduct`), then each item's own area (`can()`), so a member never learns of a
 * problem whose fix they cannot open. Read-only; the session, CSRF and rate limit ran first.
 */

import type { Env } from "../../platform/env.js";
import type { Db } from "../../db/types.js";
import { listProducts } from "../../core/products/store.js";
import { canSeeProduct } from "../authz.js";
import type { AdminSession } from "../../core/console/session.js";
import { attentionAcross } from "../lib/attention.js";
import { adminJson, err, notFound } from "../../core/console/respond.js";

export async function handleAttention(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  rest: string[],
  now: number,
): Promise<Response> {
  if (rest.length > 0) return notFound();
  if (req.method !== "GET")
    return err(405, "method_not_allowed", "attention is read-only");
  const products = (await listProducts(db)).filter(
    (p) => !p.system && canSeeProduct(session.principal, p),
  );
  return adminJson({
    items: await attentionAcross(db, products, session.principal, now),
  });
}
