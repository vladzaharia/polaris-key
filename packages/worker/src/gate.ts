// Version + channel gating. Ported from djdl's license.ts/licensing.ts. The per-license
// app.min/maxVersion window is intersected with the product's global compat window
// (tighter wins); pre-release channels (staging/pr/dev) require the `channels` entitlement.
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
} from "@plrs/protocol";

export type ReleaseChannel = "stable" | "staging" | "pr" | "dev";

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export function parseSemver(v: string): ParsedSemver | null {
  const m = v.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+[0-9A-Za-z-.]+)?$/,
  );
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

/** Semver compare. Returns -1, 0, 1. Unparseable inputs compare equal (0). */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (const k of ["major", "minor", "patch"] as const) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  if (pa.prerelease.length === 0 && pb.prerelease.length > 0) return 1;
  if (pa.prerelease.length > 0 && pb.prerelease.length === 0) return -1;
  const n = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < n; i++) {
    const x = pa.prerelease[i];
    const y = pb.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

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

function strEnt(e: ManagedEntry | undefined): string | undefined {
  return e && typeof e.value === "string" ? e.value : undefined;
}

function arrEnt(e: ManagedEntry | undefined): string[] | undefined {
  return e && Array.isArray(e.value)
    ? (e.value.filter((v) => typeof v === "string") as string[])
    : undefined;
}

/** The tighter (higher) of two minimums. */
export function tighterMin(
  a: string | undefined,
  b: string | undefined,
): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return compareSemver(a, b) >= 0 ? a : b;
}

/** The tighter (lower) of two maximums. */
export function tighterMax(
  a: string | undefined,
  b: string | undefined,
): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return compareSemver(a, b) <= 0 ? a : b;
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

/** Which channels the license is entitled to. Absent === stable only. */
function entitledChannels(
  entitlements: Record<string, ManagedEntry>,
): string[] {
  return arrEnt(entitlements["channels"]) ?? ["stable"];
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

  const min = tighterMin(
    input.compatMin,
    strEnt(entitlements["app.minVersion"]),
  );
  const max = tighterMax(
    input.compatMax,
    strEnt(entitlements["app.maxVersion"]),
  );
  const allowedRange: AllowedRange = {};
  if (min) allowedRange.min = min;
  if (max) allowedRange.max = max;

  if (min && compareSemver(version, min) < 0) {
    return { ok: false, reason: "version-too-old", allowedRange };
  }
  if (max && compareSemver(version, max) > 0) {
    return { ok: false, reason: "version-too-new", allowedRange };
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
