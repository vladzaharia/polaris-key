/// <reference types="@cloudflare/workers-types" />

/**
 * License's admin surface — `/manage/api/products/<slug>/license/{licenses,tiers,policy}` (§R1),
 * and `license/deletions` (bulk licence deletion and the cleanup list, `deletion.ts`).
 *
 * These three resources used to hang off the admin dispatcher's own five-segment destructure as
 * `licenses`, `tiers` and `policy`. They are License's: a licence, the tier that shapes it, and
 * the enrollment/fingerprint policy that decides whether a device may bind to one are the same
 * subject seen from three distances. Moving them here is what makes the console's License
 * section a projection of a service rather than a folder of unrelated endpoints.
 *
 * The pre-suite spellings are GONE, not aliased. Pre-launch, the console is the only consumer,
 * and a permanent alias on an admin API buys nothing except two paths that can answer
 * differently after the next refactor.
 *
 * Sub-routing lives here, not in `admin/api.ts`: the dispatcher hands over the FULL remaining
 * path and a service routes itself (`ServiceDescriptor.adminHandle`). Session, CSRF, rate limit
 * and the platform-admin gate all ran before this is reached — see `core/adminApi.ts` for why
 * they stay there.
 */

import type { ServiceContext } from "../../../core/registry.js";
import type { AdminSession } from "../../../core/adminApi.js";
import { handleLicenses } from "./licenses.js";
import { handleTiers } from "./tiers.js";
import { handleFingerprintPolicy } from "./policy.js";
import { handleDeletions } from "./deletion.js";

/** What every handler under this directory is given. */
export type LicenseAdminContext = ServiceContext & { session: AdminSession };

export async function handleLicenseAdmin(
  ctx: LicenseAdminContext,
): Promise<Response | null> {
  const [resource, ...rest] = ctx.rest;

  if (resource === "licenses") return handleLicenses(ctx, rest);
  if (resource === "tiers") return handleTiers(ctx, rest[0]);
  if (resource === "policy") return handleFingerprintPolicy(ctx, rest[0]);
  if (resource === "deletions") return handleDeletions(ctx, rest[0]);

  // `null`, not a 404: only Core knows whether an unmatched path is a not-found, an alias or a
  // fall-through, and centralising that keeps the answer byte-identical however it was missed.
  return null;
}
