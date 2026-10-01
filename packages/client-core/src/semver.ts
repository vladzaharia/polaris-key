// Client-side semver + channel helpers. `channelForVersion` matches the Worker's function of
// the same name (`packages/worker/src/core/channels.ts`, WIRE-CONTRACT-V3 §5.1 rule 2); only the
// Worker narrows a PR build to `pr-<n>`. Pinned by the conformance corpus so all SDKs agree.

import type { BuildChannel } from "@polaris-key/protocol";

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

/**
 * The channel family a build's version implies, which an SDK sends as its default
 * `X-PKey-Channel`: `dev` for `0.0.0-dev*`, `beta` for `0.0.0-beta*` and the legacy
 * `0.0.0-staging*`, `pr` for `0.0.0-pr-<n>` (hyphen optional), `stable` for anything else.
 */
export function channelForVersion(version: string): BuildChannel {
  if (version.startsWith("0.0.0-dev")) return "dev";
  if (version.startsWith("0.0.0-beta") || version.startsWith("0.0.0-staging"))
    return "beta";
  if (/^0\.0\.0-pr-?\d+/.test(version)) return "pr";
  return "stable";
}

export function isDevBuild(version: string): boolean {
  return version.startsWith("0.0.0-dev");
}
