/**
 * The sign-in licence choice (I-09; plans/I-09.md §2, plans/I-04.md "Owner decision
 * (2026-10-05): licence choice at sign-in" §A and §F, S-19 decision 3).
 *
 * A sign-in that binds a device asks the person which licence to use and never chooses silently.
 * This module is the one place that answers "which licences could this device run on, in what
 * order, and which one is preselected", and the one place that binds the device to the choice:
 *
 *   rankAnchorCandidates(db, product, accountId, now, opts)
 *       every usable licence the account holds for the product, in `rank-first` order, each with
 *       its seat state (`free`, `full`, `blocked`; a full licence is listed, never hidden), the
 *       device's own row marked `current`, `keep` for a usable licence the device runs on that is
 *       not a candidate, `create` when the product would auto-issue and no candidate is free, and
 *       the `preselected` row. Read-only.
 *   bindSignedInDevice(env, db, product, input)
 *       binds the device to the person's explicit choice: a candidate (seat-checked), `keep`
 *       (only the binding), or `create` (the caller's mint). Sets `devices.subject` with
 *       `bound_by = 'signin'` on a seat it claims. Refuses a choice that was not offered.
 *   licenseAccess(db, license)
 *       `account` for a sign-in licence (held by an account, no licence key ever issued), else
 *       `seats`. The fact behind the origin "From signing in" and the mixed rule; never a
 *       displayed type, and never an authorisation input (sign-in licences stay device-limited).
 *
 * ── THE ORDER (S-19 decision 3, `anchorPolicy: rank-first`, inline until LX-10) ──────────────
 *
 * No expiry first, then the latest expiry, then the earliest activation, then the id. Every tier
 * ranks 0 until LX-08 adds `tiers.rank`. The order only arranges the rows and picks the
 * preselection when the device runs on nothing usable: it never moves a device. The device's own
 * licence is preselected over any higher-ranked one, then Keep (§F.1, §F.2).
 *
 * ── NO SECOND AUTOMATIC LICENCE ─────────────────────────────────────────────────────────────
 *
 * `create` is offered only when the caller says the product's policy grants this person a tier
 * AND no candidate is free (there are none, or every one is full or blocked). It is preselected
 * only when there is no candidate at all. `bindSignedInDevice` mints (through the caller's
 * `mint`) only on an explicit `create` that was offered, so a usable licence in the account always
 * stops a second automatic one.
 *
 * LX-10 replaces the body of the ranking behind the same signature; I-24a adds seat-holder
 * licences through `opts.alsoCandidates`. Core, because I-08's sign-in (Identity) and the portal
 * both call it and Identity may not reach into License (rule 6).
 */

import type { Db } from "../db/types.js";
import type { Env } from "../env.js";
import {
  authorizeDevice,
  licenseDeviceLimit,
  tierFingerprintMode,
  type AuthzError,
} from "./authz.js";
import {
  countActiveDevices,
  getLicense,
  seatActiveSince,
  type DeviceRow,
  type LicenseRow,
} from "./data.js";
import { licenseUsable } from "./devices.js";
import { identityEnabled } from "./identityGate.js";
import type { Product, ProductPublic } from "./products.js";
import {
  PAIRWISE_SUBJECT_PATTERN,
  setDeviceSubject,
} from "./accountSubjects.js";

/** How a licence reaches its devices (I-04 §F.6). Display only. */
export type LicenseAccess = "seats" | "account";

/**
 * A sign-in licence (`account`) is held by an account (or, before I-32b, a legacy `sub`) and has
 * never had a licence key, live or revoked: today's "Signed-in app" licences, the rule the
 * portal's library already uses. Every other licence is a seat licence (`seats`). Derived, never
 * stored. Its devices still count against its device limit like any other licence's.
 */
export async function licenseAccess(
  db: Db,
  license: Pick<LicenseRow, "product" | "id" | "sub"> & {
    account_id?: string | null;
  },
): Promise<LicenseAccess> {
  const held = (license.account_id ?? null) !== null || license.sub !== null;
  if (!held) return "seats";
  const key = await db.first<{ one: number }>(
    "SELECT 1 AS one FROM keys_index WHERE product = ? AND license_id = ? LIMIT 1",
    license.product,
    license.id,
  );
  return key ? "seats" : "account";
}

/** A candidate's seat state on the card (I-04 §A rule 2). */
export type AnchorSeatState = "free" | "full" | "blocked";

/** One licence the device could run on, as the card lists it. */
export interface AnchorCandidate {
  licenseId: string;
  tierId: string | null;
  expiresAt: number | null;
  activatedAt: number;
  access: LicenseAccess;
  /** Seat-holding devices (authorized and seen within the dormancy window) and the limit. */
  seats: { used: number; limit: number };
  state: AnchorSeatState;
  /** Why a row is `blocked`: its tier needs a hardware fingerprint this sign-in cannot present. */
  blockedReason?: "fingerprint_required";
  /** The licence the device already runs on ("On this device"). */
  current: boolean;
}

export interface AnchorCandidates {
  /** In rank-first order. */
  candidates: AnchorCandidate[];
  /** The device runs on a usable licence that is not a candidate (a key-entered or floating one). */
  keep: boolean;
  /** "Create a new free license": the policy grants this person a tier and no candidate is free. */
  create: boolean;
  /** A candidate's licence id, `"keep"`, `"create"`, or `null` when nothing can be chosen. */
  preselected: string | "keep" | "create" | null;
}

/** The order key of a candidate (rank-first; every tier ranks 0 until LX-08). */
export interface RankFacts {
  id: string;
  expiresAt: number | null;
  activatedAt: number;
}

/** `rank-first`: no expiry first, then the latest expiry, then the earliest activation, then id. */
export function compareCandidates(a: RankFacts, b: RankFacts): number {
  if (a.expiresAt === null && b.expiresAt !== null) return -1;
  if (b.expiresAt === null && a.expiresAt !== null) return 1;
  if (
    a.expiresAt !== null &&
    b.expiresAt !== null &&
    a.expiresAt !== b.expiresAt
  )
    return b.expiresAt - a.expiresAt;
  if (a.activatedAt !== b.activatedAt) return a.activatedAt - b.activatedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface RankOptions {
  /** The installation being signed in, when it already exists (`devices.device_id`). */
  deviceId?: string | null;
  /**
   * The tier the product's policy grants this person, or `null`/absent when it grants none. The
   * caller decides (I-08: the account-holder mint); the ranking only uses it to offer `create`.
   */
  grantTierId?: string | null;
  /** I-24a: licences the person holds a seat on without owning them. Deduplicated by id. */
  alsoCandidates?: readonly LicenseRow[];
}

/** The device row for (product, deviceId), when it is authorized. */
async function authorizedDevice(
  db: Db,
  product: string,
  deviceId: string | null | undefined,
): Promise<DeviceRow | null> {
  if (!deviceId) return null;
  return db.first<DeviceRow>(
    "SELECT * FROM devices WHERE product = ? AND device_id = ? AND status = 'authorized'",
    product,
    deviceId,
  );
}

/**
 * The account's candidates for `product`, ranked, with the preselection (see the header).
 * Read-only: it writes nothing and binds nothing, so the card and a dry run may call it freely.
 */
export async function rankAnchorCandidates(
  db: Db,
  product: ProductPublic,
  accountId: string,
  now: number,
  opts: RankOptions = {},
): Promise<AnchorCandidates> {
  const owned = await db.all<LicenseRow>(
    "SELECT * FROM licenses WHERE account_id = ? AND product = ? ORDER BY id",
    accountId,
    product.slug,
  );
  const byId = new Map<string, LicenseRow>();
  for (const l of [...owned, ...(opts.alsoCandidates ?? [])])
    if (l.product === product.slug && licenseUsable(l, now) && !byId.has(l.id))
      byId.set(l.id, l);

  const device = await authorizedDevice(db, product.slug, opts.deviceId);
  const since = seatActiveSince(now);
  const candidates: AnchorCandidate[] = [];
  for (const l of byId.values()) {
    const limit = await licenseDeviceLimit(db, product, l, now);
    const used = await countActiveDevices(db, product.slug, l.id, since);
    const current = device !== null && device.license_id === l.id;
    // A sign-in presents no fingerprint, so a `strict` tier's mint would refuse it.
    const strict =
      (await tierFingerprintMode(db, product, l.tier_id)) === "strict";
    const state: AnchorSeatState = strict
      ? "blocked"
      : current || (limit > 0 && used < limit)
        ? "free"
        : "full";
    candidates.push({
      licenseId: l.id,
      tierId: l.tier_id,
      expiresAt: l.expires_at,
      activatedAt: l.activated_at,
      access: await licenseAccess(db, l),
      seats: { used, limit },
      state,
      ...(strict ? { blockedReason: "fingerprint_required" as const } : {}),
      current,
    });
  }
  candidates.sort((a, b) =>
    compareCandidates(
      { id: a.licenseId, expiresAt: a.expiresAt, activatedAt: a.activatedAt },
      { id: b.licenseId, expiresAt: b.expiresAt, activatedAt: b.activatedAt },
    ),
  );

  // Keep: the device runs on a usable licence that is not listed (key-entered, floating, or
  // another account's), so signing in need not move it (I-09 Q1, §F.1).
  let keep = false;
  if (device && device.license_id !== "" && !byId.has(device.license_id)) {
    const running = await getLicense(db, product.slug, device.license_id);
    keep = running !== null && licenseUsable(running, now);
  }
  const anyFree = candidates.some((c) => c.state === "free");
  const create =
    opts.grantTierId !== undefined && opts.grantTierId !== null && !anyFree;

  const currentRow = candidates.find((c) => c.current);
  const firstFree = candidates.find((c) => c.state === "free");
  const preselected = currentRow
    ? currentRow.licenseId
    : keep
      ? "keep"
      : firstFree
        ? firstFree.licenseId
        : create && candidates.length === 0
          ? "create"
          : null;
  return { candidates, keep, create, preselected };
}

/** The person's explicit choice at Continue (I-04 §C). */
export type AnchorChoice =
  | { kind: "license"; licenseId: string }
  | { kind: "keep" }
  | { kind: "create" };

export interface BindSignedInDeviceInput {
  accountId: string;
  /** The account's pairwise subject for this product (`subjectFor`). */
  subject: string;
  deviceId: string;
  choice: AnchorChoice | null;
  now: number;
  /** What `rankAnchorCandidates` was asked with, so the bind checks the same offer. */
  rank?: Omit<RankOptions, "deviceId">;
  /** The policy's mint for `create` (I-08: an automatic licence attached to the account). */
  mint?: () => Promise<LicenseRow | null>;
  /** Passed through to `authorizeDevice` (metadata, the label, the refusal log's `waitUntil`). */
  authorize?: Omit<
    NonNullable<Parameters<typeof authorizeDevice>[6]>,
    "boundBy" | "subject" | "keyEntry"
  >;
}

export type BindSignedInDeviceResult =
  | {
      ok: true;
      /** The licence the device runs on after the bind (unchanged on `keep`). */
      licenseId: string;
      /** Present when a seat was claimed (a new token); absent on `keep`. */
      token?: string;
      device?: DeviceRow;
      minted: boolean;
    }
  /** The step was shown and the choice is missing or was not offered (I-08's 409). */
  | { ok: false; reason: "license_choice_required" }
  /** The chosen licence is not a candidate of this account. */
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "authz"; error: AuthzError }
  /** The bind refused: the product's Identity is off, or the device is not live. */
  | { ok: false; reason: "not_bindable" };

/**
 * Bind a signed-in device to the person's choice (I-04 §A rule 6: binding happens only on an
 * explicit choice). A candidate claims a seat through the seat-checked `authorizeDevice` with
 * `bound_by = 'signin'` and the subject; `keep` sets only the binding on the licence the device
 * already runs on (its `bound_by` is left alone, so a key-bound device is never released by a
 * sign-out); `create` calls the caller's `mint` and binds the new licence. With no candidate and
 * nothing to keep, a missing choice means `create` when it is offered. Never moves a device that
 * runs on a usable licence unless the person chose another one.
 */
export async function bindSignedInDevice(
  env: Env,
  db: Db,
  product: Product,
  input: BindSignedInDeviceInput,
): Promise<BindSignedInDeviceResult> {
  if (!PAIRWISE_SUBJECT_PATTERN.test(input.subject))
    throw new Error("bindSignedInDevice: not a pairwise subject");
  // PX-W17: no device of an Identity-off product carries a binding.
  if (!(await identityEnabled(db, product.slug)))
    return { ok: false, reason: "not_bindable" };
  const offer = await rankAnchorCandidates(
    db,
    product,
    input.accountId,
    input.now,
    { ...(input.rank ?? {}), deviceId: input.deviceId },
  );
  const stepShown = offer.candidates.length > 0 || offer.keep;
  const choice: AnchorChoice | null =
    input.choice ?? (!stepShown && offer.create ? { kind: "create" } : null);
  if (!choice) return { ok: false, reason: "license_choice_required" };

  if (choice.kind === "keep") {
    if (!offer.keep && !offer.candidates.some((c) => c.current))
      return { ok: false, reason: "license_choice_required" };
    const device = await authorizedDevice(db, product.slug, input.deviceId);
    if (!device) return { ok: false, reason: "not_bindable" };
    const bound = await setDeviceSubject(
      env,
      db,
      product.slug,
      input.deviceId,
      input.subject,
    );
    return bound
      ? { ok: true, licenseId: device.license_id, minted: false }
      : { ok: false, reason: "not_bindable" };
  }

  let license: LicenseRow | null;
  let minted = false;
  if (choice.kind === "create") {
    if (!offer.create || !input.mint)
      return { ok: false, reason: "license_choice_required" };
    license = await input.mint();
    if (!license) return { ok: false, reason: "not_bindable" };
    minted = true;
  } else {
    if (!offer.candidates.some((c) => c.licenseId === choice.licenseId))
      return { ok: false, reason: "not_found" };
    license = await getLicense(db, product.slug, choice.licenseId);
    if (!license) return { ok: false, reason: "not_found" };
  }
  const authorized = await authorizeDevice(
    env,
    db,
    product,
    license,
    input.deviceId,
    input.now,
    { ...(input.authorize ?? {}), boundBy: "signin", subject: input.subject },
  );
  if ("error" in authorized)
    return { ok: false, reason: "authz", error: authorized };
  return {
    ok: true,
    licenseId: license.id,
    token: authorized.token,
    device: authorized.device,
    minted,
  };
}
