/**
 * Reading and writing JSON-in-a-text-column (the `*_json` columns of D1, KV values, cursors).
 *
 * ONE set of helpers (P0-15; there were about thirty local copies, two of them named
 * `parseJsonColumn` with different signatures). The rule they share: a stored value that is
 * absent, empty or not valid JSON DEGRADES to a caller-chosen fallback and never throws. A
 * manual `wrangler d1 execute` repair, or a writer that forgot `JSON.stringify`, must not turn
 * into a `SyntaxError` out of whatever handler reads the column next.
 *
 * "Absent" is `null`, `undefined` or the empty string. The empty string is not valid JSON, so a
 * copy that only special-cased `null` reached the same fallback through the `catch`; the helpers
 * below make that explicit instead of accidental.
 *
 * A leaf module: it imports nothing else in `src/`.
 */

/** A plain JSON object: not `null`, not an array. */
export function isJsonObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** The parsed column, or `fallback` when it is absent, empty or malformed. Never throws. */
export function parseJsonOr<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** The parsed column, or `null` when it is absent, empty or malformed. Never throws. */
export function parseJsonColumn<T = unknown>(
  raw: string | null | undefined,
): T | null {
  return parseJsonOr<T | null>(raw, null);
}

/** The parsed value, or `undefined` when it is absent, empty or malformed. Never throws. */
export function tryParseJson(raw: string | null | undefined): unknown {
  return parseJsonOr<unknown>(raw, undefined);
}

/**
 * The column as a plain object, or `null` when it is absent, empty, malformed, or valid JSON of
 * another shape (an array, a string, `null`). A non-string `raw` (a column read as `unknown`)
 * is absent.
 */
export function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  const v = tryParseJson(raw);
  return isJsonObject(v) ? v : null;
}

/** The column as an array, or `null` when it is absent, empty, malformed or not an array. */
export function parseJsonArray(raw: unknown): unknown[] | null {
  if (typeof raw !== "string") return null;
  const v = tryParseJson(raw);
  return Array.isArray(v) ? v : null;
}

/**
 * A column that must read back as a list of strings: the string members of a JSON array, in
 * order; `[]` when the column is absent, empty, malformed or not an array.
 */
export function parseJsonStringList(raw: string | null | undefined): string[] {
  const v = parseJsonColumn(raw);
  return Array.isArray(v)
    ? v.filter((item): item is string => typeof item === "string")
    : [];
}

/** The value to store in a nullable JSON column: SQL NULL for `null`/`undefined`, else JSON. */
export function toJsonColumn(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}
