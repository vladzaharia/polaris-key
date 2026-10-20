/**
 * "Get a support code" on a product's page (I-11; S-16 §5.2 "How relink names its target", §5.7
 * "Product page"; I-41 made it readable), dispatched by `handlePortalApi` once the session is proven:
 *
 *   POST /api/products/<p>/support-code     → { supportCode }   e.g. "K7M-4QX-9TB"
 *
 * The support code is a short, readable name for the person's pairwise subject for THIS product:
 * nine characters from an alphabet without lookalikes, shown as `XXX-XXX-XXX` (`core/accounts/
 * supportCodes.ts`). It is NOT the subject: the subject (`ps_` and 22 base64url characters) is the
 * id the signed licence document carries as `profile.user.subject` and the product export as
 * `subject`, and it never reaches the person. The console resolves a code to the subject, for an
 * operator who may read that product's users only (`GET /manage/api/support-codes/<code>`). An
 * identifier for that product's support, never a credential, and never an email: that would be an
 * email-to-account oracle across tenants. The product page already shows an existing code as
 * `supportCode` (`library.ts`); this route is the explicit ask that creates it when the person has
 * none yet, and answers the same one on every ask after. A subject made only by this ask is not
 * listed on the console's Users page until it holds a licence, a signed-in device or a sign-in
 * (`productUsers.ts`), so asking cannot flood a developer's Users page.
 *
 * The request names no account and no subject: the session names the account, so there is
 * nothing for a caller to point at somebody else's code with, and the answer is that one string,
 * never the account id (S-16 §5.1), a licence, a key or another product's id. Checks, in order:
 *
 *   1. the session (`401`) and the `X-PKey-Portal-CSRF` header (`403`), both by the dispatcher
 *      before any route, because this is a change.
 *   2. the method (`405`).
 *   3. the product is one the account is linked to and its developer has the portal on for
 *      (`404`, the same answer for a product that does not exist). The page this action lives
 *      on is a `404` for anything else, and nothing is revealed about products it holds
 *      nothing in. Unlike the export and the removal this is no data right, so the developer's
 *      portal switch holds here as it does for every other action on the page.
 *   4. the rate limit, charged only after the caller is proven to hold something here (an
 *      unproven slug must never name a Durable Object shard, R5-05).
 *
 * No step-up, unlike the export and the removal (`stepUpGate.ts` is for the irreversible and the
 * credential-minting): nothing is lost, and the code opens nothing. It only names the person to
 * the developer, who can use it only through the console, under the operator's own step-up. The
 * product page already shows an existing code to the session alone, and the help page's steps
 * have no "sign in again" here.
 *
 * Creating the code writes one `portal_audit` row (`portal.support_code.create`, no code in
 * it); an ask that finds one writes nothing.
 */

import {
  existingSubjectFor,
  subjectForOrNull,
} from "../../../core/accounts/accountSubjects.js";
import {
  existingSupportCode,
  supportCodeFor,
} from "../../../core/accounts/supportCodes.js";
import { ErrorCode } from "../../../core/errors.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { err, notFound, portalJson, requireActionRateLimit } from "./api.js";
import { productLinked } from "./dataExport.js";
import { getPortalProductSettings, portalAudit } from "./repo.js";
import type { PortalSession } from "./session.js";

/** Asks for one product's support code per account (and network) per minute, in its shard. */
export const PRODUCT_SUPPORT_CODE_LIMIT_PER_MINUTE = 10;

async function existing(
  db: Db,
  accountId: string,
  product: string,
): Promise<string | null> {
  const subject = await existingSubjectFor(db, accountId, product);
  return subject ? existingSupportCode(db, product, subject) : null;
}

/** `POST /api/products/<product>/support-code`. */
export async function handleProductSupportCode(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  product: string,
  now: number,
): Promise<Response> {
  if (req.method !== "POST") return err(405, "method_not_allowed");
  if (!(await productLinked(db, session.accountId, product))) return notFound();
  if ((await getPortalProductSettings(db, product)).portal_enabled !== 1)
    return notFound();
  const limited = await requireActionRateLimit(
    req,
    env,
    session,
    "portalProductSupportCode",
    now,
    PRODUCT_SUPPORT_CODE_LIMIT_PER_MINUTE,
    product,
  );
  if (limited) return limited;
  const have = await existing(db, session.accountId, product);
  if (have) return portalJson({ supportCode: have });
  const subject = await subjectForOrNull(db, session.accountId, product, now);
  // An erasure began after the session was checked: the portal already reads the account as gone.
  if (subject === null) return err(401, ErrorCode.Unauthorized);
  const created = await supportCodeFor(db, product, subject, now);
  await portalAudit(db, {
    accountId: session.accountId,
    action: "portal.support_code.create",
    product,
    targetKind: "product",
    targetId: product,
    summary: "Created a support code for a product",
    now,
  });
  return portalJson({ supportCode: created });
}
