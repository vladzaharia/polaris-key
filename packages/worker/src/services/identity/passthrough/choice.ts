/// <reference types="@cloudflare/workers-types" />

/**
 * The licence choice's two views (WIRE-CONTRACT-V4 §12.4.1, §12.5.1; plans/I-04.md §A to §C, §F, §G).
 *
 * One builder, two callers: the card (`GET /api/signin/requests/:handle/licenses[/:id/devices]`,
 * the account session and the request's binder) and the pending sign-in grant
 * (`POST /<p>/identity/choice/{licenses,devices}`, the grant and the redeeming device). Both answer
 * the same `LicenseChoiceView` and `ReplaceView`, so the rules of I-04 §A are written once.
 *
 * Everything here is display data and read-only: the views authorise nothing. Binding re-reads the
 * same offer (`bindSignedInDevice`), so a stale or forged view cannot choose a licence.
 *
 *   state    "choose": the account holds a candidate, or the device runs on a licence outside the
 *            list (Keep). "autoIssue": no candidate and the product's policy grants one (the card
 *            skips the step; Continue mints). "none": neither (the no-licence state; a key can
 *            still be entered where the product accepts them).
 *   access   "account" for a licence issued by signing in (no key), "seats" otherwise. Never a
 *            displayed type; it follows the same seat count as any licence (F.6).
 *   replace  only on a full row, and only while the product's portal is on (Replace is the
 *            portal's Remove). Whether the shared budget is spent is not known until the press.
 */

import type {
  LicenseChoice,
  LicenseChoiceOrigin,
  LicenseChoiceView,
  ReplaceView,
} from "@polaris-key/protocol/identity";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { ProductPublic } from "../../../core/products.js";
import type { LicenseRow } from "../../../core/repo.js";
import { seatActiveSince } from "../../../core/devices/store.js";
import { getLicense, getTier } from "../../../core/licensing/store.js";
import {
  rankAnchorCandidates,
  type AnchorCandidate,
  type AnchorCandidates,
} from "../../../core/licensing/anchor.js";
import { accountGrant } from "../../../core/licensing/issueAccount.js";
import { buildManageUrl } from "../../../core/licensing/manageUrl.js";
import { customerOrigin } from "../../../core/hosts.js";
import type { OidcIdentity } from "../../../core/licensing/issue.js";
import { getAccountRow } from "../accounts/repo.js";
import { discoverIdentity } from "../portal/store/obtain.js";
import { getPortalProductSettings } from "../portal/repo.js";

/** A device seen this recently is "Active now" (I-04 §B). */
export const ACTIVE_NOW_SECONDS = 600;

export interface ChoiceCx {
  env: Env;
  db: Db;
  product: ProductPublic;
  now: number;
}

/**
 * The account as the auto-issue policy sees it: its platform identity when it has one, else an
 * email-only account's empty one (no groups, so only the product's `oidcDefault` can grant it a
 * licence; plans/I-27.md §2.2).
 */
export async function accountIdentity(
  env: Env,
  db: Db,
  accountId: string,
): Promise<OidcIdentity> {
  const found = await discoverIdentity(env, db, accountId);
  if (found) return found;
  const account = await getAccountRow(db, accountId);
  const email = account?.primary_email ?? undefined;
  const name = account?.display_name ?? undefined;
  return {
    sub: "",
    ...(email !== undefined ? { email } : {}),
    ...(name !== undefined ? { name } : {}),
    groups: [],
    claims: {},
  };
}

/** The policy's grant for the account (`null`: grants nothing), as `rankAnchorCandidates` wants it. */
export async function grantFor(
  cx: ChoiceCx,
  accountId: string,
): Promise<{ tierId: string | null; identity: OidcIdentity } | null> {
  if (!cx.product.services.license.enabled) return null;
  const identity = await accountIdentity(cx.env, cx.db, accountId);
  const grant = await accountGrant(cx.db, cx.product, identity, cx.now);
  return grant ? { tierId: grant.tierId, identity } : null;
}

/**
 * The candidates for the account on this device (`deviceId`, when it exists), with the policy's
 * grant folded in so `create` is offered when it should be. A tier-less grant (a group mapped to
 * no tier) still offers `create`, hence the empty-string tier id.
 */
export async function offerFor(
  cx: ChoiceCx,
  accountId: string,
  deviceId: string | null,
): Promise<AnchorCandidates & { granted: boolean }> {
  const grant = await grantFor(cx, accountId);
  const offer = await rankAnchorCandidates(
    cx.db,
    cx.product,
    accountId,
    cx.now,
    {
      deviceId,
      ...(grant ? { grantTierId: grant.tierId ?? "" } : {}),
    },
  );
  return { ...offer, granted: grant !== null };
}

/** How the licence reached the account, in the words of I-04 §C. */
async function originOf(
  db: Db,
  license: LicenseRow,
  access: "seats" | "account",
): Promise<LicenseChoiceOrigin> {
  if (access === "account") return "signin";
  if (license.origin === "enroll") return "free";
  const key = await db.first<{ one: number }>(
    "SELECT 1 AS one FROM keys_index WHERE product = ? AND license_id = ? LIMIT 1",
    license.product,
    license.id,
  );
  return key ? "key" : "developer";
}

async function tierLabel(cx: ChoiceCx, tierId: string | null): Promise<string> {
  const tier = tierId ? await getTier(cx.db, cx.product.slug, tierId) : null;
  return tier?.label ?? cx.product.name;
}

/** Whether the product accepts a key at sign-in (the no-licence state's inline key field). */
export function acceptsKeys(product: ProductPublic): boolean {
  return product.services.license.enabled;
}

/** What the card or the app needs to render the step (`LicenseChoiceView`). */
export async function licenseChoiceView(
  cx: ChoiceCx,
  req: Request,
  accountId: string,
  opts: {
    deviceId: string | null;
    /** The card's request handle and the device's label, for the Free-a-device link. */
    card?: { handle: string; deviceLabel: string | null };
  },
): Promise<LicenseChoiceView> {
  const { db, product } = cx;
  const offer = await offerFor(cx, accountId, opts.deviceId);
  const portal =
    (await getPortalProductSettings(db, product.slug)).portal_enabled === 1;

  const customer = customerOrigin(cx.env, req) ?? new URL(req.url).origin;
  const choices: LicenseChoice[] = [];
  for (const c of offer.candidates) {
    const license = await getLicense(db, product.slug, c.licenseId);
    if (!license) continue;
    choices.push(await choiceRow(cx, customer, license, c, portal, opts.card));
  }
  const state: LicenseChoiceView["state"] =
    offer.candidates.length > 0 || offer.keep
      ? "choose"
      : offer.granted
        ? "autoIssue"
        : "none";

  let create: LicenseChoiceView["create"] = null;
  if (offer.create || state === "autoIssue") {
    const grant = await grantFor(cx, accountId);
    create = {
      tierName: await tierLabel(cx, grant?.tierId ?? null),
      access: "account",
    };
  }

  let getLicenseMember: LicenseChoiceView["getLicense"] = null;
  if (state === "none") {
    const activateUrl =
      (await buildManageUrl(cx.env, db, req, product, {
        kind: "key_entry_limit",
      })) ?? `${customer}/activate?product=${product.slug}`;
    getLicenseMember = {
      activateUrl,
      purchaseUrl: null,
      keyEntry: acceptsKeys(product),
    };
  }

  return {
    state,
    choices,
    keep: offer.keep,
    preselected: offer.preselected,
    create,
    getLicense: getLicenseMember,
  };
}

async function choiceRow(
  cx: ChoiceCx,
  origin: string,
  license: LicenseRow,
  c: AnchorCandidate,
  portal: boolean,
  card: { handle: string; deviceLabel: string | null } | undefined,
): Promise<LicenseChoice> {
  const full = c.state === "full";
  const returnTo = card
    ? `/signin?request=${card.handle}`
    : null; /* the card's own address */
  const freeDeviceUrl =
    card && full && portal
      ? `${origin}/#/p/${encodeURIComponent(cx.product.slug)}/free-device?license=${encodeURIComponent(c.licenseId)}${
          card.deviceLabel ? `&for=${encodeURIComponent(card.deviceLabel)}` : ""
        }&return=${encodeURIComponent(returnTo ?? "")}`
      : null;
  return {
    id: c.licenseId,
    tierName: await tierLabel(cx, c.tierId),
    name: null,
    origin: await originOf(cx.db, license, c.access),
    access: c.access,
    seats: { used: c.seats.used, limit: c.seats.limit },
    current: c.current,
    expiresAt: c.expiresAt,
    state: c.state,
    ...(c.blockedReason ? { blockedReason: c.blockedReason } : {}),
    // Replace is the portal's Remove (I-04 §B): it needs the portal on and an owned licence, which
    // every candidate here is (`licenses.account_id`).
    replace: full ? { allowed: portal, retryAfter: null } : null,
    freeDeviceUrl,
  };
}

/**
 * The seat-holding devices of one FULL licence in the account's offer, or `null` for every other
 * id (unknown, another account's, not full, portal off): the caller answers one `404 not_found`
 * for all of them, so nothing can be enumerated (G.6).
 */
export async function replaceView(
  cx: ChoiceCx,
  accountId: string,
  licenseId: string,
  opts: { deviceId: string | null },
): Promise<ReplaceView | null> {
  const { db, product } = cx;
  const portal =
    (await getPortalProductSettings(db, product.slug)).portal_enabled === 1;
  if (!portal) return null;
  const offer = await offerFor(cx, accountId, opts.deviceId);
  const row = offer.candidates.find((c) => c.licenseId === licenseId);
  if (!row || row.state !== "full") return null;
  const held = await db.all<{
    device_id: string;
    label: string | null;
    platform: string | null;
    last_seen: number;
  }>(
    `SELECT device_id, label, platform, last_seen FROM devices
      WHERE product = ? AND license_id = ? AND status = 'authorized'
        AND last_seen > ? AND device_id <> ?
      ORDER BY last_seen ASC, device_id ASC`,
    product.slug,
    licenseId,
    seatActiveSince(cx.now),
    opts.deviceId ?? "",
  );
  return {
    licenseId,
    seats: { used: row.seats.used, limit: row.seats.limit },
    devices: held.map((d, i) => ({
      id: d.device_id,
      label: d.label,
      platform: d.platform,
      deviceType: null,
      lastSeen: d.last_seen,
      leastRecent: i === 0,
      activeNow: cx.now - d.last_seen < ACTIVE_NOW_SECONDS,
      thisBrowser: d.device_id === `browser:${licenseId}`,
    })),
    replace: { allowed: true, retryAfter: null },
  };
}
