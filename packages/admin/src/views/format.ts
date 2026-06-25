/**
 * Small presentational formatters shared by the views built on the foundation. Timestamps in
 * the API are epoch *seconds*; these helpers render a compact relative label plus an absolute
 * ISO-ish string for tooltips/`title` attributes so dates stay accessible and unambiguous.
 */

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 60 * 60 * 24 * 365],
  ["month", 60 * 60 * 24 * 30],
  ["week", 60 * 60 * 24 * 7],
  ["day", 60 * 60 * 24],
  ["hour", 60 * 60],
  ["minute", 60],
  ["second", 1],
];

/** A short relative label for an epoch-seconds timestamp, e.g. "3 hours ago" / "in 2 days". */
export function relativeTime(
  epochSeconds: number,
  now: number = Date.now(),
): string {
  const deltaSeconds = epochSeconds - Math.floor(now / 1000);
  const abs = Math.abs(deltaSeconds);
  if (abs < 5) return "just now";
  for (const [unit, secs] of UNITS) {
    if (abs >= secs)
      return RELATIVE.format(Math.round(deltaSeconds / secs), unit);
  }
  return "just now";
}

/** A full, unambiguous local timestamp for a `title`/tooltip on an epoch-seconds value. */
export function absoluteTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString();
}
