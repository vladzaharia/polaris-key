/**
 * `GET /manage/api/support-codes/<code>` (I-41): a support code a customer read out, resolved to
 * the product and the user it names, so the console can open that user.
 *
 *   200 { product, subject }
 *   404 not_found
 *
 * The route is `console`-area (every member), because the product is only known after the lookup;
 * the handler then holds the caller to `can(product, core, view)`, the area of that product's
 * Users page. A code the caller may not read answers EXACTLY like a code that does not exist, a
 * malformed code included, so the route is no oracle for another product's customers. The answer
 * is the product slug and the subject the Users page already shows: never the account, its email,
 * or anything of another product. Rate-limited per operator: the code space (30^9) is not
 * enumerable at this budget.
 */

import { adminJson, err, notFound } from "../../core/console/respond.js";
import { ErrorCode } from "../../core/errors.js";
import {
  normalizeSupportCode,
  resolveSupportCode,
} from "../../core/accounts/supportCodes.js";
import { resolveSubject } from "../../core/accounts/accountSubjects.js";
import type { AdminSession } from "../../core/console/session.js";
import { getProduct } from "../../core/products/store.js";
import { rateLimitOk } from "../../core/rateLimit.js";
import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { can, productScope } from "../authz.js";

/** Lookups per operator per minute. */
export const SUPPORT_CODE_LOOKUPS_PER_MINUTE = 30;

export async function handleSupportCodes(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  rest: string[],
  now: number,
): Promise<Response> {
  if (rest.length !== 1) return notFound();
  if (req.method !== "GET")
    return err(405, ErrorCode.BadRequest, "method not allowed");
  if (
    !(await rateLimitOk(
      env,
      "_admin",
      {
        bucket: "adminSupportCode",
        id: session.principal?.memberId ?? session.sub ?? "",
        limit: SUPPORT_CODE_LOOKUPS_PER_MINUTE,
        windowSec: 60,
      },
      now,
    ))
  )
    return err(429, "rate_limited", "too many support code lookups");
  let input: string;
  try {
    input = decodeURIComponent(rest[0]!);
  } catch {
    return notFound();
  }
  if (normalizeSupportCode(input) === null) return notFound();
  const hit = await resolveSupportCode(db, input);
  if (!hit) return notFound();
  const product = await getProduct(db, hit.product);
  if (
    !product ||
    !can(session.principal, productScope(product), "core", "view")
  )
    return notFound();
  // An absorbed subject answers with the survivor's; a deleted one is not found.
  const subject = await resolveSubject(db, hit.product, hit.subject);
  if (!subject) return notFound();
  return adminJson({ product: hit.product, subject });
}
