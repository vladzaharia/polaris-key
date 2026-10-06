/**
 * Key-entry counting (PX-W9, G21; WIRE-CONTRACT-V4 §12.2, plans/PX-W9.md §6).
 *
 * A key entry is a person typing a licence key to use it. On a product whose Identity toggle is
 * on, every licence counts its entries in `license_key_entries` (insert-only; `used` is the row
 * count), and past the product's limit a NEW device may be refused the key and pointed at an
 * account instead (`key_entry_limit`, PORTAL §4.6). It lives in Core because License (activate)
 * and Identity (the browser key session, the portal claim and the signed-out preview) all use it,
 * and services may not import one another (rule 6).
 *
 * ── WHAT COUNTS ─────────────────────────────────────────────────────────────────────────────
 *
 *   - `app` and `browser`: a new authorisation that takes a seat. The row is written by
 *     {@link stmtRecordDeviceKeyEntry} in the SAME batch as the seat claim (`repo.ts`
 *     `claimDeviceSeat`, through `authorizeDevice`'s `keyEntry` option), so a refused or failed
 *     authorisation writes nothing, and of concurrent calls from one device only one writes.
 *   - `portal`: a claim whose attach committed ({@link recordPortalKeyEntry}).
 *
 * Never: an enrolled device (step 2), a refused attempt, token refresh, offline grace, documents,
 * `license/enroll`, store bindings, sign-in activation, choosing a licence, Replace, an
 * `already_yours` claim, or the signed-out preview. With Identity off nothing is counted or
 * refused, and no member is sent.
 *
 * ── THE LIMIT AND THE SWITCH ────────────────────────────────────────────────────────────────
 *
 * `keyEntryLimit()` reads the product's `identity.keyEntry.limit` row in `product_settings` (1 to
 * 100), else 10; ST-04 replaces its body with `resolveSetting()`, and I-09's discovery member calls
 * it (plans/PX-W9.md §8 Q2). `keyEntryRefusalsOn()` reads the platform switch
 * `identity.keyEntryRefusals` (A-13 store, `KEYENTRY_REFUSALS`), off until the SDKs that
 * show the refusal ship. The refusal applies only to a usable licence in no account
 * (`account_id IS NULL`, §8 Q3); a licence in an account meets I-09's `license_owned` first.
 */

import type {
  KeyEntries,
  KeyEntrySurface,
} from "@polaris-key/protocol/identity";
import type { Db, DbStatement } from "../db/types.js";
import { randomId } from "../crypto.js";
import type { LicenseRow } from "./data.js";
import { licenseUsable } from "./devices.js";
import { ErrorCode, errorResponse } from "./errors.js";
import { identityEnabled } from "./identityGate.js";
import { buildManageUrl } from "./manageUrl.js";
import { platformSetting, type SettingsEnv } from "./platformSettings.js";
import type { ServicesMap } from "./services.js";
import {
  KEY_ENTRY_LIMIT_DEFAULT,
  KEY_ENTRY_LIMIT_MAX,
  KEY_ENTRY_LIMIT_MIN,
} from "./settings/platform.js";

/** The registry key of the product's limit (`services/identity/settings.ts`). */
export const KEY_ENTRY_LIMIT_SETTING = "identity.keyEntry.limit";

/** A product, as a slug (its toggle is read from the row) or loaded (its services map is used). */
export type KeyEntryProduct = string | { slug: string; services: ServicesMap };

const slugOf = (p: KeyEntryProduct): string =>
  typeof p === "string" ? p : p.slug;

/** Is the product's Identity toggle on? Counting, the limit and the refusal exist only then. */
export async function keyEntriesApply(
  db: Db,
  product: KeyEntryProduct,
): Promise<boolean> {
  return typeof product === "string"
    ? identityEnabled(db, product)
    : product.services.identity?.enabled === true;
}

/**
 * A stored limit, or `null` when the value is not one: a JSON integer from `KEY_ENTRY_LIMIT_MIN`
 * to `KEY_ENTRY_LIMIT_MAX` (I-04 Q7: no unlimited value while Identity is on).
 */
export function parseKeyEntryLimit(valueJson: string | null): number | null {
  if (valueJson === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(valueJson) as unknown;
  } catch {
    return null;
  }
  return typeof v === "number" &&
    Number.isSafeInteger(v) &&
    v >= KEY_ENTRY_LIMIT_MIN &&
    v <= KEY_ENTRY_LIMIT_MAX
    ? v
    : null;
}

/**
 * The product's effective `identity.keyEntry.limit`: its `product_settings` row when it holds a
 * valid value, else `KEY_ENTRY_LIMIT_DEFAULT` (10). Capped at the platform maximum by
 * construction. ST-04 swaps the body for `resolveSetting()` (manifest, console, platform bound).
 */
export async function keyEntryLimit(db: Db, product: string): Promise<number> {
  const row = await db.first<{ value_json: string | null }>(
    "SELECT value_json FROM product_settings WHERE product = ? AND key = ?",
    product,
    KEY_ENTRY_LIMIT_SETTING,
  );
  return parseKeyEntryLimit(row?.value_json ?? null) ?? KEY_ENTRY_LIMIT_DEFAULT;
}

/** The licence's recorded key entries (`used`). */
export async function countKeyEntries(
  db: Db,
  product: string,
  licenseId: string,
): Promise<number> {
  const r = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM license_key_entries WHERE product = ? AND license_id = ?",
    product,
    licenseId,
  );
  // COUNT(*) always answers one row; a missing one means the read did not happen.
  if (!r || typeof r.n !== "number")
    throw new Error("countKeyEntries: count read returned no row");
  return r.n;
}

/** `{used, limit}` for the licence, or `null` when the product's Identity toggle is off. */
export async function keyEntryState(
  db: Db,
  product: KeyEntryProduct,
  licenseId: string,
): Promise<KeyEntries | null> {
  if (!(await keyEntriesApply(db, product))) return null;
  const slug = slugOf(product);
  return {
    used: await countKeyEntries(db, slug, licenseId),
    limit: await keyEntryLimit(db, slug),
  };
}

/** The platform switch `identity.keyEntryRefusals`: may a licence past its limit be refused? */
export async function keyEntryRefusalsOn(
  env: SettingsEnv,
  db: Db,
): Promise<boolean> {
  return (await platformSetting(env, db, "KEYENTRY_REFUSALS")) === "on";
}

/**
 * §12.2 rule 2: the device is enrolled on the licence (its `devices` row names the licence and is
 * authorised). An enrolled device is never refused and never counted.
 */
export async function isEnrolled(
  db: Db,
  product: string,
  licenseId: string,
  deviceId: string,
): Promise<boolean> {
  const row = await db.first<{ one: number }>(
    `SELECT 1 AS one FROM devices
      WHERE product = ? AND device_id = ? AND license_id = ? AND status = 'authorized'`,
    product,
    deviceId,
    licenseId,
  );
  return row !== null;
}

/**
 * One device entry (`app` or `browser`), guarded so it is written only while the device is NOT
 * yet enrolled on the licence. `claimDeviceSeat` runs it in the same batch as its seat INSERT and
 * BEFORE it, so the guard reads the row as it was before the claim:
 *
 *   - the seat INSERT applies (the device was not enrolled): the entry stands, exactly once;
 *   - the seat INSERT loses the ordinal race (a UNIQUE violation): the batch rolls back, entry
 *     included, and the retry builds a fresh statement;
 *   - another call from the same device committed first: the device is enrolled now, so the guard
 *     writes nothing (the seat INSERT is then a no-op as well).
 *
 * A guard on the row AFTER the claim ("the device now holds this seat") cannot tell the second
 * call from the first and would count it twice.
 */
export function stmtRecordDeviceKeyEntry(
  product: string,
  licenseId: string,
  deviceId: string,
  surface: Exclude<KeyEntrySurface, "portal">,
  now: number,
): DbStatement {
  return {
    sql: `INSERT INTO license_key_entries
            (product, license_id, id, surface, device_id, created_at)
          SELECT ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM devices
              WHERE product = ? AND device_id = ? AND license_id = ?
                AND status = 'authorized')`,
    params: [
      product,
      licenseId,
      randomId("ke"),
      surface,
      deviceId,
      now,
      product,
      deviceId,
      licenseId,
    ],
  };
}

/**
 * The `portal` entry of a claim whose attach committed (§12.2 rule 1). Never on `already_yours`
 * or a refused claim, and only while the product's Identity toggle is on. Never refused: adding
 * the key to an account is the way past the limit.
 */
export async function recordPortalKeyEntry(
  db: Db,
  product: KeyEntryProduct,
  licenseId: string,
  now: number,
): Promise<void> {
  if (!(await keyEntriesApply(db, product))) return;
  await db.run(
    `INSERT INTO license_key_entries
       (product, license_id, id, surface, device_id, created_at)
     VALUES (?, ?, ?, 'portal', NULL, ?)`,
    slugOf(product),
    licenseId,
    randomId("ke"),
    now,
  );
}

/** What the device routes do before `authorizeDevice` (§12.2 steps 2 and 4). */
export type KeyEntryGate =
  /** Identity is off: nothing is counted or refused, and no member is sent. */
  | { kind: "off" }
  /** Authorise as before, passing `keyEntry` so a new authorisation records its entry. */
  | { kind: "admit"; keyEntries: KeyEntries; enrolled: boolean }
  /** Step 4: answer `key_entry_limit` ({@link keyEntryLimitResponse}); nothing is written. */
  | { kind: "refuse"; keyEntries: KeyEntries };

/**
 * §12.2 steps 2 and 4 for `license/activate` and `identity/session/license`, after the key and
 * the licence have been resolved. An enrolled device is admitted. A device that is not is refused
 * only when the switch is on, the licence is usable (an unusable one keeps its `401` from
 * `authorizeDevice`) and in no account, and `used >= limit`. Step 3 is I-09's `license_owned`.
 */
export async function keyEntryGate(
  env: SettingsEnv,
  db: Db,
  product: { slug: string; services: ServicesMap },
  license: LicenseRow,
  deviceId: string,
  now: number,
): Promise<KeyEntryGate> {
  const keyEntries = await keyEntryState(db, product, license.id);
  if (!keyEntries) return { kind: "off" };
  if (await isEnrolled(db, product.slug, license.id, deviceId))
    return { kind: "admit", keyEntries, enrolled: true };
  if (
    licenseUsable(license, now) &&
    (license.account_id ?? null) === null &&
    keyEntries.used >= keyEntries.limit &&
    (await keyEntryRefusalsOn(env, db))
  )
    return { kind: "refuse", keyEntries };
  return { kind: "admit", keyEntries, enrolled: false };
}

/**
 * The flat `403 key_entry_limit` (§12.2 step 4): `{error, message, manageUrl?, keyEntries}`, with
 * the §5.3 link (`<portal>/activate?product=<slug>`) while the product's portal is on. Not an auth
 * failure: a client keeps its state and offers the link behind a user action.
 */
export async function keyEntryLimitResponse(
  env: Parameters<typeof buildManageUrl>[0],
  db: Db,
  req: Request,
  product: { slug: string },
  keyEntries: KeyEntries,
): Promise<Response> {
  const manageUrl = await buildManageUrl(env, db, req, product, {
    kind: "key_entry_limit",
  });
  return errorResponse(
    403,
    ErrorCode.KeyEntryLimit,
    "key entry limit reached",
    {
      ...(manageUrl !== undefined ? { manageUrl } : {}),
      keyEntries,
    },
  );
}
