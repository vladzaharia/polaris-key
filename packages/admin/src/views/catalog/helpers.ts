import type {
  ConfigEntry,
  ConfigKind,
  ManagementState,
  ProductCatalog,
} from "../../api.js";

/** Badge variant per config kind, mirroring the SchemaForm convention. */
export const KIND_VARIANT: Record<
  ConfigKind,
  "default" | "warning" | "primary"
> = {
  config: "default",
  secret: "warning",
  flag: "primary",
};

/** Badge variant per management state, mirroring the SchemaForm convention. */
export const STATE_VARIANT: Record<
  ManagementState,
  "default" | "primary" | "warning"
> = {
  default: "default",
  enforced: "primary",
  hidden: "warning",
};

/** A short, human-readable summary of a JSON-Schema fragment (the Draft-07 subset we use). */
export function schemaSummary(schema: Record<string, unknown>): string {
  if (!schema || typeof schema !== "object") return "—";
  const parts: string[] = [];
  if (Array.isArray(schema.enum)) {
    parts.push(`enum: ${schema.enum.map((v) => String(v)).join(" | ")}`);
  } else if (typeof schema.type === "string") {
    parts.push(schema.type);
  } else {
    parts.push("any");
  }
  const bounds: string[] = [];
  if (typeof schema.minimum === "number") bounds.push(`≥ ${schema.minimum}`);
  if (typeof schema.maximum === "number") bounds.push(`≤ ${schema.maximum}`);
  if (typeof schema.minLength === "number")
    bounds.push(`min len ${schema.minLength}`);
  if (typeof schema.maxLength === "number")
    bounds.push(`max len ${schema.maxLength}`);
  if (typeof schema.pattern === "string") bounds.push(`/${schema.pattern}/`);
  if (bounds.length) parts.push(`(${bounds.join(", ")})`);
  return parts.join(" ");
}

/** Render any default/value as a compact string for table display. */
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

export interface CategoryGroup {
  category: string;
  entries: ConfigEntry[];
}

/**
 * Group entries by `category`, preserving first-seen category order and ordering entries
 * within a category by the optional `ui.order` hint then label.
 */
export function groupByCategory(entries: ConfigEntry[]): CategoryGroup[] {
  const order: string[] = [];
  const buckets = new Map<string, ConfigEntry[]>();
  for (const entry of entries) {
    const cat = entry.category || "general";
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

export interface ParseResult {
  ok: boolean;
  catalog?: ProductCatalog;
  error?: string;
}

const KINDS: ConfigKind[] = ["config", "secret", "flag"];

/**
 * Parse + client-side-validate a catalog draft (JSON text) into a `ProductCatalog`. Mirrors the
 * minimal invariants the worker's catalog compiler enforces so an operator gets fast feedback
 * before the publish round-trip: a numeric `schemaVersion`, an `entries` array, and per-entry a
 * non-empty `key`, a valid `kind`, and an object `schema`. Returns the first problem found.
 */
export function parseCatalogDraft(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      error: "Catalog must be an object with `schemaVersion` and `entries`.",
    };
  }
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.schemaVersion !== "number" ||
    !Number.isFinite(obj.schemaVersion)
  ) {
    return { ok: false, error: "`schemaVersion` must be a number." };
  }
  if (!Array.isArray(obj.entries)) {
    return { ok: false, error: "`entries` must be an array." };
  }
  const seen = new Set<string>();
  for (let i = 0; i < obj.entries.length; i++) {
    const e = obj.entries[i];
    const at = `entries[${i}]`;
    if (typeof e !== "object" || e === null || Array.isArray(e)) {
      return { ok: false, error: `${at} must be an object.` };
    }
    const entry = e as Record<string, unknown>;
    if (typeof entry.key !== "string" || entry.key.trim() === "") {
      return { ok: false, error: `${at}.key is required.` };
    }
    if (seen.has(entry.key)) {
      return { ok: false, error: `Duplicate key "${entry.key}".` };
    }
    seen.add(entry.key);
    if (
      typeof entry.kind !== "string" ||
      !KINDS.includes(entry.kind as ConfigKind)
    ) {
      return {
        ok: false,
        error: `${at}.kind must be one of ${KINDS.join(", ")}.`,
      };
    }
    if (
      typeof entry.schema !== "object" ||
      entry.schema === null ||
      Array.isArray(entry.schema)
    ) {
      return { ok: false, error: `${at}.schema must be a JSON-Schema object.` };
    }
  }
  return { ok: true, catalog: obj as unknown as ProductCatalog };
}
