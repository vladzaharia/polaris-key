import { newEntry } from "../model/catalogDraft.js";

export const TYPES = [
  "string",
  "integer",
  "number",
  "boolean",
  "array",
  "object",
] as const;
export type SchemaType = (typeof TYPES)[number];

/**
 * The label a key implies: its last dotted segment in words, sentence case (`audio.bufferSize`
 * → "Buffer size", `net.retry_count` → "Retry count"). All-caps words keep their case.
 */
export function labelFromKey(key: string): string {
  const last = key.split(".").filter(Boolean).pop() ?? "";
  const words = last
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => (w.length > 1 && /^[A-Z0-9]+$/.test(w) ? w : w.toLowerCase()));
  const text = words.join(" ");
  return text ? text[0]!.toUpperCase() + text.slice(1) : "";
}

/**
 * The type a typed default implies, with the default in that type: `true` → On / off, `512` →
 * Whole number, `0.5` → Number, `[…]`/`{…}` that parse → List/Object, anything else → Text.
 * An empty box is no default.
 */
export function guessDefault(
  raw: string,
): { type: SchemaType; value: unknown } | null {
  const t = raw.trim();
  if (t === "") return null;
  if (t === "true" || t === "false")
    return { type: "boolean", value: t === "true" };
  if (/^-?\d+$/.test(t) && Number.isSafeInteger(Number(t)))
    return { type: "integer", value: Number(t) };
  if (/^-?(\d+\.\d*|\.\d+|\d+(\.\d+)?[eE][+-]?\d+)$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return { type: "number", value: n };
  }
  if (t.startsWith("[") || t.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(t);
      if (Array.isArray(parsed)) return { type: "array", value: parsed };
      if (parsed && typeof parsed === "object")
        return { type: "object", value: parsed };
    } catch {
      // Not JSON (yet): it is text.
    }
  }
  return { type: "string", value: raw };
}

/** The text a default reads as in the plain Default box. */
export const defaultText = (value: unknown): string =>
  value === undefined
    ? ""
    : typeof value === "string"
      ? value
      : JSON.stringify(value);

/** The label `newEntry` gives a fresh entry, which Label-from-Key replaces like a derived one. */
export const PLACEHOLDER_LABEL = newEntry([], "").label;
