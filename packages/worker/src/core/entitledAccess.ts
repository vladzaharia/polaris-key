/// <reference types="@cloudflare/workers-types" />

/**
 * `entitled` — the per-product release/update access mode that enforces a caller's own grant
 * (design spec D-13, plan §2.3).
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────────────────────
 *
 * R3 recorded it plainly: a stable-only licence could fetch `/<p>/beta/appcast.xml` and the
 * beta DMG behind it, because the release surface authenticated (at most) the DEVICE and never
 * consulted the grant. `licensed` asks "is there a usable licence"; it does not ask "is this
 * licence allowed *this* channel, at *this* version". `entitled` asks both.
 *
 * It is opt-in per product, and `public` stays the default: anonymous update checking is a
 * feature for the products that want it, and forcing every feed behind a token would break more
 * than it fixes (spec D-13 — "closes the R3 gap by policy, not by force").
 *
 * ── WHY IT LIVES IN CORE ────────────────────────────────────────────────────────────────────
 *
 * The check is a LICENCE question asked by two other services. Release and Update may not
 * import License (`test/boundaries.test.ts` — the only sanctioned cross-service edge is
 * `update → release`), so the answer has to come from the substrate. Core already owns both
 * halves: `validateDeviceToken` + `licenseUsable` (`core/devices.ts`) and the entitlement
 * algebra (`core/entitlements.ts`). This file is just the composition, and it is deliberately
 * the same composition the licence document performs — `resolveMergedPayload` then
 * `injectAdminPolicy` — so a caller refused a beta document is refused the beta feed for the
 * same reason, from the same rows.
 *
 * Nothing here knows what a "release channel" is beyond its name. The selector arrives as plain
 * strings the CALLING service has already classified, because channel classification (stable /
 * beta / `pr-42` / an operator's manual channel) is Release's model, not Core's.
 */

import type { AllowedRange } from "@plrs/protocol";
import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import type { Product } from "./products.js";
import type { DeviceRow, LicenseRow } from "./data.js";
import {
  licenseUsable,
  validateDeviceToken,
  type LicensedDeviceToken,
} from "./devices.js";
import { resolveMergedPayload } from "./payload.js";
import {
  entitledChannels,
  injectAdminPolicy,
  tighterMax,
  tighterMin,
  versionInWindow,
  versionWindow,
} from "./entitlements.js";

/**
 * A device token whose licence exists and is usable.
 *
 * The same predicate `services/license/auth.requireLicensedDevice` applies, expressed here in
 * Core so Release and Update can apply it without importing License. It is one composition of
 * two Core primitives rather than a second implementation: change `licenseUsable` and both
 * callers move together.
 */
export async function usableLicensedDevice(
  env: Env,
  db: Db,
  product: Product,
  token: string | null,
  now: number,
): Promise<LicensedDeviceToken | { error: "unauthorized" }> {
  const valid = await validateDeviceToken(env, db, product, token, now);
  if ("error" in valid) return valid;
  if (!licenseUsable(valid.license, now)) return { error: "unauthorized" };
  return {
    tokenHash: valid.tokenHash,
    license: valid.license,
    device: valid.device,
  };
}

/** What the caller asked for, in terms Core can evaluate. */
export interface EntitledSelector {
  /**
   * The channel name the request resolves to — `null` or `"stable"` for the shipping channel,
   * which every grant holds. Already classified by the calling service.
   */
  channel?: string | null;
  /**
   * A second, coarser name the same request may be entitled under: a `pr-42` selector is
   * satisfied by a grant that names either `pr-42` or `pr`, which is how the licence-side gate
   * spells the PR channel.
   */
  channelKind?: string | null;
  /** The concrete version being fetched, when the request pins one. Unpinned reads pass `null`. */
  version?: string | null;
}

/** Access granted: the grant that allowed it, so the caller can log or shape a response. */
export interface EntitledGrant {
  ok: true;
  channels: string[];
  allowedRange: AllowedRange;
  license: LicenseRow;
  device: DeviceRow;
}

/**
 * Access refused. `status` and `code` are the wire answer; the caller renders them (Core does
 * not know whether this surface speaks the nested v3 error shape or a service's own).
 */
export type EntitledDenial =
  | { ok: false; status: 401; code: "unauthorized" }
  | {
      ok: false;
      status: 403;
      code: "channel_not_allowed";
      /** The channel that was refused, for the operator-facing message. */
      channel: string;
    }
  | {
      ok: false;
      status: 403;
      code: "version_blocked";
      allowedRange: AllowedRange;
    };

/** Is a requested channel covered by the grant? `stable` is the floor every grant holds. */
function channelAllowed(
  allowed: readonly string[],
  selector: EntitledSelector,
): boolean {
  const channel = selector.channel;
  if (!channel || channel === "stable" || channel === "latest") return true;
  if (allowed.includes(channel)) return true;
  const kind = selector.channelKind;
  return Boolean(kind && kind !== channel && allowed.includes(kind));
}

/**
 * The `entitled` decision for one request.
 *
 * Order matters and mirrors the licence document's: authenticate first (a caller with no token
 * learns nothing about the product's channels), then channel, then version. Channel before
 * version because a channel refusal carries no range — telling an unentitled caller the exact
 * window of a feed they may not see would leak the shape of the thing being withheld.
 */
export async function entitledAccessCheck(
  env: Env,
  db: Db,
  product: Product,
  token: string | null,
  selector: EntitledSelector,
  now: number,
): Promise<EntitledGrant | EntitledDenial> {
  const valid = await usableLicensedDevice(env, db, product, token, now);
  if ("error" in valid) return { ok: false, status: 401, code: "unauthorized" };

  const { payload, tier } = await resolveMergedPayload(
    db,
    product.slug,
    valid.license,
    valid.device,
    now,
  );
  injectAdminPolicy(payload, tier, valid.license, tighterMin, tighterMax);
  const channels = entitledChannels(payload.entitlements);
  const allowedRange = versionWindow(
    payload.entitlements,
    product.compatMin,
    product.compatMax,
  );

  if (!channelAllowed(channels, selector)) {
    return {
      ok: false,
      status: 403,
      code: "channel_not_allowed",
      channel: selector.channel as string,
    };
  }
  if (selector.version && !versionInWindow(selector.version, allowedRange)) {
    return { ok: false, status: 403, code: "version_blocked", allowedRange };
  }
  return {
    ok: true,
    channels,
    allowedRange,
    license: valid.license,
    device: valid.device,
  };
}
