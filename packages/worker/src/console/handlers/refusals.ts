/**
 * The refusal log, read (UX-15, docs/design/EXPERIENCE.md §0.9): `GET
 * /manage/api/products/<slug>/refusals`. Core, like `activity` and `devices`: the refusal site is
 * Core's `authorizeDevice`, and the table (`license_refusals`) is Core's.
 *
 * Query parameters, all optional:
 *
 *   refusedSince  epoch seconds, inclusive; default 7 days ago (the Refusing devices facet's
 *                 window). Earlier values read what is still kept (30 days).
 *   licenseId     one licence: its Status health line and Recent rows
 *   limit         most recent refusals returned, 1-200, default 50
 *
 * Answers `{ since, refusals, licenses }`:
 *
 *   refusals  newest first: `{ id, licenseId, at, reason, deviceLabel, deviceHash }`
 *   licenses  every licence refused at least once since `since` (at most 500, latest first):
 *             `{ licenseId, count, devices, lastAt }` — the facet and its pill
 *
 * Read-only, product-scoped like every per-product admin read, and behind the same platform-admin
 * gate (`console/api.ts`). The label is plain text (`core/licensing/refusals.ts`); the console renders it as
 * text.
 */

import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../core/errors.js";
import {
  REFUSAL_RETENTION_SECONDS,
  listRefusals,
  listRefusingLicenses,
} from "../../core/licensing/refusals.js";
import { adminJson, err } from "../../core/console/respond.js";

/** The facet's window: refused at least one activation in the last 7 days. */
export const REFUSED_SINCE_DEFAULT_SECONDS = 7 * 24 * 60 * 60;

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;
const LICENSES_MAX = 500;
/** Longer than any licence id the platform mints. */
const LICENSE_ID_MAX = 200;

export async function handleRefusals(
  req: Request,
  db: Db,
  slug: string,
  rest: string[],
  now: number,
): Promise<Response> {
  if (rest.length > 0) return err(404, ErrorCode.NotFound);
  if (req.method !== "GET" && req.method !== "HEAD") {
    return err(405, "method_not_allowed", "refusals are read-only");
  }

  const url = new URL(req.url);
  const bad: string[] = [];

  let since = now - REFUSED_SINCE_DEFAULT_SECONDS;
  const rawSince = url.searchParams.get("refusedSince");
  if (rawSince !== null && rawSince !== "") {
    const n = Number(rawSince);
    if (!Number.isSafeInteger(n) || n < 0) bad.push("refusedSince");
    else since = Math.max(n, now - REFUSAL_RETENTION_SECONDS);
  }

  let licenseId: string | null = null;
  const rawLicense = url.searchParams.get("licenseId");
  if (rawLicense !== null && rawLicense !== "") {
    if (rawLicense.length > LICENSE_ID_MAX) bad.push("licenseId");
    else licenseId = rawLicense;
  }

  let limit = LIMIT_DEFAULT;
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit !== null && rawLimit !== "") {
    const n = Number(rawLimit);
    if (!Number.isSafeInteger(n) || n < 1 || n > LIMIT_MAX) bad.push("limit");
    else limit = n;
  }

  if (bad.length) {
    return err(422, ErrorCode.BadRequest, "invalid refusals filter", {
      fields: bad,
    });
  }

  const [rows, licenses] = await Promise.all([
    listRefusals(db, slug, { since, licenseId, limit }),
    listRefusingLicenses(db, slug, { since, licenseId, limit: LICENSES_MAX }),
  ]);
  return adminJson({
    since,
    refusals: rows.map((r) => ({
      id: r.id,
      licenseId: r.license_id,
      at: r.at,
      reason: r.reason,
      deviceLabel: r.device_label,
      deviceHash: r.device_hash,
    })),
    licenses,
  });
}
