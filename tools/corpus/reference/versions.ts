// Reference: version parsing and comparison (plans/P3-01.md §2.8).
//
// The generator's independent reference implementation, restated from the spec rather than
// taken from client-core or an SDK: the family modules recompute every verdict through it.

// ── Versions (plans/P3-01.md §2.8), the generator's own comparator ───────────────────────────

const REF_SEMVER_RE =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const REF_FOUR_PART_RE = /^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){3}$/;
export const REF_SCHEMES = ["semver", "semver+build", "4part"] as const;

export function refParseVersion(
  scheme: string,
  v: unknown,
): { core: string[]; pre: string[] | null; build: string | null } | null {
  if (typeof v !== "string") return null;
  if (scheme === "4part") {
    if (!REF_FOUR_PART_RE.test(v)) return null;
    return { core: v.split("."), pre: null, build: null };
  }
  if (scheme !== "semver" && scheme !== "semver+build") return null;
  const m = REF_SEMVER_RE.exec(v);
  if (!m) return null;
  return {
    core: [m[1]!, m[2]!, m[3]!],
    pre: m[4] === undefined ? null : m[4].split("."),
    build: m[5] ?? null,
  };
}

/** Unbounded integers as digit strings: strip leading zeros, then length, then ASCII. */
function refCmpDigits(a: string, b: string): number {
  const x = a.replace(/^0+(?=.)/, "");
  const y = b.replace(/^0+(?=.)/, "");
  if (x.length !== y.length) return x.length < y.length ? -1 : 1;
  return x === y ? 0 : x < y ? -1 : 1;
}

export function refCompareVersions(
  scheme: string,
  a: unknown,
  b: unknown,
): number | null {
  const pa = refParseVersion(scheme, a);
  const pb = refParseVersion(scheme, b);
  if (!pa || !pb) return null;
  for (let k = 0; k < pa.core.length; k++) {
    const c = refCmpDigits(pa.core[k]!, pb.core[k]!);
    if (c !== 0) return c;
  }
  if (scheme === "4part") return 0;
  let c = 0;
  if (pa.pre === null && pb.pre !== null) c = 1;
  else if (pa.pre !== null && pb.pre === null) c = -1;
  else if (pa.pre !== null && pb.pre !== null) {
    const n = Math.min(pa.pre.length, pb.pre.length);
    for (let k = 0; k < n && c === 0; k++) {
      const x = pa.pre[k]!;
      const y = pb.pre[k]!;
      const xn = /^[0-9]+$/.test(x);
      const yn = /^[0-9]+$/.test(y);
      if (xn && yn) c = refCmpDigits(x, y);
      else if (xn !== yn) c = xn ? -1 : 1;
      else c = x === y ? 0 : x < y ? -1 : 1;
    }
    if (c === 0 && pa.pre.length !== pb.pre.length)
      c = pa.pre.length < pb.pre.length ? -1 : 1;
  }
  if (c !== 0 || scheme !== "semver+build") return c;
  const na = pa.build !== null && /^[0-9]+$/.test(pa.build) ? pa.build : null;
  const nb = pb.build !== null && /^[0-9]+$/.test(pb.build) ? pb.build : null;
  if (na === null && nb === null) return 0;
  if (na === null) return -1;
  if (nb === null) return 1;
  return refCmpDigits(na, nb);
}
