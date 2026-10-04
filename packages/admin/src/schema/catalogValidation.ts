/**
 * Whole-catalog checks for the catalog editor (docs/design/ADMIN.md §6.6.2, CAT-4, CAT-5).
 *
 * The publish route accepts a catalog when `new Catalog(doc).compileAll()` succeeds and every key
 * is representable as a member name (`catalogKeyIssue`). The editor runs the same two checks from
 * `@polaris-key/catalog`, plus the structural rules a malformed draft would otherwise only meet as
 * a server 422: an `entries` array, a key per entry, a known kind, no duplicate keys. Each problem
 * carries the entry it belongs to, so the form marks the entry and the JSON mode puts a lint
 * marker on its line.
 */

import {
  catalogKeyIssue,
  describeRepresentabilityIssue,
  prepareSchema,
} from "@polaris-key/catalog";
import type { CodeDiagnostic } from "../ui/CodeEditor.js";

export const CATALOG_KINDS = ["config", "secret", "flag"] as const;

export interface CatalogIssue {
  /** The entry's index in `entries`, when the problem belongs to one. */
  index?: number;
  /** The entry's key, when it has one. */
  key?: string;
  /** The field inside the entry ("key", "kind", "schema", …). */
  field?: string;
  message: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The schema fragment's problem, or `null` (the server's interpreter, not a lookalike). */
export function schemaIssue(schema: unknown): string | null {
  if (!isObject(schema)) return "The schema must be a JSON object.";
  try {
    prepareSchema(schema);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "This schema is not supported.";
  }
}

/** Every problem in a catalog document, in entry order. Empty means it would publish. */
export function catalogIssues(doc: unknown): CatalogIssue[] {
  if (!isObject(doc))
    return [{ message: "A catalog is an object with an entries array." }];
  const entries = doc.entries;
  if (!Array.isArray(entries))
    return [{ field: "entries", message: "entries must be an array." }];
  const issues: CatalogIssue[] = [];
  const seen = new Map<string, number>();
  entries.forEach((raw, index) => {
    if (!isObject(raw)) {
      issues.push({ index, message: `Entry ${index + 1} must be an object.` });
      return;
    }
    const key = typeof raw.key === "string" ? raw.key : undefined;
    const at = { index, ...(key ? { key } : {}) };
    if (!key || key.trim() === "") {
      issues.push({ ...at, field: "key", message: "Every entry needs a key." });
    } else if (seen.has(key)) {
      issues.push({
        ...at,
        field: "key",
        message: `The key ${key} is used twice.`,
      });
    } else {
      seen.set(key, index);
    }
    if (!CATALOG_KINDS.includes(raw.kind as (typeof CATALOG_KINDS)[number])) {
      issues.push({
        ...at,
        field: "kind",
        message: "Kind must be config, secret or flag.",
      });
    }
    for (const field of ["label", "category"] as const) {
      if (raw[field] !== undefined && typeof raw[field] !== "string")
        issues.push({ ...at, field, message: `${field} must be text.` });
    }
    const schema = schemaIssue(raw.schema);
    if (schema) issues.push({ ...at, field: "schema", message: schema });
  });
  const keyIssue = catalogKeyIssue(doc);
  if (keyIssue) {
    const index = Number(keyIssue.path.split("/")[2]);
    const entry = entries[index];
    issues.push({
      index,
      ...(isObject(entry) && typeof entry.key === "string"
        ? { key: entry.key }
        : {}),
      field: "key",
      message: describeRepresentabilityIssue(keyIssue, "This key"),
    });
  }
  return issues;
}

/** 1-based line and column of a character offset. */
function lineCol(
  text: string,
  offset: number,
): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, offset));
  const lines = before.split("\n");
  return { line: lines.length, column: lines[lines.length - 1]!.length + 1 };
}

/** The line an entry starts on: the first `"key": "<key>"` with that key. */
function lineOfKey(
  text: string,
  key: string,
): { line: number; column: number } {
  const needle = new RegExp(
    `"key"\\s*:\\s*${JSON.stringify(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
  );
  const m = needle.exec(text);
  return m ? lineCol(text, m.index) : { line: 1, column: 1 };
}

/**
 * Where a JSON syntax error is. Engines word the error differently (V8 no longer says
 * "position N"), so the position is found by bisection: a prefix that ends before the error fails
 * as "unexpected end"; one that includes the offending character fails differently.
 */
function syntaxErrorOffset(text: string, message: string): number {
  const pos = /position (\d+)/.exec(message);
  if (pos) return Number(pos[1]);
  const fails = (k: number): boolean => {
    try {
      JSON.parse(text.slice(0, k));
      return false;
    } catch (e) {
      // A prefix cut inside a string or a literal fails as "unterminated" or "end of input".
      return !/end of (JSON )?(input|data)|unterminated/i.test(
        e instanceof Error ? e.message : "",
      );
    }
  };
  let lo = 1;
  let hi = text.length;
  if (!fails(hi)) return Math.max(0, text.length - 1);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (fails(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo - 1;
}

/** JSON-mode lint markers: a parse error at its position, else each catalog issue on its line. */
export function catalogDiagnostics(text: string): CodeDiagnostic[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Invalid JSON";
    const at = lineCol(text, syntaxErrorOffset(text, message));
    return [{ ...at, message: `Invalid JSON: ${message}`, severity: "error" }];
  }
  return catalogIssues(doc).map((issue) => ({
    ...(issue.key ? lineOfKey(text, issue.key) : { line: 1, column: 1 }),
    message: issue.message,
    severity: "error" as const,
  }));
}
