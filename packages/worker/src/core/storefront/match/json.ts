/**
 * The plain-JSON body matcher (Google Play's androidpublisher, Microsoft's submission APIs;
 * notes/S-15 §6.2). Microsoft's rule table (`../rules/microsoftStore.ts`, A-18f) is the first user;
 * `test/storefront/substrate.test.ts` and the conformance suite hold it to its contract.
 *
 * A rule declares the body's SHAPE: which top-level and nested keys may appear, which values a
 * key may take, and how long an array may be. Every key the body carries must be declared; a
 * declared key may be absent. The rule's own `check` runs last, on the parsed body.
 */

import {
  isPlainObject,
  type DenyReason,
  type GateContext,
  type GateRule,
} from "../gate.js";

/** What one JSON value may be. */
export type JsonShape =
  /** A string of at most `max` characters (default 4000), optionally one of `values`. */
  | { kind: "string"; max?: number; values?: readonly string[] }
  | { kind: "number"; min?: number; max?: number }
  | { kind: "boolean" }
  | { kind: "object"; keys: Readonly<Record<string, JsonShape>> }
  | { kind: "array"; items: JsonShape; max: number }
  /**
   * A dictionary whose keys are data, not names (Microsoft's listings by language, prices by
   * market): every key must match `key` (a regex source, anchored here) and every value `values`;
   * at most `max` entries (A-18f).
   */
  | { kind: "map"; key: string; values: JsonShape; max: number };

export interface JsonRule extends GateRule {
  /** The body: always an object. */
  body: Readonly<Record<string, JsonShape>>;
  check?: (
    body: Record<string, unknown>,
    ctx: GateContext,
  ) => DenyReason | null;
}

function fits(
  value: unknown,
  shape: JsonShape,
  depth: number,
): DenyReason | null {
  if (depth > 8) return "invalid_body";
  switch (shape.kind) {
    case "string":
      if (typeof value !== "string") return "invalid_body";
      if (value.length > (shape.max ?? 4000)) return "value_not_allowed";
      if (shape.values && !shape.values.includes(value))
        return "value_not_allowed";
      return null;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value))
        return "invalid_body";
      if (
        (shape.min !== undefined && value < shape.min) ||
        (shape.max !== undefined && value > shape.max)
      )
        return "value_not_allowed";
      return null;
    case "boolean":
      return typeof value === "boolean" ? null : "invalid_body";
    case "object":
      return fitsObject(value, shape.keys, depth + 1);
    case "array": {
      if (!Array.isArray(value)) return "invalid_body";
      if (value.length > shape.max) return "invalid_body";
      for (const item of value) {
        const r = fits(item, shape.items, depth + 1);
        if (r) return r;
      }
      return null;
    }
    case "map": {
      if (!isPlainObject(value)) return "invalid_body";
      const entries = Object.entries(value);
      if (entries.length > shape.max) return "invalid_body";
      const key = new RegExp(`^(?:${shape.key})$`);
      for (const [k, v] of entries) {
        if (!key.test(k)) return "attribute_not_allowed";
        const r = fits(v, shape.values, depth + 1);
        if (r) return r;
      }
      return null;
    }
  }
}

function fitsObject(
  value: unknown,
  keys: Readonly<Record<string, JsonShape>>,
  depth: number,
): DenyReason | null {
  if (!isPlainObject(value)) return "invalid_body";
  for (const [k, v] of Object.entries(value)) {
    if (!Object.hasOwn(keys, k)) return "attribute_not_allowed";
    const r = fits(v, keys[k]!, depth);
    if (r) return r;
  }
  return null;
}

/** The JSON matcher. */
export function matchJson(
  rule: JsonRule,
  _path: string,
  body: unknown,
  ctx: GateContext,
): DenyReason | null {
  const r = fitsObject(body, rule.body, 0);
  if (r) return r;
  return rule.check ? rule.check(body as Record<string, unknown>, ctx) : null;
}
