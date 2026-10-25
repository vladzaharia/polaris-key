/**
 * The pure path matcher the route tables share: the admin table (`console/routeMatch.ts`) and the
 * service tables (`core/http/routes.ts`). No request, no I/O.
 *
 * A path is a list of segments, with `:name` for one segment and a trailing `**` for any remaining
 * segments (zero or more). When several patterns match a request, the most specific wins: at the
 * first segment where they differ, a literal beats a parameter and a parameter beats `**`.
 */

export interface MatchedPath {
  /** `:name` segments, by name. */
  params: Readonly<Record<string, string>>;
  /** The segments a trailing `/**` covered (empty when none, or when the pattern has none). */
  rest: readonly string[];
}

export function patternSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** Match one pattern against request segments, or `null`. */
export function matchPath(
  pattern: string,
  segments: readonly string[],
): MatchedPath | null {
  const pat = patternSegments(pattern);
  const params: Record<string, string> = {};
  for (let i = 0; i < pat.length; i++) {
    const p = pat[i]!;
    if (p === "**") {
      if (i !== pat.length - 1) return null;
      return { params, rest: segments.slice(i) };
    }
    const s = segments[i];
    if (s === undefined) return null;
    if (p.startsWith(":")) params[p.slice(1)] = s;
    else if (p !== s) return null;
  }
  return segments.length === pat.length ? { params, rest: [] } : null;
}

/**
 * Segment rank for specificity: literal 0, parameter 1, `**` 2, absent 3. Note `**` beats an
 * absent segment, so `x/**` outranks a plain `x` row for `/x` (both match). A table with both
 * rows must give `x/**` an `accept` guard (`segments.length > 1`); see `PORTAL_ROUTES`.
 */
function rank(seg: string | undefined): number {
  if (seg === undefined) return 3;
  if (seg === "**") return 2;
  return seg.startsWith(":") ? 1 : 0;
}

/** Negative when `a` is more specific than `b`. */
export function compareSpecificity(a: string, b: string): number {
  const pa = patternSegments(a);
  const pb = patternSegments(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = rank(pa[i]) - rank(pb[i]);
    if (d !== 0) return d;
  }
  return 0;
}
