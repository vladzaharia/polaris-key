/**
 * The portal's data routes (I-11; S-16 §5.5, §5.7 "Product page" and "Privacy"), dispatched by
 * `handlePortalApi` once the session is proven:
 *
 *   GET    /api/me/export                 the full account export (`dataExport.ts`)
 *   GET    /api/products/<p>/export       one product's export
 *   DELETE /api/products/<p>/data         "Remove my data from <Product>" (`removeProductData`),
 *                                         with `?alsoRemoveLicense=1` the choice to also take the
 *                                         product's licences out of the library (D25)
 *
 * None takes an account or a subject: the session names the account, and the account names its own
 * rows, so there is nothing for a caller to point at somebody else's data with. Checks, in order:
 *
 *   1. the session (`401`), and the `X-PKey-Portal-CSRF` header. A DELETE needs it as every
 *      change does; so does an export, though it is a GET, because it hands over personal data
 *      and the SPA's download always sends it (a cross-site link cannot).
 *   2. the product is one the account is linked to (`404`, the same answer for a product that does
 *      not exist), so nothing is revealed about products it holds nothing in.
 *   3. a sign-in no older than five minutes (`401 step_up_required`): a session left open on a
 *      shared screen must not be able to take, or erase, the person's data.
 *   4. for `alsoRemoveLicense`, every licence must be one its key can bring back
 *      (`409 not_removable`, nothing written): the one rule the library's own Remove applies.
 *   5. the rate limit, charged only after the caller is proven to own something here.
 *
 * Both exports write one `portal_audit` row (`portal.account.export`, `portal.product.export`)
 * after the document is built, so a refused or failed request leaves none.
 */

import { accountLicenses } from "../../../core/accounts/accountSubjects.js";
import { ErrorCode } from "../../../core/errors.js";
import { appSecurityHeaders } from "../../../core/securityHeaders.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { removeProductData } from "../accounts/deletion.js";
import {
  err,
  notFound,
  portalJson,
  requireActionRateLimit,
  type PortalHooksFor,
} from "./api.js";
import {
  exportAccountData,
  exportProductData,
  productLinked,
} from "./dataExport.js";
import { notRemovableReason, type NotRemovableReason } from "./origin.js";
import {
  getPortalAccount,
  getPortalProductSettings,
  listVisibleKeys,
  portalAudit,
} from "./repo.js";
import type { PortalSession } from "./session.js";
import { portalStepUpGate } from "./stepUpGate.js";

/** Full exports one account may take per minute (each reads the whole account). */
export const ACCOUNT_EXPORT_LIMIT_PER_MINUTE = 5;
/** Exports of one product per account per minute, in that product's shard. */
export const PRODUCT_EXPORT_LIMIT_PER_MINUTE = 10;
/** Removals of one product's data per account per minute, in that product's shard. */
export const PRODUCT_DATA_REMOVE_LIMIT_PER_MINUTE = 5;

/** A JSON file the browser saves: indented for a person to read, never cached. */
function downloadJson(document: unknown, filename: string): Response {
  return new Response(JSON.stringify(document, null, 2), {
    headers: appSecurityHeaders(
      new Headers({
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
      }),
    ),
  });
}

/** `GET /api/me/export`. */
export async function handleAccountExport(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  sessionIdHash: string,
  now: number,
  hooksFor: PortalHooksFor | undefined,
): Promise<Response> {
  if (req.method !== "GET") return err(405, "method_not_allowed");
  if (!(await getPortalAccount(db, session.accountId)))
    return err(401, ErrorCode.Unauthorized);
  const stale = portalStepUpGate(session, now);
  if (stale) return stale;
  const limited = await requireActionRateLimit(
    req,
    env,
    session,
    "portalAccountExport",
    now,
    ACCOUNT_EXPORT_LIMIT_PER_MINUTE,
  );
  if (limited) return limited;
  const document = await exportAccountData(
    { db, env, now, hooksFor },
    session.accountId,
    sessionIdHash,
  );
  if (!document) return err(401, ErrorCode.Unauthorized);
  await portalAudit(db, {
    accountId: session.accountId,
    action: "portal.account.export",
    targetKind: "account",
    targetId: session.accountId,
    summary: "Downloaded a copy of the account's data",
    now,
  });
  return downloadJson(document, "polaris-key-account-data.json");
}

/** `GET /api/products/<product>/export`. */
export async function handleProductExport(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  product: string,
  now: number,
  hooksFor: PortalHooksFor | undefined,
): Promise<Response> {
  if (req.method !== "GET") return err(405, "method_not_allowed");
  if (!(await productLinked(db, session.accountId, product))) return notFound();
  const stale = portalStepUpGate(session, now);
  if (stale) return stale;
  const limited = await requireActionRateLimit(
    req,
    env,
    session,
    "portalProductExport",
    now,
    PRODUCT_EXPORT_LIMIT_PER_MINUTE,
    product,
  );
  if (limited) return limited;
  const document = await exportProductData(
    { db, env, now, hooksFor },
    session.accountId,
    product,
  );
  // Unlinked between the check and the read (a licence moved away): the same answer as before.
  if (!document) return notFound();
  await portalAudit(db, {
    accountId: session.accountId,
    action: "portal.product.export",
    product,
    targetKind: "product",
    targetId: product,
    summary: "Downloaded a copy of the data held for the account in a product",
    now,
  });
  return downloadJson(document, `polaris-key-${product}-data.json`);
}

/**
 * `?alsoRemoveLicense=` as the removal reads it: absent is "keep the licences" (the default, D25),
 * `1` or `true` is the explicit choice to remove them, `0` or `false` says keep. Anything else,
 * and a repeated or empty parameter, is refused rather than guessed: this flag decides whether
 * someone keeps a purchase.
 */
function alsoRemoveLicense(url: URL): boolean | null {
  const values = url.searchParams.getAll("alsoRemoveLicense");
  if (values.length === 0) return false;
  if (values.length > 1) return null;
  switch (values[0]) {
    case "1":
    case "true":
      return true;
    case "0":
    case "false":
      return false;
    default:
      return null;
  }
}

/**
 * Why one of the account's licences in `product` could not be removed from the library, or null
 * when every one can: the rule `DELETE /api/licenses/<p>/<id>` applies (it needs an active key,
 * and the product must let a key add a licence in the portal), so "also remove the licence" is
 * never a way around it.
 */
async function notRemovable(
  db: Db,
  accountId: string,
  product: string,
): Promise<NotRemovableReason | null> {
  const settings = await getPortalProductSettings(db, product);
  const keyClaimOn =
    settings.portal_enabled === 1 && settings.license_key_claim_enabled === 1;
  for (const { id } of await accountLicenses(db, accountId, product)) {
    const keys = await listVisibleKeys(db, product, id);
    const reason = notRemovableReason(
      keys.filter((k) => k.status === "active").length,
      keyClaimOn,
    );
    if (reason) return reason;
  }
  return null;
}

/** `DELETE /api/products/<product>/data`. */
export async function handleProductDataRemove(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  product: string,
  now: number,
): Promise<Response> {
  if (req.method !== "DELETE") return err(405, "method_not_allowed");
  const alsoLicense = alsoRemoveLicense(new URL(req.url));
  if (alsoLicense === null)
    return err(
      400,
      ErrorCode.BadRequest,
      "alsoRemoveLicense must be 1 or 0, once",
    );
  if (!(await productLinked(db, session.accountId, product))) return notFound();
  const stale = portalStepUpGate(session, now);
  if (stale) return stale;
  if (alsoLicense) {
    const reason = await notRemovable(db, session.accountId, product);
    if (reason)
      return portalJson(
        {
          error: "not_removable",
          message: "this license could not be added back, so it stays",
          reason,
        },
        409,
      );
  }
  const limited = await requireActionRateLimit(
    req,
    env,
    session,
    "portalProductDataRemove",
    now,
    PRODUCT_DATA_REMOVE_LIMIT_PER_MINUTE,
    product,
  );
  if (limited) return limited;
  const removed = await removeProductData(
    { db, env, now, origin: new URL(req.url).origin },
    {
      accountId: session.accountId,
      product,
      alsoDetachLicenses: alsoLicense,
    },
  );
  return portalJson({
    ok: true,
    product,
    // False when there was nothing left to remove (a repeat, or a product never signed in to).
    removed: removed.ok,
    detachedLicenses: removed.detached,
  });
}
