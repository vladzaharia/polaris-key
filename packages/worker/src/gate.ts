// Version + channel gating. Ported from djdl's license.ts/licensing.ts. The per-license
// app.min/maxVersion window is intersected with the product's global compat window
// (tighter wins); pre-release channels (staging/pr) require the `channels` entitlement.
// Dev builds (0.0.0-dev+…) bypass all gating so local dev is never blocked.

import type { AllowedRange, BlockReason, ManagedEntry } from "@polaris-key/protocol";

export type ReleaseChannel = "stable" | "staging" | "pr" | "dev";

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export function parseSemver(v: string): ParsedSemver | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+[0-9A-Za-z-.]+)?$/);
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
  if (/^0\.0\.0-pr\d+/.test(version)) return "pr";
  return "stable";
}

export function isDevBuild(version: string): boolean {
  return version.startsWith("0.0.0-dev");
}

function strEnt(e: ManagedEntry | undefined): string | undefined {
  return e && typeof e.value === "string" ? e.value : undefined;
}

function arrEnt(e: ManagedEntry | undefined): string[] | undefined {
  return e && Array.isArray(e.value) ? (e.value.filter((v) => typeof v === "string") as string[]) : undefined;
}

/** The tighter (higher) of two minimums. */
function tighterMin(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return compareSemver(a, b) >= 0 ? a : b;
}

/** The tighter (lower) of two maximums. */
function tighterMax(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return compareSemver(a, b) <= 0 ? a : b;
}

function normalizeChannel(header: string): ReleaseChannel {
  if (header === "staging") return "staging";
  if (header === "pr" || /^pr-?\d*/.test(header)) return "pr";
  if (header === "dev") return "dev";
  return "stable";
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
}

/** Enforce the version window + channel entitlement for a build. */
export function checkBuildGate(input: GateInput): GateResult {
  const { version, entitlements } = input;
  if (isDevBuild(version)) return { ok: true };

  const min = tighterMin(input.compatMin, strEnt(entitlements["app.minVersion"]));
  const max = tighterMax(input.compatMax, strEnt(entitlements["app.maxVersion"]));
  const allowedRange: AllowedRange = {};
  if (min) allowedRange.min = min;
  if (max) allowedRange.max = max;

  if (min && compareSemver(version, min) < 0) {
    return { ok: false, reason: "version-too-old", allowedRange };
  }
  if (max && compareSemver(version, max) > 0) {
    return { ok: false, reason: "version-too-new", allowedRange };
  }

  const channel = normalizeChannel(input.channelHeader ?? channelForVersion(version));
  if (channel !== "stable" && channel !== "dev") {
    const allowed = arrEnt(entitlements["channels"]) ?? ["stable"];
    if (!allowed.includes(channel)) return { ok: false, reason: "channel-not-entitled" };
  }
  return { ok: true };
}
