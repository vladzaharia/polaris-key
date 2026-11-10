/**
 * `GET /api/products/<product>/sync` (U-12.5): what Cloud Sync holds for the signed-in account in
 * one product, as sizes and times (`CloudSyncSummary`, `core/hooks.ts`), for Polaris Locker's
 * Cloud Sync card. Identity reads it only through Core's `cloudSyncSummary` hook (rule 6).
 *
 * `404` for a product the account is not linked to, one that does not exist, and one with Cloud
 * Sync off: the same answer for all three, so nothing is revealed. A read, so no step-up and no
 * audit row (it returns no personal data beyond the account's own device labels and sizes); the
 * session and the CSRF header are the router's. Rate limit: none beyond the portal's sweep.
 */

import { existingSubjectFor } from "../../../core/accounts/accountSubjects.js";
import type { Db } from "../../../db/types.js";
import {
  err,
  notFound,
  portalHooks,
  portalJson,
  type PortalHooksFor,
} from "./api.js";
import { productLinked } from "./dataExport.js";
import type { PortalSession } from "./session.js";

export async function handleProductSync(
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
  const loaded = await portalHooks(db, hooksFor, product, now);
  const reader = loaded?.hooks.cloudSyncSummary();
  if (!reader) return notFound();
  const subject = await existingSubjectFor(db, session.accountId, product);
  return portalJson(await reader.summary(subject));
}
