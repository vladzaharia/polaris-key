/**
 * Versions, one rule (components.md §3.3 `VersionInput`): the same `SEMVER_RE` the Worker's admin
 * handlers check version bounds with (`@polaris-key/manifest`, `W/admin/lib/writeChecks.ts`), so
 * the console never accepts a value the server refuses, or refuses one it accepts.
 *
 * `compareVersions` orders by SemVer 2.0 precedence (build metadata ignored); the License pages
 * check their version windows with it through `versionRangeError` (LIC-9: the old dotted copies
 * passed `1.2.0-beta` against `1.0`). `compareDottedVersion` keeps the legacy contract (dotted
 * numerics, 0 when either side does not parse) for any caller that still wants it.
 */

import { SEMVER_RE } from "@polaris-key/manifest";

export { SEMVER_RE };

/** Is `value` a version the server accepts as a bound (`MAJOR.MINOR.PATCH[-pre][+build]`)? */
export function isValidVersion(value: string): boolean {
  return SEMVER_RE.test(value);
}

interface Parsed {
  core: [number, number, number];
  pre: string[];
}

function parse(value: string): Parsed | null {
  if (!SEMVER_RE.test(value)) return null;
  const noBuild = value.split("+")[0]!;
  const dash = noBuild.indexOf("-");
  const core = (dash === -1 ? noBuild : noBuild.slice(0, dash))
    .split(".")
    .map(Number) as [number, number, number];
  const pre = dash === -1 ? [] : noBuild.slice(dash + 1).split(".");
  return { core, pre };
}

function comparePre(a: string[], b: string[]): number {
  // A version without a pre-release ranks above one with it.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return Math.sign(d);
    } else if (xn) return -1;
    else if (yn) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * SemVer precedence: negative when `a < b`, positive when `a > b`, 0 when equal. `null` when
 * either side is not a valid version.
 */
export function compareVersions(a: string, b: string): number | null {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    const d = x.core[i]! - y.core[i]!;
    if (d !== 0) return Math.sign(d);
  }
  return comparePre(x.pre, y.pre);
}

/**
 * The legacy dotted comparison (`1.2` vs `1.10.0`): numeric parts compared left to right, missing
 * parts read as 0, and 0 when either side is not purely dotted numerics.
 */
export function compareDottedVersion(a: string, b: string): number {
  const p = (value: string): number[] | null =>
    value && /^\d+(?:\.\d+)*$/.test(value)
      ? value.split(".").map(Number)
      : null;
  const left = p(a);
  const right = p(b);
  if (!left || !right) return 0;
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i++) {
    const d = (left[i] ?? 0) - (right[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The validation message for a min/max version pair, or `null` when both are fine. Blank means
 * "no bound".
 */
export function versionRangeError(
  min: string,
  max: string,
): { field: "min" | "max"; message: string } | null {
  const lo = min.trim();
  const hi = max.trim();
  if (lo && !isValidVersion(lo))
    return { field: "min", message: "Use a version such as 2.0.0." };
  if (hi && !isValidVersion(hi))
    return { field: "max", message: "Use a version such as 2.0.0." };
  if (lo && hi && (compareVersions(lo, hi) ?? 0) > 0)
    return {
      field: "max",
      message:
        "The maximum version must be the same as or higher than the minimum.",
    };
  return null;
}
