/**
 * `GET /api/products/<product>/sync` (U-12.5): what Cloud Sync holds for the signed-in account in
 * one product, as sizes and times (`CloudSyncSummary`, `core/hooks.ts`), for Polaris Locker's
 * Cloud Sync card. Identity reads it only through Core's `cloudSyncSummary` hook (rule 6).
 *
 * `404` for a product the account is not linked to, one that does not exist, and one with Cloud
 * Sync off: the same answer for all three, so nothing is revealed. A read, so no step-up and no
 * audit row (it returns no personal data beyond the account's own device labels and sizes); the
 * session and the CSRF header are the router's. Rate limit: 60 a minute per account and product.
 *
 * `state: "removing"` (PX-18): the person asked to remove their data from this product and part of
 * the removal is still owed (U-12.1's `pending`): the product's removal ledger holds an entry for
 * their subject while the subject row is still live. Identity owns that ledger, so the state is
 * set here, on top of Cloud Sync's summary, and never by Cloud Sync reading Identity (rule 6).
 */

import { existingSubjectFor } from "../../../core/accounts/accountSubjects.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import {
  err,
  notFound,
  portalHooks,
  portalJson,
  requireActionRateLimit,
  type PortalHooksFor,
} from "./api.js";
import { productLinked } from "./dataExport.js";
import { subjectErasureKey } from "../accounts/subjectErasureLedger.js";
import type { PortalSession } from "./session.js";

/** Reads a minute per account and product: a card refreshes far less often. */
const SYNC_SUMMARY_LIMIT_PER_MINUTE = 60;

export async function handleProductSync(
  env: Env,
  db: Db,
  session: PortalSession,
  req: Request,
  product: string,
  now: number,
  hooksFor: PortalHooksFor | undefined,
): Promise<Response> {
  if (req.method !== "GET") return err(405, "method_not_allowed");
  const linked = await productLinked(db, session.accountId, product);
  if (!linked) return notFound();
  const limited = await requireActionRateLimit(
    req,
    env,
    session,
    "portalSyncSummary",
    now,
    SYNC_SUMMARY_LIMIT_PER_MINUTE,
    product,
  );
  if (limited) return limited;
  const loaded = await portalHooks(db, hooksFor, product, now);
  const reader = loaded?.hooks.cloudSyncSummary();
  if (!reader) return notFound();
  const subject = await existingSubjectFor(db, session.accountId, product);
  const summary = await reader.summary(subject);
  if (subject !== null && (await removalOwed(env, product, subject)))
    return portalJson({ ...summary, state: "removing" });
  return portalJson(summary);
}

/**
 * Whether a removal of this subject's data is recorded and not finished: its ledger entry exists
 * (the caller has just read the live subject row). A failing read answers "no", so the card shows
 * the data as it is rather than failing.
 */
async function removalOwed(
  env: Env,
  product: string,
  subject: string,
): Promise<boolean> {
  try {
    return (await env.BLOBS?.head(subjectErasureKey(product, subject))) != null;
  } catch {
    return false;
  }
}
