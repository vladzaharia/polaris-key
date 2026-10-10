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
 *                  in its entitled set, and a pinned version — or the stored version of a
 *                  fixed release (`fixedVersion`) — must sit inside its window.
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

import { CHANNEL_BETA, CHANNEL_STABLE } from "@polaris-key/protocol";
import type { ReleaseAccess } from "@polaris-key/protocol/release";
import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import { bearer } from "../../http.js";
import type { ProductPublic } from "../../core/products.js";
import {
  accessRefusal,
  fixedReleaseSelector,
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
  /**
   * The STORED version of the one fixed release a route serves (`/release/files`, and each
   * release `/release/blobs` checks). Never a selector: it is checked as a pinned version
   * whatever it spells. A release synced from the tag `latest`, `stable`, `beta`, `pr-5` or a
   * manual channel's name stores that word as its version, and reading it as a route selector
   * would classify it as a MOVING channel, which has no window check — a capped, stable-only
   * licence then fetched a rolling prerelease's bytes (P2-05 security round). When set, it
   * overrides `version` and `channel` for the `entitled` decision. Only server code sets it;
   * no route copies a request value into it.
   */
  fixedVersion?: string;
}

/** The raw selector string a surface resolves against, before classification. */
export function selectorFor(
  kind: ReleaseKind,
  params: ReleaseParams,
): string | undefined {
  return kind === "appcast" ||
    kind === "channelAppcast" ||
    kind === "winsparkle" ||
    kind === "velopack" ||
    kind === "appinstaller" ||
    kind === "zsync"
    ? (params.channel ?? params.version ?? "stable")
    : (params.version ?? params.channel);
}

/**
 * Translate a release selector into the canonical channel name Core's entitlement check
 * evaluates (WIRE-CONTRACT-V3 §5.1).
 *
 * Channel classification is Release's model, so it happens here: `latest`/`stable`/a pinned
 * `X.Y.Z` are all the stable channel (the floor every grant holds); a `beta` or `staging`
 * selector is the canonical `beta` (unless the product declares a manual `staging`, which is
 * then checked under its own name); `pr-42` is checked as `pr-42`, which a `pr` grant also
 * covers; and an operator's manual channel is checked under its own name. An UNCLASSIFIABLE
 * selector is passed through verbatim rather than treated as stable — the surface will 404 it
 * anyway, and quietly promoting an unknown string to the one channel that is never checked is
 * precisely the R3-01 mistake.
 *
 * `version` is populated only for a PINNED selector. A moving one (`latest`, `beta`) resolves to
 * a concrete release inside the surface handler, after this decision; blocking it here would
 * mean guessing.
 *
 * A release's STORED version (`params.fixedVersion`) is never fed through this classification:
 * it is always pinned, so a release tagged `latest` cannot pass as the moving stable channel.
 */
export function entitledSelectorFor(
  cfg: ReleaseConfigRow,
  kind: ReleaseKind,
  params: ReleaseParams,
): EntitledSelector {
  // A fixed release is pinned, never classified: see `ReleaseParams.fixedVersion`. Pinned means
  // what it means for a pinned selector — the stable channel, the version window-checked — and
  // `accessRefusal` refuses it when the window is bounded and cannot order it.
  if (params.fixedVersion !== undefined)
    return fixedReleaseSelector(params.fixedVersion);
  const raw = selectorFor(kind, params);
  const sel = classifyChannel(
    raw,
    parseManualChannels(cfg.manual_channels_json),
  );
  if (!sel) return { channel: raw ?? null, version: null };
  const pinned =
    sel.kind === "stable" && sel.raw !== "latest" && sel.raw !== "stable";
  const channel =
    sel.kind === "stable"
      ? CHANNEL_STABLE
      : sel.kind === "beta"
        ? CHANNEL_BETA
        : sel.raw;
  return {
    channel,
    version: pinned ? sel.raw.replace(/^v/, "") : null,
  };
}

/**
 * Enforce the effective access mode. Returns `null` when the request may proceed, or the
 * refusal to serve. The refusal itself is Core's (`accessRefusal`), shared with Distribution's
 * byte routes, so a mode answers the same on every surface.
 *
 * `artifactsAccess` is the ARTIFACTS mode, which is no longer Release's to answer (P2b-04): it is
 * Distribution's delivery access, read by the caller through `delivery.accessMode()` and passed
 * in. A surface governed by it with none supplied fails closed to `entitled`, the strictest mode.
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
  artifactsAccess?: ReleaseAccess,
): Promise<Response | null> {
  const mode = accessModeFor(artifactPolicy(cfg, artifactsAccess), kind);
  if (mode === "public") return null;
  const selector = entitledSelectorFor(cfg, kind, params);
  // A fixed release's version is checked even when it is empty, which `selector.version` alone
  // would read as "unpinned".
  const pinned = params.fixedVersion !== undefined || !!selector.version;
  return accessRefusal(
    env,
    db,
    product,
    bearer(req),
    mode,
    selector,
    pinned,
    now,
  );
}
