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
 * Nothing here knows what a "release channel" is beyond its name. The selector arrives as a
 * canonical name the CALLING service has already classified, because channel classification
 * (stable / beta / `pr-42` / an operator's manual channel) is Release's model, not Core's. The
 * grant is then read by `channelEntitled` (`core/channels.ts`), the same predicate the licence
 * build gate uses (WIRE-CONTRACT-V3 §5.1 rule 4).
 */

import { CHANNEL_STABLE } from "@polaris-key/protocol";
import type { AllowedRange } from "@polaris-key/protocol";
import type { ReleaseAccess } from "@polaris-key/protocol/release";
import { channelEntitled } from "./channels.js";
import { errorResponse, wireError } from "./errors.js";
import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import type { ProductPublic } from "./products.js";
import type { DeviceRow, LicenseRow } from "./data.js";
import {
  licenseUsable,
  validateDeviceToken,
  type LicensedDeviceToken,
} from "./devices.js";
import { resolveMergedPayload } from "./payload.js";
import { trustRefusal } from "./deviceTrust.js";
import {
  entitledChannels,
  injectAdminPolicy,
  parseSemver,
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
  product: ProductPublic,
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
   * The canonical channel name the request resolves to (WIRE-CONTRACT-V3 §5.1) — `null` or
   * `"stable"` for the shipping channel, which every grant holds; `beta` for a `beta` or
   * `staging` selector; `pr-<n>` (which a `pr` grant also covers); a manual name; or the raw
   * unclassifiable string. Already classified by the calling service.
   */
  channel?: string | null;
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
  product: ProductPublic,
  token: string | null,
  selector: EntitledSelector,
  now: number,
): Promise<EntitledGrant | EntitledDenial> {
  const valid = await usableLicensedDevice(env, db, product, token, now);
  if ("error" in valid) return { ok: false, status: 401, code: "unauthorized" };
  const decision = await grantDecision(
    db,
    product,
    valid.license,
    valid.device,
    selector,
    now,
  );
  if (!decision.ok) return decision;
  return { ...decision, license: valid.license, device: valid.device };
}

/**
 * The channel-then-version half of the decision, for a licence already known to be usable.
 * `device` is the caller's device when there is one (its overrides are a layer of the grant, as
 * in the licence document); the portal, which authenticates a person rather than a device, has
 * none and passes `null` — the licence's own grant is then the whole answer.
 */
async function grantDecision(
  db: Db,
  product: ProductPublic,
  license: LicenseRow,
  device: DeviceRow | null,
  selector: EntitledSelector,
  now: number,
): Promise<
  | { ok: true; channels: string[]; allowedRange: AllowedRange }
  | Exclude<EntitledDenial, { status: 401 }>
> {
  const { payload, tier } = await resolveMergedPayload(
    db,
    product.slug,
    license,
    device,
    now,
    { entitlementsOnly: true },
  );
  injectAdminPolicy(payload, tier, license, tighterMin, tighterMax);
  const channels = entitledChannels(payload.entitlements);
  const allowedRange = versionWindow(
    payload.entitlements,
    product.compatMin,
    product.compatMax,
  );

  if (!channelEntitled(channels, selector.channel || CHANNEL_STABLE)) {
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
  return { ok: true, channels, allowedRange };
}

/**
 * `entitled` for a LICENCE rather than a device token — the customer portal's question (P2b-04).
 * A portal account holds licences, not a `pkeyt_` token, so the same grant is evaluated from the
 * licence alone (no device layer). True when the licence is usable, the channel is in its grant
 * and the version sits in its window; a pinned version the window cannot order is refused when
 * the window is bounded, exactly as `accessRefusal` does for a device.
 */
export async function licenseEntitled(
  db: Db,
  product: ProductPublic,
  license: LicenseRow,
  selector: EntitledSelector,
  now: number,
): Promise<boolean> {
  if (!licenseUsable(license, now)) return false;
  const decision = await grantDecision(
    db,
    product,
    license,
    null,
    selector,
    now,
  );
  if (!decision.ok) return false;
  return !unorderablePin(selector, true, decision.allowedRange);
}

// ── One refusal for every delivery surface (P2b-04) ─────────────────────────────────────────

/**
 * The selector for ONE fixed release, checked by its STORED version: pinned, on the stable
 * channel, never re-read as a route selector. A release synced from the tag `latest`, `stable`,
 * `beta`, `pr-5` or a manual channel's name stores that word as its version, and classifying it
 * as a selector would read it as a moving channel, which has no window check (P2-05 security
 * round). Release's `access.ts` and Distribution's byte routes both use this one definition.
 */
export function fixedReleaseSelector(version: string): EntitledSelector {
  return { channel: CHANNEL_STABLE, version: version.replace(/^v/, "") };
}

/** A pinned version the window cannot order, under a bounded window (see `accessRefusal`). */
function unorderablePin(
  selector: EntitledSelector,
  pinned: boolean,
  allowedRange: AllowedRange,
): boolean {
  return (
    pinned &&
    !parseSemver(selector.version ?? "") &&
    Boolean(allowedRange.min || allowedRange.max)
  );
}

/**
 * Enforce a delivery access mode for a request bearing `token`. Returns `null` when it may
 * proceed, or the refusal to answer with. The one implementation Release's surfaces (through its
 * gateway) and Distribution's byte routes share, so a mode means the same everywhere.
 *
 *   - `public` demands nothing.
 *   - `authenticated` / `licensed` answer the flat v2 body (`download_auth_required`) they have
 *     always answered with: those surfaces moved, they did not change.
 *   - `entitled` (D-13) speaks wire v3: `401 unauthorized`, `403 channel_not_allowed`,
 *     `403 version_blocked` with `allowedRange` at the top level.
 *
 * `pinned` says the request names one concrete version (a pinned selector, or a fixed release's
 * stored version even when it is empty). Such a version is refused whenever the window is
 * bounded and cannot order it: `versionInWindow` compares with `compareSemver`, which calls
 * anything it cannot parse EQUAL to both bounds, so `1.2.3.4` or `3.0.0beta` would otherwise
 * pass any window.
 */
export async function accessRefusal(
  env: Env,
  db: Db,
  product: ProductPublic,
  token: string | null,
  mode: ReleaseAccess,
  selector: EntitledSelector,
  pinned: boolean,
  now: number,
): Promise<Response | null> {
  if (mode === "public") return null;

  if (mode === "entitled") {
    const decision = await entitledAccessCheck(
      env,
      db,
      product,
      token,
      selector,
      now,
    );
    if (decision.ok) {
      if (unorderablePin(selector, pinned, decision.allowedRange))
        return wireError(403, "version_blocked", {
          allowedRange: decision.allowedRange,
        });
      return trustRefusal(
        env,
        db,
        product,
        decision.device,
        "gatedDelivery",
        now,
        "wire",
      );
    }
    if (decision.code === "version_blocked")
      return wireError(403, "version_blocked", {
        allowedRange: decision.allowedRange,
      });
    if (decision.code === "channel_not_allowed")
      return wireError(403, "channel_not_allowed");
    return wireError(401, "unauthorized");
  }

  const valid = await usableLicensedDevice(env, db, product, token, now);
  if ("error" in valid)
    return errorResponse(
      401,
      "download_auth_required",
      "a valid license is required to download this release artifact",
    );
  return trustRefusal(
    env,
    db,
    product,
    valid.device,
    "gatedDelivery",
    now,
    "flat",
  );
}

// ── A delivery gate (P4-05) ─────────────────────────────────────────────────────────────────

/**
 * Refuse a request unless its device token's licence holds one of `flags` — the delivery GATE
 * of a pack (P4-01 decision 35: the `entitlement` of the pack's own `dist_access` row, a licence
 * flag the operator names). Returns `null` to serve, or the refusal: `401 unauthorized` without a
 * usable licence (the `entitled` mode's wire-v3 answer), `403 not_entitled` when the licence holds
 * none of the flags.
 *
 * The grant is the one the licence document would carry — `resolveMergedPayload` then
 * `injectAdminPolicy`, the composition `entitledAccessCheck` performs — so a device sees in its
 * own document exactly the flag this check reads. A flag is held when its entry's value is
 * `true`; any other value (absent, `false`, a string) is not held. The caller passes the gate's
 * CURRENT values, never a manifest assertion or a signed record's publish-time snapshot, so
 * renaming a pack's flag moves who may download at once.
 */
export async function entitlementFlagRefusal(
  env: Env,
  db: Db,
  product: ProductPublic,
  token: string | null,
  flags: readonly string[],
  now: number,
): Promise<Response | null> {
  const valid = await usableLicensedDevice(env, db, product, token, now);
  if ("error" in valid) return wireError(401, "unauthorized");
  const { payload, tier } = await resolveMergedPayload(
    db,
    product.slug,
    valid.license,
    valid.device,
    now,
    { entitlementsOnly: true },
  );
  injectAdminPolicy(payload, tier, valid.license, tighterMin, tighterMax);
  const held = flags.some(
    (f) =>
      Object.hasOwn(payload.entitlements, f) &&
      payload.entitlements[f]?.value === true,
  );
  if (!held) return wireError(403, "not_entitled");
  return trustRefusal(
    env,
    db,
    product,
    valid.device,
    "gatedDelivery",
    now,
    "wire",
  );
}

/**
 * Does `license` hold one of `flags`? The licence-only twin of `entitlementFlagRefusal`, for a
 * caller with no device (F-21's licence-bound registry tokens, plans/F-20.md §6.2): the same
 * grant composition (`resolveMergedPayload` with no device, then `injectAdminPolicy`), and a flag
 * is held when its entry's value is `true`. The caller has already checked `licenseUsable`.
 * Device trust does not apply: a registry token has no device (the portal download's rule).
 */
export async function licenseHoldsFlags(
  db: Db,
  product: string,
  license: LicenseRow,
  flags: readonly string[],
  now: number,
): Promise<boolean> {
  if (flags.length === 0) return false;
  const { payload, tier } = await resolveMergedPayload(
    db,
    product,
    license,
    null,
    now,
    { entitlementsOnly: true },
  );
  injectAdminPolicy(payload, tier, license, tighterMin, tighterMax);
  return flags.some(
    (f) =>
      Object.hasOwn(payload.entitlements, f) &&
      payload.entitlements[f]?.value === true,
  );
}
