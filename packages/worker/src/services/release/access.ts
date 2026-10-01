/// <reference types="@cloudflare/workers-types" />

/**
 * Who may read a release surface — the single enforcement point for both services.
 *
 * Four modes, in increasing strictness (`@polaris-key/protocol/release`):
 *
 *   public         anyone. The default, and the reason anonymous update checking keeps working.
 *   authenticated  a device token whose licence is usable.
 *   licensed       identical to `authenticated` today; the distinction is declarative, and it
 *                  is preserved rather than collapsed so a product's stated posture survives.
 *   entitled       (D-13, new in P2.T3) the licence's OWN grant: the requested channel must be
 *                  in its entitled set, and a pinned version must sit inside its window.
 *
 * ── THE LICENCE QUESTION, WITHOUT THE LICENCE SERVICE ───────────────────────────────────────
 *
 * Before the split this file's predecessor imported `requireLicensedDevice` from
 * `services/license/`. A service may not do that (`test/boundaries.test.ts`), so the check now
 * goes through Core, which owns both halves — `usableLicensedDevice` is the same composition of
 * `validateDeviceToken` + `licenseUsable` the License service applies, and `entitledAccessCheck`
 * derives the grant from the same rows through the same merge the licence document uses. The
 * 401s are therefore the same 401s, for the same reasons, as before the move.
 *
 * ── TWO ERROR SHAPES, DELIBERATELY ──────────────────────────────────────────────────────────
 *
 * `authenticated`/`licensed` keep the flat v2 body they have always answered with
 * (`{"error":"download_auth_required"}`) — those surfaces MOVED, they did not change, and a
 * client that parses the refusal must not have to care which release the worker is on.
 * `entitled` is new in wire v3 and has no such history, so it speaks the nested v3 shape
 * throughout: `401 unauthorized`, `403 channel_not_allowed`, `403 version_blocked` +
 * `allowedRange` at the top level, exactly as `GET /<p>/license/document` does.
 */

import type { Env, Db } from "../../core/platform.js";
import { bearer } from "../../core/platform.js";
import type { ProductPublic } from "../../core/products.js";
import { errorResponse, wireError } from "../../core/errors.js";
import {
  entitledAccessCheck,
  usableLicensedDevice,
  type EntitledSelector,
} from "../../core/entitledAccess.js";
import {
  accessModeFor,
  artifactPolicy,
  type ReleaseConfigRow,
  type ReleaseKind,
} from "./config.js";
import { classifyChannel, parseManualChannels } from "./channels.js";

/** The version/channel/arch a request names. */
export interface ReleaseParams {
  /** Version/channel selector (dl/appcast/version); `latest` when omitted. */
  version?: string;
  /** Channel name for channelAppcast / channel selector. */
  channel?: string;
  /** Requested architecture (dl, and `?arch=` on the appcast). */
  arch?: "arm64" | "x86_64";
}

/** The raw selector string a surface resolves against, before classification. */
export function selectorFor(
  kind: ReleaseKind,
  params: ReleaseParams,
): string | undefined {
  return kind === "appcast" || kind === "channelAppcast"
    ? (params.channel ?? params.version ?? "stable")
    : (params.version ?? params.channel);
}

/**
 * Translate a release selector into the plain names Core's entitlement check evaluates.
 *
 * Channel classification is Release's model, so it happens here: `latest`/`stable`/a pinned
 * `X.Y.Z` are all the stable channel (the floor every grant holds), `pr-42` is additionally
 * checkable as the coarser `pr` the licence-side gate spells, and an operator's manual channel
 * is checked under its own name. An UNCLASSIFIABLE selector is passed through verbatim rather
 * than treated as stable — the surface will 404 it anyway, and quietly promoting an unknown
 * string to the one channel that is never checked is precisely the R3-01 mistake.
 *
 * `version` is populated only for a PINNED selector. A moving one (`latest`, `beta`) resolves to
 * a concrete release inside the surface handler, after this decision; blocking it here would
 * mean guessing.
 */
export function entitledSelectorFor(
  cfg: ReleaseConfigRow,
  kind: ReleaseKind,
  params: ReleaseParams,
): EntitledSelector {
  const raw = selectorFor(kind, params);
  const sel = classifyChannel(
    raw,
    parseManualChannels(cfg.manual_channels_json),
  );
  if (!sel) return { channel: raw ?? null, channelKind: null, version: null };
  const pinned =
    sel.kind === "stable" && sel.raw !== "latest" && sel.raw !== "stable";
  return {
    channel: sel.kind === "stable" ? "stable" : sel.raw,
    channelKind: sel.kind,
    version: pinned ? sel.raw.replace(/^v/, "") : null,
  };
}

/**
 * Enforce the effective access mode. Returns `null` when the request may proceed, or the
 * refusal to serve.
 */
export async function enforceReleaseAccess(
  req: Request,
  env: Env,
  db: Db,
  product: ProductPublic,
  cfg: ReleaseConfigRow,
  kind: ReleaseKind,
  params: ReleaseParams,
  now: number,
): Promise<Response | null> {
  const mode = accessModeFor(artifactPolicy(cfg), kind);
  if (mode === "public") return null;

  if (mode === "entitled") {
    const decision = await entitledAccessCheck(
      env,
      db,
      product,
      bearer(req),
      entitledSelectorFor(cfg, kind, params),
      now,
    );
    if (decision.ok) return null;
    if (decision.code === "version_blocked") {
      return wireError(403, "version_blocked", {
        allowedRange: decision.allowedRange,
      });
    }
    if (decision.code === "channel_not_allowed") {
      return wireError(403, "channel_not_allowed");
    }
    return wireError(401, "unauthorized");
  }

  const valid = await usableLicensedDevice(env, db, product, bearer(req), now);
  if ("error" in valid) {
    return errorResponse(
      401,
      "download_auth_required",
      "a valid license is required to download this release artifact",
    );
  }
  return null;
}
