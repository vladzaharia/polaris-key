/**
 * Catalog entries as the console reads them (docs/design/ADMIN.md §6.6): the validator, the entry
 * helpers and the one set of display tables. Split out of the old 895-line `SchemaForm.tsx`
 * (SCF-7) and merged with the copies that lived in `views/catalog/helpers.ts` (CAT-9), so the
 * catalog page, the catalog editor, the payload editor and the license override editor all read
 * the same definitions.
 *
 * ── VALIDATION IS THE SERVER'S, NOT A LOOKALIKE ──────────────────────────────────────────────
 *
 * `@polaris-key/catalog` is workerd-safe *because* it interprets schemas instead of compiling
 * them (no `Function` constructor), which is exactly what makes it importable in a browser too.
 * So the console runs `Catalog#validateEntryValue` — byte-for-byte the call
 * `core/console/overrides.ts` makes server-side. A value this file accepts is a value the PUT
 * accepts, and the message an operator reads inline is the message the 422 would have carried.
 *
 * `pattern` is matched by the linear-time NFA in `shared-catalog/src/regex.ts` rather than the
 * host `RegExp`: a catalog `pattern` is operator-supplied and can reach us from `.pkey/` in a
 * linked repo via a webhook resync with no review step, and `(x+x+)+y` takes V8 ~54 s on a
 * 41-character input — a frozen console tab.
 */

import * as React from "react";
import { Catalog, type ProductCatalog } from "@polaris-key/catalog";
import type { ConfigEntry, ConfigKind, ManagementState } from "../api.js";
import type { Tone } from "../lib/status.js";

/** What a value control reports on every change. */
export interface FieldResult {
  value: unknown;
  valid: boolean;
  error?: string;
}

// ── the validator ──────────────────────────────────────────────────────────────────────────────

/**
 * One `Catalog` per `ProductCatalog` object. `Catalog` memoises each entry's prepared schema, so
 * sharing the instance across every row of an editor analyses each fragment (its `pattern`
 * included) once per catalog load, not once per keystroke. Keyed weakly so a product switch
 * drops the whole thing.
 */
const CATALOGS = new WeakMap<ProductCatalog, Catalog>();

export function catalogFor(catalog: ProductCatalog): Catalog {
  let hit = CATALOGS.get(catalog);
  if (!hit) {
    hit = new Catalog(catalog);
    CATALOGS.set(catalog, hit);
  }
  return hit;
}

/** React binding for `catalogFor`: stable for the lifetime of a loaded catalog. */
export function useCatalog(
  catalog: ProductCatalog | null | undefined,
): Catalog | null {
  return React.useMemo(() => (catalog ? catalogFor(catalog) : null), [catalog]);
}

/** A single-entry `Catalog` for a bare schema fragment, so `validate()` runs the same path. */
const LOOSE = new WeakMap<object, Catalog>();

function looseCatalog(schema: Record<string, unknown>): Catalog {
  let hit = LOOSE.get(schema);
  if (!hit) {
    // An empty `key` makes `validateEntryValue`'s `${key}${instancePath} ${message}` come back
    // as a bare message, which is what an inline field error wants.
    hit = new Catalog({
      schemaVersion: 0,
      entries: [
        {
          key: "",
          kind: "config",
          category: "",
          label: "",
          description: "",
          schema,
        },
      ],
    });
    LOOSE.set(schema, hit);
  }
  return hit;
}

/** Strip the entry key the server prefixes every message with, keeping any JSON-Pointer path. */
function stripKey(key: string, message: string): string {
  const rest = message.startsWith(key) ? message.slice(key.length) : message;
  return rest.trimStart() || message;
}

/**
 * Validate one catalog entry's value. `undefined` means "not set", which is never an error: an
 * absent key is how the payload says "this layer contributes nothing". Returns the first
 * message, or `null`.
 */
export function validateEntry(
  entry: ConfigEntry,
  value: unknown,
  catalog?: Catalog | null,
): string | null {
  if (value === undefined) return null;
  const cat = catalog ?? looseCatalog(entry.schema);
  const res = cat.validateEntryValue(entry, value);
  if (res.ok) return null;
  const first = res.errors[0] ?? "is not valid";
  return stripKey(entry.key, first);
}

/** Validate a value against a bare schema fragment (no entry to hand); the same interpreter. */
export function validate(
  schema: Record<string, unknown>,
  value: unknown,
): string | null {
  if (value === undefined) return null;
  const cat = looseCatalog(schema);
  const res = cat.validateEntryValue(cat.entries[0]!, value);
  return res.ok ? null : (res.errors[0] ?? "is not valid").trimStart();
}

// ── entry helpers ──────────────────────────────────────────────────────────────────────────────

/** A write-only entry: its value never crosses the wire in either direction. */
export function isSecretEntry(entry: ConfigEntry): boolean {
  return entry.kind === "secret" || entry.secret === true;
}

/** What a client falls back to when no layer sets this key: the catalog `default`, else the
 *  schema's own `default` annotation. `undefined` means "genuinely nothing". */
export function entryDefault(entry: ConfigEntry): unknown {
  if (entry.default !== undefined) return entry.default;
  return (entry.schema as { default?: unknown }).default;
}

/** Render any managed value compactly: the ghosted default, a table cell, a diff side. */
export function formatValue(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "string") return value === "" ? '""' : value;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[object]";
    }
  }
  return String(value);
}

/** The seed value used when an operator materialises a previously-unset row. */
export function initialValueFor(entry: ConfigEntry): unknown {
  const fallback = entryDefault(entry);
  if (fallback !== undefined) return fallback;
  const schema = entry.schema;
  if (schema.type === "boolean") return false;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (schema.type === "integer" || schema.type === "number") {
    return typeof schema.minimum === "number" ? schema.minimum : 0;
  }
  if (schema.type === "array") return [];
  if (schema.type === "object") return {};
  return "";
}

export type Widget =
  | "switch"
  | "select"
  | "number"
  | "json"
  | "textarea"
  | "password"
  | "text";

/**
 * Which control an entry gets. The JSON-Schema decides; `ui.widget` only breaks ties the schema
 * leaves open (a string that wants a textarea, a config key that wants masking): a hint may
 * never contradict the type, or the control would emit values the server rejects.
 */
export function widgetFor(entry: ConfigEntry): Widget {
  const schema = entry.schema;
  const hint = entry.ui?.widget;
  if (schema.type === "boolean") return "switch";
  if (Array.isArray(schema.enum)) return "select";
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type === "array" || schema.type === "object") return "json";
  if (isSecretEntry(entry) || hint === "password") return "password";
  if (hint === "textarea") return "textarea";
  return "text";
}

/** A short summary of a JSON-Schema fragment (the Draft-07 subset the catalog uses). */
export function schemaSummary(schema: Record<string, unknown>): string {
  if (!schema || typeof schema !== "object") return "—";
  const parts: string[] = [];
  if (Array.isArray(schema.enum)) {
    parts.push(`enum: ${schema.enum.map((v) => String(v)).join(" | ")}`);
  } else if (typeof schema.type === "string") {
    parts.push(
      typeof schema.format === "string"
        ? `${schema.type} (${schema.format})`
        : schema.type,
    );
  } else {
    parts.push("any");
  }
  const bounds: string[] = [];
  if (typeof schema.minimum === "number") bounds.push(`≥ ${schema.minimum}`);
  if (typeof schema.maximum === "number") bounds.push(`≤ ${schema.maximum}`);
  if (typeof schema.minLength === "number")
    bounds.push(`min length ${schema.minLength}`);
  if (typeof schema.maxLength === "number")
    bounds.push(`max length ${schema.maxLength}`);
  if (typeof schema.pattern === "string") bounds.push(`/${schema.pattern}/`);
  if (bounds.length) parts.push(`(${bounds.join(", ")})`);
  return parts.join(" ");
}

export interface CategoryGroup {
  category: string;
  entries: ConfigEntry[];
}

/** The category an entry without one is filed under (the stored value). */
export const UNCATEGORISED = "general";

/** A category as the console shows it: the uncategorised bucket reads "General". */
export function categoryLabel(category: string): string {
  return category === UNCATEGORISED ? "General" : category;
}

/**
 * Group entries by `category`, preserving first-seen category order and ordering entries within
 * a category by the optional `ui.order` hint, then label.
 */
export function groupByCategory(entries: ConfigEntry[]): CategoryGroup[] {
  const order: string[] = [];
  const buckets = new Map<string, ConfigEntry[]>();
  for (const entry of entries) {
    const cat = entry.category || UNCATEGORISED;
    if (!buckets.has(cat)) {
      buckets.set(cat, []);
      order.push(cat);
    }
    buckets.get(cat)!.push(entry);
  }
  return order.map((category) => ({
    category,
    entries: [...buckets.get(category)!].sort((a, b) => {
      const ao = a.ui?.order ?? Number.MAX_SAFE_INTEGER;
      const bo = b.ui?.order ?? Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      return a.label.localeCompare(b.label);
    }),
  }));
}

// ── display tables (one copy; CAT-9) ───────────────────────────────────────────────────────────

/** Kind → status tone. Secret reads as a warning: its value is write-only. */
export const KIND_TONE: Record<ConfigKind, Tone> = {
  config: "neutral",
  // A secret is not a warning: an outlined pill, apart from the amber of Enforced.
  secret: "outline",
  flag: "info",
};

/** Management state → status tone. */
export const STATE_TONE: Record<ManagementState, Tone> = {
  default: "neutral",
  enforced: "accent",
  // Hidden reads distinct from Enforced (it was the same amber).
  hidden: "neutral",
};

/**
 * The three management states, worded from the protocol's own definition
 * (`@polaris-key/protocol` `ManagementState`) so the console cannot drift from the semantics
 * the SDKs implement.
 */
export const MANAGEMENT_STATES: {
  value: ManagementState;
  label: string;
  help: string;
}[] = [
  {
    value: "default",
    label: "Default",
    help: "The server's value is a default: the client may override it locally or by environment variable.",
  },
  {
    value: "enforced",
    label: "Enforced",
    help: "The server value wins; the client cannot override it and shows it read-only.",
  },
  {
    value: "hidden",
    label: "Hidden",
    help: "Enforced, and withheld from user-facing enumeration: still applied, never listed.",
  },
];

/** What a lower layer of the payload stack contributes for a key (license overrides only). */
export interface InheritedValue {
  /** Where it comes from, e.g. `profile “base”` or `catalog default`. */
  source: string;
  value: unknown;
  state: ManagementState;
}
