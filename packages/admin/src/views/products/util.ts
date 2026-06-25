import type { CreateManualProductBody, ProductDetail } from "../../api.js";

/** The release source of a product, derived from its signing-key origin / linkage. */
export type ReleaseSource = "github" | "manual";

/**
 * The platform registry doesn't return an explicit `source` field, so we infer it: a product
 * minted by `link-repo` carries an App-derived signing key whose kid is namespaced `gh:` /
 * `github:`. Everything else is a manually-registered product. This keeps the list honest
 * without a schema change and degrades to "manual" when the kid shape is unfamiliar.
 */
export function releaseSourceOf(product: Pick<ProductDetail, "signingKid">): ReleaseSource {
  const kid = (product.signingKid ?? "").toLowerCase();
  return kid.startsWith("gh:") || kid.startsWith("github:") || kid.includes("github") ? "github" : "manual";
}

/** Format an epoch-seconds timestamp as a short, locale-aware date (or an em-dash if absent). */
export function formatDate(epochSeconds: number | null | undefined): string {
  if (!epochSeconds) return "—";
  const d = new Date(epochSeconds * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** A non-empty trimmed string or `undefined` — keeps optional body fields out of the wire. */
export function trimmedOrUndefined(value: string): string | undefined {
  const t = value.trim();
  return t === "" ? undefined : t;
}

/** Parse an integer field; returns `undefined` for blank/non-numeric input. */
export function intOrUndefined(value: string): number | undefined {
  const t = value.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/**
 * Best-effort detection of a likely-valid slug. The server is the authority, but catching the
 * obvious cases (blank, spaces, uppercase, illegal chars) before the round-trip gives a fast,
 * inline error.
 */
export function slugError(slug: string): string | null {
  const t = slug.trim();
  if (t === "") return "A slug is required.";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(t)) return "Use lowercase letters, digits, and hyphens.";
  return null;
}

/**
 * The schema textarea accepts JSON or YAML. We only *validate* JSON here (and pass a parsed
 * object straight through); anything that isn't JSON is forwarded as a raw string so the
 * server's YAML parser can take it. Returns a parse error only for malformed JSON that
 * nonetheless looks like JSON (starts with `{`/`[`).
 */
export function parseSchemaField(raw: string): { value: CreateManualProductBody["schema"]; error: string | null } {
  const t = raw.trim();
  if (t === "") return { value: undefined, error: null };
  const looksJson = t.startsWith("{") || t.startsWith("[");
  if (looksJson) {
    try {
      return { value: JSON.parse(t) as CreateManualProductBody["schema"], error: null };
    } catch {
      return { value: undefined, error: "Schema is not valid JSON." };
    }
  }
  // Treat as raw (YAML or a server-understood string form).
  return { value: t, error: null };
}

/** Coerce an unknown API error into a human-readable, possibly multi-line message. */
export function errorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { message?: string; fields?: string[] };
    const parts: string[] = [];
    if (e.message) parts.push(e.message);
    if (Array.isArray(e.fields) && e.fields.length) parts.push(e.fields.join(", "));
    if (parts.length) return parts.join(" — ");
  }
  return "Request failed.";
}
