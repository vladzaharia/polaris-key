// Version + channel gating. Ported from djdl's license.ts/licensing.ts. The per-license
// app.min/maxVersion window is intersected with the product's global compat window
// (tighter wins); pre-release channels (staging/pr/dev) require the `channels` entitlement.
//
// ── WHY THIS IS IN CORE ──────────────────────────────────────────────────────────────────────
//
// D-20 makes channel/version enforcement a LICENSE concern, and the licence document is where a
// blocked build is refused (`services/license/document.ts`). But spec §3.2 names a second
// enforcement point in the same breath — identity's `GET /<p>/identity/session`, which mints its
// own document for a browser and must refuse exactly the builds `/license/document` refuses. Two
// services asking the same question of the same rows may not import each other
// (`test/boundaries.test.ts`), so the predicate lives here, once, beside the entitlement algebra
// it is built from. `services/license/gate.ts` re-exports it, so every existing importer of that
// module — and the `src/gate.ts` compat shim — is unchanged.
//
// R3-01 — this module is fed `X-PKey-Version` / `X-PKey-Channel`, i.e. two strings the caller
// chooses. That is tolerable for the CLIENT-side gate an SDK runs against its own compiled-in
// version; it is not tolerable server-side, where the same values arrive over the wire. So:
//
//   * the dev-build bypass is OFF unless the license is positively entitled to it,
//   * an unrecognised channel header no longer silently normalises to `stable`, and
//   * the declared channel can only ever be TIGHTENED relative to the one the version implies,
//     so a `0.0.0-pr-42` build cannot present itself as `stable` to skip the entitlement check.

import type {
  AllowedRange,
  BlockReason,
  ManagedEntry,
} from "@polaris-key/protocol";
// The semver algebra and the two entitlement readers live next door in `core/entitlements.ts`:
// Release and Update need exactly that computation for the `entitled` access mode (D-13). They
// are re-exported below so every importer of this module (and of the two shims that point at
// it) sees one surface.
import {
  compareSemver,
  entitledChannels,
  parseSemver,
  tighterMax,
  tighterMin,
  versionInWindow,
  versionWindow,
} from "./entitlements.js";

export {
  compareSemver,
  parseSemver,
  tighterMax,
  tighterMin,
} from "./entitlements.js";

export type ReleaseChannel = "stable" | "staging" | "pr" | "dev";

export function channelForVersion(version: string): ReleaseChannel {
  if (version.startsWith("0.0.0-dev")) return "dev";
  if (version.startsWith("0.0.0-staging")) return "staging";
  // R3-07 — the hyphen is OPTIONAL, matching `sdks/*` (`/^0\.0\.0-pr-?\d+/`, pinned by
  // `sdk-node/test/semver.test.ts:92`). The Worker previously required a digit immediately
  // after `pr`, so `0.0.0-pr-42` — the form the SDKs actually emit — was `pr` to the client
  // and `stable` to the server, and the server therefore never ran the channel entitlement
  // check on a real PR build. A digit is still required, so `0.0.0-prfoo` stays `stable`.
  if (/^0\.0\.0-pr-?\d+/.test(version)) return "pr";
  return "stable";
}

export function isDevBuild(version: string): boolean {
  return version.startsWith("0.0.0-dev");
}

/**
 * Map a client-declared channel header onto a known channel, or `null` when it names none.
 *
 * R3-13 — the old pattern `^pr-?\d` followed by a star was unanchored at BOTH ends and allowed
 * zero digits, so it matched any header merely *beginning* with `pr`: `prod`, `preview` were
 * all classified as the `pr` channel and refused with `channel-not-entitled`. It is now
 * anchored and requires at least one digit.
 *
 * Returning `null` rather than `"stable"` for an unrecognised value is the other half: mapping
 * the unknown onto the one channel that is never entitlement-checked meant `staging-2`,
 * `STAGING` and `beta` all skipped the check outright (R3-01). The caller decides what an
 * unknown declaration means; it no longer means "trusted".
 */
function normalizeChannel(header: string): ReleaseChannel | null {
  if (header === "stable") return "stable";
  if (header === "staging") return "staging";
  if (header === "pr" || /^pr-?\d+$/.test(header)) return "pr";
  if (header === "dev") return "dev";
  return null;
}

export interface GateResult {
  ok: boolean;
  reason?: BlockReason;
  allowedRange?: AllowedRange;
}

export interface GateInput {
  version: string;
  channelHeader?: string;
  entitlements: Record<string, ManagedEntry>;
  compatMin: string;
  compatMax: string;
  /**
   * Per-product override for the dev-build bypass (R3-01). Left undefined, the bypass is
   * governed by the `dev` channel entitlement below and is therefore OFF by default. There is
   * no `products.allow_dev_builds` column today — see the R3 Remediation notes.
   */
  allowDevBuilds?: boolean;
}

/** Enforce the version window + channel entitlement for a build. */
export function checkBuildGate(input: GateInput): GateResult {
  const { version, entitlements } = input;

  // R3-01 — the dev bypass skipped BOTH the version window and the channel entitlement for
  // any version starting `0.0.0-dev`, which is a value the caller types into a header. It is
  // now opt-in: either the product sets `allowDevBuilds`, or the license is entitled to the
  // `dev` channel exactly as it would be to `staging` or `pr`. Both default to OFF, so the
  // Python CLIs that default `--version` to `0.0.0-dev` (R4-07) no longer ship a bypass.
  const devAllowed =
    input.allowDevBuilds ?? entitledChannels(entitlements).includes("dev");
  if (isDevBuild(version) && devAllowed) return { ok: true };

  const allowedRange: AllowedRange = versionWindow(
    entitlements,
    input.compatMin,
    input.compatMax,
  );
  if (!versionInWindow(version, allowedRange)) {
    const tooOld =
      allowedRange.min !== undefined &&
      compareSemver(version, allowedRange.min) < 0;
    return {
      ok: false,
      reason: tooOld ? "version-too-old" : "version-too-new",
      allowedRange,
    };
  }

  // The channel the BUILD implies always applies. A declared header can only add a second
  // channel to check, never replace the first: previously `channelHeader` won outright, so a
  // pre-release build simply declared `stable` (or any unrecognised word, which normalised to
  // `stable`) and the entitlement was never evaluated. An unrecognised declaration is now
  // itself a refusal rather than a free pass.
  const declared = input.channelHeader;
  const fromHeader = declared === undefined ? null : normalizeChannel(declared);
  if (declared !== undefined && fromHeader === null) {
    return { ok: false, reason: "channel-not-entitled" };
  }

  const allowed = entitledChannels(entitlements);
  for (const channel of new Set([channelForVersion(version), fromHeader])) {
    // `stable` is the floor every license holds; `dev` is checked like any other channel now
    // that it no longer short-circuits above.
    if (channel === null || channel === "stable") continue;
    if (!allowed.includes(channel))
      return { ok: false, reason: "channel-not-entitled" };
  }
  return { ok: true };
}
