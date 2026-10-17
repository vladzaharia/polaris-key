/// <reference types="@cloudflare/workers-types" />

// The Identity adapter over the issuance engine (`core/licensing/issue.ts`, P0-20): every sign-in
// path (the callback, the chooser, the device-code poll, Discover's claim) calls this, and it
// hands the engine the one thing core cannot read, the `syncTierOnSignIn` setting.

import type { Env } from "../../../platform/env.js";
import type { Db } from "../../../db/types.js";
import type { ProductPublic } from "../../../core/products.js";
import type { LicenseMerge } from "../../../core/licensing/licenseMerge.js";
import {
  issueLicense,
  type OidcIdentity,
} from "../../../core/licensing/issue.js";
import { readSyncTierOnSignIn } from "../settings.js";

/** Find or mint a license for an identity. Returns the licenseId, or an error if the
 *  identity's groups don't grant entitlement. Idempotent on the OIDC subject. */
export async function activateFromIdentity(
  db: Db,
  product: ProductPublic,
  identity: OidcIdentity,
  now: number,
  /** See `IssueDevice`, `IssueTarget` and `IssueVia` in `core/licensing/issue.ts`. */
  opts: {
    enrolledLicenseId?: string | null;
    licenseMerge?: LicenseMerge;
    env?: Env;
    mintAudit?: boolean;
  } = {},
): Promise<
  { licenseId: string; merged?: "claimed" | "migrated" } | { error: string }
> {
  return issueLicense(
    db,
    product,
    identity,
    {
      kind: "oidc",
      env: opts.env,
      mintAudit: opts.mintAudit,
      readSyncTier: readSyncTierOnSignIn,
    },
    { licenseMerge: opts.licenseMerge },
    now,
    { enrolledLicenseId: opts.enrolledLicenseId },
  );
}
