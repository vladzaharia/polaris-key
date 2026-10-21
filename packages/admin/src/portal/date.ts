/**
 * The one customer-facing date format (lead decision 2026-10-21): "Sep 14, 2026", month short, day
 * numeric, year numeric, US order. The portal is English today, so the locale defaults to `en-US`;
 * pass a catalog locale and `Intl` writes that locale's form of the same fields ("2026年9月14日").
 * Every portal date goes through here; `test/portalDates.test.ts` fails on any other.
 */

export interface DayOptions {
  /** A catalog locale; `en-US` by default. */
  locale?: string;
  /** Read the instant as a UTC calendar day (an expiry, a birth date) instead of the viewer's. */
  utc?: boolean;
}

/** "Sep 14, 2026", or "Sep 14" without the year. `epochSeconds` is a Unix time in seconds. */
export function formatDay(
  epochSeconds: number,
  withYear = true,
  opts: DayOptions = {},
): string {
  return new Intl.DateTimeFormat(opts.locale ?? "en-US", {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
    ...(opts.utc ? { timeZone: "UTC" } : {}),
  }).format(new Date(epochSeconds * 1000));
}

/** The day and the time of day: "Sep 14, 2026, 3:05 PM". */
export function formatDayTime(
  epochSeconds: number,
  opts: DayOptions = {},
): string {
  return new Intl.DateTimeFormat(opts.locale ?? "en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(opts.utc ? { timeZone: "UTC" } : {}),
  }).format(new Date(epochSeconds * 1000));
}
