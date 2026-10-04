/**
 * The console's one formatter (docs/design/ADMIN.md §5.9), replacing the five local copies.
 *
 * Times are **epoch milliseconds** here. Most API fields are epoch seconds: convert at the edge
 * with `fromSeconds`. Every function takes an optional `locale` (default: the browser's) and,
 * where a zone matters, an optional `timeZone` (default: the operator's), so tests can pin both.
 *
 * | Context            | Function             | Example                               |
 * | ------------------ | -------------------- | ------------------------------------- |
 * | tables             | `formatTableTime`    | "3 hr. ago" under 7 days, else a date |
 * | detail pages       | `formatDetailTime`   | "3 Sep 2026, 14:05 CEST · 3 hr. ago"  |
 * | calendar dates     | `endOfLocalDay`      | the operator's local day, 23:59:59    |
 * | exports and copy   | `formatIso`          | ISO 8601 UTC                          |
 */

export interface FormatOptions {
  locale?: string;
  timeZone?: string;
}

/** Epoch seconds (the API's unit) → epoch milliseconds. */
export function fromSeconds(seconds: number): number {
  return seconds * 1000;
}

/** Epoch milliseconds → epoch seconds, rounded down (what the API accepts). */
export function toSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * DAY],
  ["month", 30 * DAY],
  ["week", WEEK],
  ["day", DAY],
  ["hour", HOUR],
  ["minute", MINUTE],
  ["second", SECOND],
];

/** "3 hr. ago", "in 2 days", "now". Compact (`short`) style, locale-aware. */
export function formatRelative(
  ms: number,
  now: number = Date.now(),
  opts: FormatOptions = {},
): string {
  const rtf = new Intl.RelativeTimeFormat(opts.locale, {
    numeric: "auto",
    style: "short",
  });
  const delta = ms - now;
  const abs = Math.abs(delta);
  if (abs < 5 * SECOND) return rtf.format(0, "second");
  for (const [unit, size] of UNITS) {
    if (abs >= size) return rtf.format(Math.round(delta / size), unit);
  }
  return rtf.format(0, "second");
}

/** A calendar date: "3 Sep 2026" (order per locale). */
export function formatDate(ms: number, opts: FormatOptions = {}): string {
  return new Intl.DateTimeFormat(opts.locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: opts.timeZone,
  }).format(ms);
}

/** Date and time with the zone always shown: "3 Sep 2026, 14:05 CEST". 12/24 h per locale. */
export function formatDateTime(ms: number, opts: FormatOptions = {}): string {
  return new Intl.DateTimeFormat(opts.locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: opts.timeZone,
  }).format(ms);
}

/** The short zone name at an instant ("CEST", "GMT+2"). */
export function zoneName(ms: number, opts: FormatOptions = {}): string {
  const part = new Intl.DateTimeFormat(opts.locale, {
    timeZoneName: "short",
    timeZone: opts.timeZone,
  })
    .formatToParts(ms)
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? "";
}

/** Tables: relative under 7 days ("3 hr. ago"), else the date ("3 Sep 2026"). */
export function formatTableTime(
  ms: number,
  now: number = Date.now(),
  opts: FormatOptions = {},
): string {
  return Math.abs(now - ms) < WEEK
    ? formatRelative(ms, now, opts)
    : formatDate(ms, opts);
}

/** Detail pages: "3 Sep 2026, 14:05 CEST · 3 hr. ago". */
export function formatDetailTime(
  ms: number,
  now: number = Date.now(),
  opts: FormatOptions = {},
): string {
  return `${formatDateTime(ms, opts)} · ${formatRelative(ms, now, opts)}`;
}

/** Exports and copy: ISO 8601 in UTC. */
export function formatIso(ms: number): string {
  return new Date(ms).toISOString();
}

// ── Calendar days (DateInput semantics, LIC-5) ─────────────────────────────────────────────────

/** Parse "YYYY-MM-DD"; `null` when malformed or not a real date. */
export function parseLocalDay(
  day: string,
): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  )
    return null;
  return { y, m, d };
}

/** The wall-clock parts of an instant in a zone. */
function partsIn(ms: number, timeZone?: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(ms);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return {
    y: get("year"),
    m: get("month"),
    d: get("day"),
    h: get("hour"),
    mi: get("minute"),
    s: get("second"),
  };
}

/** The zone's offset from UTC at an instant, in ms (local − UTC). */
function offsetAt(ms: number, timeZone?: string): number {
  const p = partsIn(ms, timeZone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The last second of a calendar day in the operator's zone (or `timeZone`), as epoch ms:
 * "2026-09-30" → 30 Sep 2026, 23:59:59 local. DST-safe (the offset is resolved at that instant).
 * `null` when the day is malformed.
 */
export function endOfLocalDay(
  day: string,
  opts: Pick<FormatOptions, "timeZone"> = {},
): number | null {
  const p = parseLocalDay(day);
  if (!p) return null;
  const wall = Date.UTC(p.y, p.m - 1, p.d, 23, 59, 59);
  // Two passes: the first guess's offset, then the offset at the corrected instant.
  let guess = wall - offsetAt(wall, opts.timeZone);
  guess = wall - offsetAt(guess, opts.timeZone);
  return guess;
}

/** The calendar day ("YYYY-MM-DD") an instant falls on in the operator's zone. */
export function localDayOf(
  ms: number,
  opts: Pick<FormatOptions, "timeZone"> = {},
): string {
  const p = partsIn(ms, opts.timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

// ── Durations ──────────────────────────────────────────────────────────────────────────────────

/** A span in its largest whole unit: "2 days", "5 hours", "30 seconds". */
export function formatSpan(ms: number, opts: FormatOptions = {}): string {
  const abs = Math.abs(ms);
  for (const [unit, size] of UNITS) {
    if (abs >= size || unit === "second") {
      const n = Math.round(abs / size);
      return new Intl.NumberFormat(opts.locale, {
        style: "unit",
        unit,
        unitDisplay: "long",
      }).format(n);
    }
  }
  return "";
}

/**
 * A duration phrase: `"until"` → "in 2 days" (a deadline ahead), `"for"` → "for 14 days" (a span).
 */
export function formatDuration(
  ms: number,
  mode: "until" | "for" = "for",
  opts: FormatOptions = {},
): string {
  const span = formatSpan(ms, opts);
  return mode === "until" ? `in ${span}` : `for ${span}`;
}

// ── Numbers ────────────────────────────────────────────────────────────────────────────────────

/** A count with separators: "1,284". */
export function formatCount(n: number, opts: FormatOptions = {}): string {
  return new Intl.NumberFormat(opts.locale, {
    maximumFractionDigits: 0,
  }).format(n);
}

/** A number with up to `max` decimals. */
export function formatNumber(
  n: number,
  max = 2,
  opts: FormatOptions = {},
): string {
  return new Intl.NumberFormat(opts.locale, {
    maximumFractionDigits: max,
  }).format(n);
}

/** Basis points as a percent, up to 2 decimals: 1250 → "12.5 %". */
export function formatBasisPoints(
  bp: number,
  opts: FormatOptions = {},
): string {
  return `${formatNumber(bp / 100, 2, opts)} %`;
}

/** A fraction (0–1) as a percent with `decimals` (rates use 1): 0.125 → "12.5 %". */
export function formatPercent(
  fraction: number,
  decimals = 1,
  opts: FormatOptions = {},
): string {
  return `${new Intl.NumberFormat(opts.locale, {
    maximumFractionDigits: decimals,
  }).format(fraction * 100)} %`;
}

const BYTE_UNITS = ["B", "kB", "MB", "GB", "TB", "PB"];

/** Bytes in decimal units, matching store consoles: 12_400_000 → "12.4 MB". */
export function formatBytes(bytes: number, opts: FormatOptions = {}): string {
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = unit === 0 ? 0 : value < 10 ? 1 : value < 100 ? 1 : 0;
  const sign = bytes < 0 ? "-" : "";
  return `${sign}${new Intl.NumberFormat(opts.locale, {
    maximumFractionDigits: digits,
  }).format(value)} ${BYTE_UNITS[unit]}`;
}

/** Middle truncation for ids and hashes: "3f9a1c…8d02" (`head` + `tail` characters). */
export function truncateMiddle(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
