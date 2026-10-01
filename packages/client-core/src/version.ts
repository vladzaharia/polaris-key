// Version ordering under a product's scheme — plans/P3-01.md §2.8 "Versions" (WIRE-CONTRACT-V4
// §11). P2-05's rules made exact: every comparison is on digit strings, so no SDK loses
// precision past 2^53, and every grammar matches the whole string with ASCII classes (a
// trailing line terminator does not parse). `update-matrix.json#/versionCases` pins it, and
// the Worker orders releases with this same function (P3-03).

import type { FeedVersionScheme } from "@polaris-key/protocol/update";

/** SemVer 2.0's own grammar, with ASCII classes: no empty identifier, no leading zero in a
 *  numeric prerelease identifier. JavaScript with no flags matches the whole string. */
const SEMVER_RE =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** P2-04's `FOUR_PART_RE`. */
const FOUR_PART_RE =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

const DIGITS_RE = /^[0-9]+$/;

export type ParsedVersion =
  | {
      scheme: "semver" | "semver+build";
      core: [string, string, string];
      prerelease: string[] | null;
      build: string | null;
    }
  | { scheme: "4part"; core: [string, string, string, string] };

/** Parse `v` under `scheme`, or null when it does not parse (or the scheme is unknown). */
export function parseVersion(scheme: string, v: string): ParsedVersion | null {
  if (typeof v !== "string") return null;
  if (scheme === "semver" || scheme === "semver+build") {
    const m = SEMVER_RE.exec(v);
    if (!m) return null;
    return {
      scheme,
      core: [m[1]!, m[2]!, m[3]!],
      prerelease: m[4] === undefined ? null : m[4].split("."),
      build: m[5] ?? null,
    };
  }
  if (scheme === "4part") {
    const m = FOUR_PART_RE.exec(v);
    if (!m) return null;
    return { scheme, core: [m[1]!, m[2]!, m[3]!, m[4]!] };
  }
  return null;
}

/** Compare two unbounded non-negative integers given as ASCII digit strings. */
function compareDigits(a: string, b: string): -1 | 0 | 1 {
  const x = a.replace(/^0+(?=.)/, "");
  const y = b.replace(/^0+(?=.)/, "");
  if (x.length !== y.length) return x.length < y.length ? -1 : 1;
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

function compareAscii(a: string, b: string): -1 | 0 | 1 {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** SemVer 2.0 §11 precedence over two parsed semver versions; build metadata is ignored. */
function comparePrecedence(
  a: { core: string[]; prerelease: string[] | null },
  b: { core: string[]; prerelease: string[] | null },
): -1 | 0 | 1 {
  for (let k = 0; k < 3; k++) {
    const c = compareDigits(a.core[k]!, b.core[k]!);
    if (c !== 0) return c;
  }
  if (a.prerelease === null && b.prerelease === null) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  const n = Math.min(a.prerelease.length, b.prerelease.length);
  for (let k = 0; k < n; k++) {
    const x = a.prerelease[k]!;
    const y = b.prerelease[k]!;
    const xn = DIGITS_RE.test(x);
    const yn = DIGITS_RE.test(y);
    let c: -1 | 0 | 1;
    if (xn && yn) c = compareDigits(x, y);
    else if (xn) c = -1;
    else if (yn) c = 1;
    else c = compareAscii(x, y);
    if (c !== 0) return c;
  }
  // A shorter list that is a prefix of a longer one is lower.
  const la = a.prerelease.length;
  const lb = b.prerelease.length;
  return la === lb ? 0 : la < lb ? -1 : 1;
}

/**
 * `cmp(a, b)` under `scheme`: -1, 0 or 1, or null when either side does not parse.
 * `semver+build` breaks a precedence tie with build metadata that is ASCII digits only,
 * compared as an unbounded integer; a version without such metadata is lower than one with it.
 */
export function compareVersions(
  scheme: FeedVersionScheme | string,
  a: string,
  b: string,
): -1 | 0 | 1 | null {
  const pa = parseVersion(scheme, a);
  const pb = parseVersion(scheme, b);
  if (!pa || !pb) return null;
  if (pa.scheme === "4part" || pb.scheme === "4part") {
    for (let k = 0; k < 4; k++) {
      const c = compareDigits(pa.core[k]!, pb.core[k]!);
      if (c !== 0) return c;
    }
    return 0;
  }
  const c = comparePrecedence(pa, pb);
  if (c !== 0 || scheme !== "semver+build") return c;
  const na = pa.build !== null && DIGITS_RE.test(pa.build) ? pa.build : null;
  const nb = pb.build !== null && DIGITS_RE.test(pb.build) ? pb.build : null;
  if (na === null && nb === null) return 0;
  if (na === null) return -1;
  if (nb === null) return 1;
  return compareDigits(na, nb);
}
