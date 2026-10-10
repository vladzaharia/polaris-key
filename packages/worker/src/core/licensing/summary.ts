/**
 * The list/detail summary projection of a licence row, shared by the console and License's admin
 * handlers (moved out of the console's `shape.ts` by P0-17, so Core no longer reaches the console
 * for it).
 */

import { licenseAccess } from "../anchor.js";
import type { Db } from "../../db/types.js";
import {
  listDevicesByLicense,
  listLicenseProfiles,
  type LicenseRow,
} from "../../repo.js";
import { countKeysByLicense } from "../../admin/repo.js";
import { licenseHolder } from "../licenseHolders.js";
import { licenseEndedReason } from "./lifecycle.js";
import {
  countKeyEntries,
  keyEntriesApply,
  keyEntryLimit,
  type KeyEntrySettings,
} from "../keyEntries.js";
import { subjectForOrNull } from "../accountSubjects.js";
import { parseJsonStringList } from "../../platform/json.js";

/**
 * PX-W9: what a licence list shares across its rows for `keyEntries` — the product's limit, or
 * `null` when its Identity toggle is off — so a list reads the toggle and the limit once.
 */
export interface KeyEntryListContext {
  limit: number | null;
}

/** The {@link KeyEntryListContext} of one product, its limit resolved through ST-04's resolver. */
export async function keyEntryListContext(
  settings: KeyEntrySettings,
  product: string,
): Promise<KeyEntryListContext> {
  return {
    limit: (await keyEntriesApply(settings.db, product))
      ? await keyEntryLimit(settings, product)
      : null,
  };
}

/** The list/detail summary projection of a license row (with derived key + device counts). */
export async function licenseSummary(
  db: Db,
  product: string,
  row: LicenseRow,
  keyEntryContext?: KeyEntryListContext,
): Promise<Record<string, unknown>> {
  const keyCounts = await countKeysByLicense(db, product, row.id);
  const devices = await listDevicesByLicense(db, product, row.id);
  const profiles = await listLicenseProfiles(db, product, row.id);
  // PX-W17: the owner as this product sees them — the pairwise subject, never the account id
  // (S-16 §5.1). Subjects are platform-wide, so this is set for every product whatever its
  // Identity toggle; `null` for a floating licence.
  const ownerSubject = row.account_id
    ? await subjectForOrNull(
        db,
        row.account_id,
        product,
        Math.floor(Date.now() / 1000),
      )
    : null;
  return {
    id: row.id,
    name: row.name ?? "",
    email: row.email ?? "",
    status: row.status,
    // LX-12: why a disabled licence ended (`revoked`, `superseded`, `refunded`, `chargeback`);
    // `null` while active and for a licence disabled before the reason was recorded.
    endedReason: licenseEndedReason(row),
    // The licence that replaced this one (a merge's survivor), else `null`.
    supersededBy: row.superseded_by ?? null,
    activatedAt: row.activated_at,
    expiresAt: row.expires_at,
    keyCount: keyCounts.total,
    activeKeyCount: keyCounts.active,
    deviceCount: devices.filter((m) => m.status === "authorized").length,
    profile: profiles[0]?.profile_id ?? null,
    profiles: profiles.map((p) => p.profile_id),
    tier: row.tier_id,
    // R11-06: guarded — a single corrupt channels_json must not 500 the whole license list.
    channels: parseJsonStringList(row.channels_json),
    minVersion: row.min_version,
    maxVersion: row.max_version,
    ownerSubject,
    // LX-26 (S-24 D1): floating or assigned, derived from the owner pointer and the licence's own
    // email; never the account's details.
    holder: licenseHolder(row),
    // LX-28: the batch the licence was created in, `null` for a licence created on its own.
    batchId: row.batch_id ?? null,
    // I-09 (plans/I-04.md §F.6): `account` for a sign-in licence (held by an account, no key ever
    // issued), else `seats`. Display only: a sign-in licence is device-limited like any other.
    access: await licenseAccess(db, row),
    // PX-W9 (WIRE-CONTRACT-V4 §12.2): the licence's key entries, `null` with Identity off. LX-30
    // renders the "Key entries 3 of 10" row from it.
    keyEntries: await licenseKeyEntries(db, product, row.id, keyEntryContext),
    identityProvider: row.sub ? "oidc" : "manual",
    // How the row was minted (`admin`, `oidc`, `enroll`): decides whether it may be deleted.
    origin: row.origin ?? "admin",
    oidcSubject: row.sub ?? undefined,
    modifiedBy: row.modified_by ?? undefined,
    modifiedAt: row.modified_at,
  };
}

/** `keyEntries` for one licence of the console's record (`null` with Identity off). */
async function licenseKeyEntries(
  db: Db,
  product: string,
  licenseId: string,
  context?: KeyEntryListContext,
): Promise<{ used: number; limit: number } | null> {
  // Without a context (a call built by hand) the limit is the stored row's (`keyEntryLimit`).
  const { limit } =
    context ?? (await keyEntryListContext({ env: {}, db }, product));
  if (limit === null) return null;
  return { used: await countKeyEntries(db, product, licenseId), limit };
}
