/**
 * The list/detail summary projection of a licence row, shared by the console and License's admin
 * handlers (moved out of the console's `shape.ts` by P0-17, so Core no longer reaches the console
 * for it).
 */

import type { Db } from "../../db/types.js";
import { type LicenseRow } from "../repo.js";
import { listLicenseProfileRows } from "./store.js";
import { licenseHolder } from "./licenseHolders.js";
import { licenseEndedReason } from "./lifecycle.js";
import {
  keyEntriesApply,
  keyEntryLimit,
  type KeyEntrySettings,
} from "./keyEntries.js";
import {
  existingSubjectsFor,
  subjectForOrNull,
} from "../accounts/accountSubjects.js";
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

/** What the summaries of a set of licences share, read once for the set. */
interface SummaryFacts {
  keys: Map<string, { total: number; active: number }>;
  authorizedDevices: Map<string, number>;
  profiles: Map<string, string[]>;
  subjects: Map<string, string | null>;
  keyEntries: Map<string, number>;
}

/** One read per 90 ids: `SELECT <id col>, … GROUP BY <id col>` over the set. */
async function groupedByLicense<T extends { license_id: string }>(
  db: Db,
  product: string,
  licenseIds: readonly string[],
  sql: (placeholders: string) => string,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < licenseIds.length; i += 90) {
    const ids = licenseIds.slice(i, i + 90);
    out.push(
      ...(await db.all<T>(sql(ids.map(() => "?").join(", ")), product, ...ids)),
    );
  }
  return out;
}

async function summaryFacts(
  db: Db,
  product: string,
  rows: readonly LicenseRow[],
  wantKeyEntries: boolean,
): Promise<SummaryFacts> {
  const ids = rows.map((r) => r.id);
  const keys = new Map<string, { total: number; active: number }>();
  for (const r of await groupedByLicense<{
    license_id: string;
    total: number;
    active: number;
  }>(
    db,
    product,
    ids,
    (ph) =>
      `SELECT license_id, COUNT(*) AS total, SUM(status = 'active') AS active
         FROM keys_index WHERE product = ? AND license_id IN (${ph}) GROUP BY license_id`,
  ))
    keys.set(r.license_id, { total: r.total, active: r.active ?? 0 });

  const authorizedDevices = new Map<string, number>();
  for (const r of await groupedByLicense<{ license_id: string; n: number }>(
    db,
    product,
    ids,
    (ph) =>
      `SELECT license_id, COUNT(*) AS n FROM devices
        WHERE product = ? AND status = 'authorized' AND license_id IN (${ph}) GROUP BY license_id`,
  ))
    authorizedDevices.set(r.license_id, r.n);

  const profiles = new Map<string, string[]>();
  for (const [id, list] of await listLicenseProfileRows(db, product, ids))
    profiles.set(
      id,
      list.map((p) => p.profile_id),
    );

  // PX-W17: the owner as this product sees them — the pairwise subject, never the account id
  // (S-16 §5.1). Subjects are platform-wide, so this is set for every product whatever its
  // Identity toggle; `null` for a floating licence. One read for the set; an account with no
  // subject yet gets its first-contact mint (rare, and the read after it is a hit).
  const accountIds = rows
    .map((r) => r.account_id)
    .filter((a): a is string => !!a);
  const known = await existingSubjectsFor(db, accountIds, product);
  const subjects = new Map<string, string | null>();
  for (const a of new Set(accountIds))
    subjects.set(
      a,
      known.get(a) ??
        (await subjectForOrNull(db, a, product, Math.floor(Date.now() / 1000))),
    );

  const keyEntries = new Map<string, number>();
  if (wantKeyEntries)
    for (const r of await groupedByLicense<{ license_id: string; n: number }>(
      db,
      product,
      ids,
      (ph) =>
        `SELECT license_id, COUNT(*) AS n FROM license_key_entries
          WHERE product = ? AND license_id IN (${ph}) GROUP BY license_id`,
    ))
      keyEntries.set(r.license_id, r.n);
  return { keys, authorizedDevices, profiles, subjects, keyEntries };
}

/**
 * The summaries of a set of licence rows (a list's page) in a fixed number of reads: counts,
 * profiles, subjects and key entries are grouped over the set, not asked per row (P0-29).
 */
export async function licenseSummaries(
  db: Db,
  product: string,
  rows: readonly LicenseRow[],
  keyEntryContext?: KeyEntryListContext,
): Promise<Record<string, unknown>[]> {
  // Without a context (a call built by hand) the limit is the stored row's (`keyEntryLimit`).
  const { limit } =
    keyEntryContext ?? (await keyEntryListContext({ env: {}, db }, product));
  const facts = await summaryFacts(db, product, rows, limit !== null);
  return rows.map((row) => {
    const counts = facts.keys.get(row.id) ?? { total: 0, active: 0 };
    const profiles = facts.profiles.get(row.id) ?? [];
    const held = (row.account_id ?? null) !== null || row.sub !== null;
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
      keyCount: counts.total,
      activeKeyCount: counts.active,
      deviceCount: facts.authorizedDevices.get(row.id) ?? 0,
      profile: profiles[0] ?? null,
      profiles,
      tier: row.tier_id,
      // R11-06: guarded — a single corrupt channels_json must not 500 the whole license list.
      channels: parseJsonStringList(row.channels_json),
      minVersion: row.min_version,
      maxVersion: row.max_version,
      ownerSubject: row.account_id
        ? (facts.subjects.get(row.account_id) ?? null)
        : null,
      // LX-26 (S-24 D1): floating or assigned, derived from the owner pointer and the licence's own
      // email; never the account's details.
      holder: licenseHolder(row),
      // LX-28: the batch the licence was created in, `null` for a licence created on its own.
      batchId: row.batch_id ?? null,
      // I-09 (plans/I-04.md §F.6): `account` for a sign-in licence (held by an account, no key ever
      // issued), else `seats`. Display only: a sign-in licence is device-limited like any other.
      access: held && counts.total === 0 ? "account" : "seats",
      // PX-W9 (WIRE-CONTRACT-V4 §12.2): the licence's key entries, `null` with Identity off. LX-30
      // renders the "Key entries 3 of 10" row from it.
      keyEntries:
        limit === null
          ? null
          : { used: facts.keyEntries.get(row.id) ?? 0, limit },
      identityProvider: row.sub ? "oidc" : "manual",
      // How the row was minted (`admin`, `oidc`, `enroll`): decides whether it may be deleted.
      origin: row.origin ?? "admin",
      oidcSubject: row.sub ?? undefined,
      modifiedBy: row.modified_by ?? undefined,
      modifiedAt: row.modified_at,
    };
  });
}

/** The list/detail summary projection of a license row (with derived key + device counts). */
export async function licenseSummary(
  db: Db,
  product: string,
  row: LicenseRow,
  keyEntryContext?: KeyEntryListContext,
): Promise<Record<string, unknown>> {
  return (await licenseSummaries(db, product, [row], keyEntryContext))[0]!;
}
