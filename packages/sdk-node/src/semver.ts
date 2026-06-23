// Client-side semver + channel helpers (mirrors the worker's gate.ts). Pinned by the
// conformance corpus so all SDKs agree.

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

export function channelForVersion(version: string): "stable" | "staging" | "pr" | "dev" {
  if (version.startsWith("0.0.0-dev")) return "dev";
  if (version.startsWith("0.0.0-staging")) return "staging";
  if (/^0\.0\.0-pr\d+/.test(version)) return "pr";
  return "stable";
}

export function isDevBuild(version: string): boolean {
  return version.startsWith("0.0.0-dev");
}
