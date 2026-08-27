/// <reference types="@cloudflare/workers-types" />

/**
 * Update's eligibility rules — which build this caller is allowed to be OFFERED (D-13).
 *
 * ── WHY THIS IS A SEPARATE CONCERN FROM ACCESS ──────────────────────────────────────────────
 *
 * `services/release/access.ts` answers "may you read this surface at all". Eligibility answers
 * the narrower question the FEED asks: given that you may read it, which channel and which
 * architecture is this request actually for. Both feed into the same decision, and under the
 * `entitled` mode the answer to the second is an input to the first — the channel that gets
 * checked against the grant is the channel this file resolves.
 *
 * Keeping it here rather than in the router is what makes the canonical route and its permanent
 * alias provably identical: both hand the same raw segments to `updateParams`, so there is one
 * place where `/update/beta/appcast.xml?arch=x86_64` becomes `{channel:"beta", arch:"x86_64"}`.
 *
 * ── THE R3 GAP ──────────────────────────────────────────────────────────────────────────────
 *
 * R3 recorded that a stable-only licence could fetch the beta appcast and the beta DMG behind
 * it. The enforcement lives in Core (`core/entitledAccess.ts`) because Release and Update may
 * not import License; what this file contributes is the SELECTOR that check evaluates — without
 * it the entitled mode would be asked about a request it could not describe.
 */

import type { UpdateArch } from "@polaris-key/protocol/update";
import type { ReleaseParams } from "../release/gateway.js";
import { appcastArch, type UpdateSurfaceKind } from "./feed.js";

/**
 * The parameters an Update request resolves to.
 *
 * `channel` is only ever a path segment the core router matched against `[a-z0-9-]`, so it
 * cannot carry a traversal or a separator; `arch` is a query hint, normalised to one of two
 * values by `appcastArch`. Everything downstream — asset matching, the entitled check, the
 * cache key — reads these, never the raw request.
 */
export function updateParams(
  req: Request,
  kind: UpdateSurfaceKind,
  channel?: string,
): ReleaseParams {
  if (kind === "version") return {};
  const arch: UpdateArch = appcastArch(req);
  return kind === "channelAppcast" && channel ? { channel, arch } : { arch };
}
