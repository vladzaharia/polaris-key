// An *interpreting* JSON-Schema (Draft-07 subset) validator.
//
// WHY THIS EXISTS. Ajv validates by generating JavaScript source and handing it to the
// `Function` constructor. workerd forbids code generation from strings outside the startup
// window, and catalogs are read asynchronously from D1 — i.e. only ever during a request — so
// there is no window in which an Ajv validator for a catalog can legally be compiled.
// Verified on real workerd: every `catalog.validateKeyValue(...)` threw
// `EvalError: Code generation from strings disallowed for this context`, turning
// `GET /<product>/config` into a 500 for every device on every poll
// (the VERIFY-R10-01 audit note). Caching the compiled validator does not help;
// it only moves the throw from per-request to per-isolate.
//
// This module walks the schema instead of compiling it, so nothing is ever evaluated. It has
// no dependencies.
//
// FAIL-CLOSED KEYWORD POLICY. A schema keyword this module does not implement makes the
// fragment *unsupported*, never "ignored". `prepareSchema` throws, `compileAll()` surfaces
// that at publish time as a 422, and at request time an unsupported fragment marks its value
// invalid so it is pruned before signing. Silently skipping an unrecognised constraint would
// let an operator believe a value is bounded when it is not.
//
// `pattern` and `patternProperties` are matched with the linear-time engine in `./regex.js`,
// never the host `RegExp` — see that module for why.

import {
  compileLinearPattern,
  UnsupportedPatternError,
  type LinearPattern,
} from "./regex.js";

/** Deepest schema nesting accepted. Catalog fragments are a few levels at most. */
export const MAX_SCHEMA_DEPTH = 12;
/** Total subschemas accepted in one fragment. */
export const MAX_SCHEMA_NODES = 500;
/** Work ceiling for one `validate` call; exceeding it fails the value closed. */
export const MAX_VALIDATION_STEPS = 100_000;
/** Largest array `uniqueItems` will scan before giving up (fails closed). */
export const MAX_UNIQUE_ITEMS = 1_000;

/**
 * Work counters, test hooks (not exported from the package; P1-13's pattern): `prepares` counts
 * `prepareSchema` runs (a memoised caller prepares a fragment once), `canonicalised` counts the
 * items `uniqueItems` reduces to their canonical form (none for an array past the scan cap). The
 * checks diff them around a call instead of reading a clock, so they hold under any load.
 */
export const validateWork = { prepares: 0, canonicalised: 0 };

/** A schema fragment this module refuses to interpret. Never treat as "no constraint". */
export class UnsupportedSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedSchemaError";
  }
}

export interface ValidationIssue {
  /** JSON-Pointer path into the *value*, matching Ajv's `instancePath`. */
  readonly instancePath: string;
  readonly message: string;
}

// ── keyword tables ───────────────────────────────────────────────────────────

/** Annotation / metadata keywords: carried in catalog fragments, no effect on validity. */
const ANNOTATION_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "definitions",
  "$defs",
  "contentMediaType",
  "contentEncoding",
]);

const ASSERTION_KEYWORDS = new Set([
  "type",
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "items",
  "additionalItems",
  "minItems",
  "maxItems",
  "uniqueItems",
  "contains",
  "properties",
  "required",
  "additionalProperties",
  "patternProperties",
  "propertyNames",
  "minProperties",
  "maxProperties",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
]);

const TYPE_NAMES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
  "null",
]);

// ── formats ──────────────────────────────────────────────────────────────────

const CTRL_OR_SPACE = /[\u0000-\u0020\u007f]/;
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+\-.]*:/;
const HOSTNAME_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?$/;
const EMAIL_RE = /^[^\s@"'\\]+@[^\s@."'\\]+(?:\.[^\s@."'\\]+)+$/;
const JSON_POINTER_RE = /^(?:\/(?:[^~/]|~[01])*)*$/;

/**
 * Absolute-URI check. Deliberately avoids the RFC-3986 mega-regex ajv-formats ships (which is
 * itself a backtracking hazard): reject control characters and spaces, require a scheme, then
 * let the WHATWG parser decide. Agrees with `ajv-formats`' `uri` on the catalog's own values
 * and on the differential corpus in `validate.test.ts`.
 */
function isUri(s: string): boolean {
  if (CTRL_OR_SPACE.test(s) || !URI_SCHEME.test(s)) return false;
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

function isUriReference(s: string): boolean {
  if (CTRL_OR_SPACE.test(s)) return false;
  try {
    new URL(s, "http://polaris.invalid/");
    return true;
  } catch {
    return false;
  }
}

function isIpv4(s: string): boolean {
  if (!IPV4_RE.test(s)) return false;
  return s
    .split(".")
    .every(
      (o) => o.length <= 3 && Number(o) <= 255 && (o === "0" || o[0] !== "0"),
    );
}

/** RFC-4291 address, split by hand; the only regex runs over a <=4-character hextet. */
function isIpv6(s: string): boolean {
  if (s.length > 45 || CTRL_OR_SPACE.test(s)) return false;
  const parts = s.split("::");
  if (parts.length > 2) return false;
  const hextet = (t: string): boolean =>
    t.length >= 1 && t.length <= 4 && /^[0-9a-fA-F]+$/.test(t);
  const groups = (chunk: string): string[] | null => {
    if (chunk === "") return [];
    const items = chunk.split(":");
    const last = items[items.length - 1] as string;
    if (last.includes(".")) {
      if (!isIpv4(last)) return null;
      items.pop();
      items.push("0", "0"); // an embedded IPv4 tail occupies two hextets
    }
    return items.every(hextet) ? items : null;
  };
  const head = groups(parts[0] as string);
  if (head === null) return false;
  if (parts.length === 1) return head.length === 8;
  const tail = groups(parts[1] as string);
  if (tail === null) return false;
  return head.length + tail.length <= 7;
}

function isDateTime(s: string): boolean {
  const at = s.search(/[Tt]/);
  if (at < 0) return false;
  return DATE_RE.test(s.slice(0, at)) && TIME_RE.test(s.slice(at + 1));
}

const FORMATS: Readonly<Record<string, (s: string) => boolean>> = {
  uri: isUri,
  url: isUri,
  "uri-reference": isUriReference,
  iri: isUri,
  email: (s) => EMAIL_RE.test(s),
  hostname: (s) => s.length <= 253 && HOSTNAME_RE.test(s),
  ipv4: isIpv4,
  ipv6: isIpv6,
  date: (s) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)),
  time: (s) => TIME_RE.test(s),
  "date-time": isDateTime,
  uuid: (s) => UUID_RE.test(s),
  "json-pointer": (s) => JSON_POINTER_RE.test(s),
  regex: (s) => {
    try {
      compileLinearPattern(s);
      return true;
    } catch {
      return false;
    }
  },
};

/** Format names this validator understands; anything else makes the schema unsupported. */
export const SUPPORTED_FORMATS: readonly string[] = Object.keys(FORMATS);

// ── prepared schema ──────────────────────────────────────────────────────────

interface Prepared {
  readonly always?: boolean; // a literal `true` / `false` schema
  readonly types?: readonly string[];
  readonly enum?: readonly unknown[];
  readonly hasConst?: boolean;
  readonly const?: unknown;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly multipleOf?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: LinearPattern;
  readonly format?: string;
  readonly items?: Prepared;
  readonly tuple?: readonly Prepared[];
  readonly additionalItems?: Prepared;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly contains?: Prepared;
  readonly properties?: ReadonlyMap<string, Prepared>;
  readonly required?: readonly string[];
  readonly additionalProperties?: Prepared;
  readonly patternProperties?: readonly {
    readonly re: LinearPattern;
    readonly schema: Prepared;
  }[];
  readonly propertyNames?: Prepared;
  readonly minProperties?: number;
  readonly maxProperties?: number;
  readonly allOf?: readonly Prepared[];
  readonly anyOf?: readonly Prepared[];
  readonly oneOf?: readonly Prepared[];
  readonly not?: Prepared;
  readonly if?: Prepared;
  readonly then?: Prepared;
  readonly else?: Prepared;
}

export interface PreparedSchema {
  readonly root: Prepared;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function own(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

class Preparer {
  private nodes = 0;

  prepare(schema: unknown, depth: number, path: string): Prepared {
    if (++this.nodes > MAX_SCHEMA_NODES)
      throw new UnsupportedSchemaError(
        `schema has more than ${MAX_SCHEMA_NODES} subschemas`,
      );
    if (depth > MAX_SCHEMA_DEPTH)
      throw new UnsupportedSchemaError(
        `schema nests deeper than ${MAX_SCHEMA_DEPTH} levels at ${path || "/"}`,
      );
    if (typeof schema === "boolean") return { always: schema };
    if (!isPlainObject(schema))
      throw new UnsupportedSchemaError(
        `schema at ${path || "/"} must be an object or boolean`,
      );

    for (const key of Object.keys(schema)) {
      if (ASSERTION_KEYWORDS.has(key) || ANNOTATION_KEYWORDS.has(key)) continue;
      throw new UnsupportedSchemaError(
        `unsupported schema keyword "${key}" at ${path || "/"}`,
      );
    }

    const out: Record<string, unknown> = {};
    const sub = (key: string): Prepared =>
      this.prepare(schema[key], depth + 1, `${path}/${key}`);

    if (own(schema, "type")) out.types = this.types(schema.type, path);
    if (own(schema, "enum")) {
      if (!Array.isArray(schema.enum) || schema.enum.length === 0)
        throw new UnsupportedSchemaError(
          `"enum" at ${path || "/"} must be a non-empty array`,
        );
      out.enum = schema.enum;
    }
    if (own(schema, "const")) {
      out.hasConst = true;
      out.const = schema.const;
    }

    for (const key of [
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
      "minLength",
      "maxLength",
      "minItems",
      "maxItems",
      "minProperties",
      "maxProperties",
    ] as const) {
      if (!own(schema, key)) continue;
      const n = schema[key];
      if (typeof n !== "number" || !Number.isFinite(n))
        throw new UnsupportedSchemaError(
          `"${key}" at ${path || "/"} must be a finite number`,
        );
      if (key === "multipleOf" && n <= 0)
        throw new UnsupportedSchemaError(`"multipleOf" must be > 0`);
      out[key] = n;
    }

    if (own(schema, "pattern"))
      out.pattern = this.pattern(schema.pattern, `${path}/pattern`);
    if (own(schema, "format")) {
      const f = schema.format;
      if (typeof f !== "string" || !own(FORMATS, f))
        throw new UnsupportedSchemaError(
          `unsupported "format": ${JSON.stringify(f)} (supported: ${SUPPORTED_FORMATS.join(", ")})`,
        );
      out.format = f;
    }

    if (own(schema, "items")) {
      if (Array.isArray(schema.items))
        out.tuple = schema.items.map((s, i) =>
          this.prepare(s, depth + 1, `${path}/items/${i}`),
        );
      else out.items = sub("items");
    }
    if (own(schema, "additionalItems"))
      out.additionalItems = sub("additionalItems");
    if (own(schema, "uniqueItems")) {
      if (typeof schema.uniqueItems !== "boolean")
        throw new UnsupportedSchemaError(`"uniqueItems" must be a boolean`);
      out.uniqueItems = schema.uniqueItems;
    }
    if (own(schema, "contains")) out.contains = sub("contains");

    if (own(schema, "properties")) {
      if (!isPlainObject(schema.properties))
        throw new UnsupportedSchemaError(`"properties" must be an object`);
      // A Map keeps `__proto__` / `constructor` property names inert.
      const map = new Map<string, Prepared>();
      for (const key of Object.keys(schema.properties))
        map.set(
          key,
          this.prepare(
            schema.properties[key],
            depth + 1,
            `${path}/properties/${key}`,
          ),
        );
      out.properties = map;
    }
    if (own(schema, "required")) {
      if (
        !Array.isArray(schema.required) ||
        schema.required.some((k) => typeof k !== "string")
      )
        throw new UnsupportedSchemaError(
          `"required" must be an array of strings`,
        );
      out.required = schema.required as string[];
    }
    if (own(schema, "additionalProperties"))
      out.additionalProperties = sub("additionalProperties");
    if (own(schema, "patternProperties")) {
      if (!isPlainObject(schema.patternProperties))
        throw new UnsupportedSchemaError(
          `"patternProperties" must be an object`,
        );
      out.patternProperties = Object.keys(schema.patternProperties).map(
        (src) => ({
          re: this.pattern(src, `${path}/patternProperties/${src}`),
          schema: this.prepare(
            (schema.patternProperties as Record<string, unknown>)[src],
            depth + 1,
            `${path}/patternProperties/${src}`,
          ),
        }),
      );
    }
    if (own(schema, "propertyNames")) out.propertyNames = sub("propertyNames");

    for (const key of ["allOf", "anyOf", "oneOf"] as const) {
      if (!own(schema, key)) continue;
      const arr = schema[key];
      if (!Array.isArray(arr) || arr.length === 0)
        throw new UnsupportedSchemaError(
          `"${key}" at ${path || "/"} must be a non-empty array`,
        );
      out[key] = arr.map((s, i) =>
        this.prepare(s, depth + 1, `${path}/${key}/${i}`),
      );
    }
    for (const key of ["not", "if", "then", "else"] as const)
      if (own(schema, key)) out[key] = sub(key);

    return out as Prepared;
  }

  private types(value: unknown, path: string): string[] {
    const list = Array.isArray(value) ? value : [value];
    if (list.length === 0)
      throw new UnsupportedSchemaError(
        `"type" at ${path || "/"} must not be empty`,
      );
    for (const t of list)
      if (typeof t !== "string" || !TYPE_NAMES.has(t))
        throw new UnsupportedSchemaError(
          `unsupported "type": ${JSON.stringify(t)} at ${path || "/"}`,
        );
    return list as string[];
  }

  private pattern(value: unknown, path: string): LinearPattern {
    if (typeof value !== "string")
      throw new UnsupportedSchemaError(`"pattern" at ${path} must be a string`);
    try {
      return compileLinearPattern(value);
    } catch (e) {
      if (e instanceof UnsupportedPatternError)
        throw new UnsupportedSchemaError(`${e.message} at ${path}`);
      throw e;
    }
  }
}

/**
 * Analyse a schema fragment once, ahead of validating values against it. Throws
 * `UnsupportedSchemaError` for anything outside the implemented Draft-07 subset, oversized,
 * or carrying a `pattern` the linear matcher will not accept.
 */
export function prepareSchema(schema: unknown): PreparedSchema {
  validateWork.prepares++;
  return { root: new Preparer().prepare(schema, 0, "") };
}

// ── validation ───────────────────────────────────────────────────────────────

/** Code-point length, matching Ajv's default `unicode: true` string measurement. */
function codePointLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    n++;
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
  }
  return n;
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "number")
    return Number.isInteger(v as number) ? "integer" : "number";
  return t;
}

function matchesType(v: unknown, t: string): boolean {
  switch (t) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "array":
      return Array.isArray(v);
    case "object":
      return isPlainObject(v);
    default:
      return v === null;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a !== "object" || Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) =>
      own(b as Record<string, unknown>, k) &&
      deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      ),
  );
}

/** Order-independent canonical form, used to detect `uniqueItems` duplicates in O(n). */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const keys = Object.keys(v as object).sort();
  return `{${keys
    .map(
      (k) =>
        `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`,
    )
    .join(",")}}`;
}

class Budget {
  private steps = 0;
  spend(n = 1): void {
    this.steps += n;
    if (this.steps > MAX_VALIDATION_STEPS)
      throw new BudgetExceeded(`value exceeds the validation work budget`);
  }
}

class BudgetExceeded extends Error {}

function check(
  s: Prepared,
  v: unknown,
  path: string,
  issues: ValidationIssue[],
  budget: Budget,
): void {
  budget.spend();
  const bad = (message: string): void => {
    issues.push({ instancePath: path, message });
  };

  if (s.always === false) return bad("is not allowed here");
  if (s.always === true) return;

  if (s.types && !s.types.some((t) => matchesType(v, t)))
    return bad(`must be ${s.types.join(" or ")}, got ${typeName(v)}`);

  if (s.enum && !s.enum.some((e) => deepEqual(e, v)))
    bad(`must be one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  if (s.hasConst && !deepEqual(s.const, v))
    bad(`must be ${JSON.stringify(s.const)}`);

  if (typeof v === "number" && Number.isFinite(v)) {
    if (s.minimum !== undefined && v < s.minimum)
      bad(`must be >= ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum)
      bad(`must be <= ${s.maximum}`);
    if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum)
      bad(`must be > ${s.exclusiveMinimum}`);
    if (s.exclusiveMaximum !== undefined && v >= s.exclusiveMaximum)
      bad(`must be < ${s.exclusiveMaximum}`);
    if (s.multipleOf !== undefined) {
      const q = v / s.multipleOf;
      if (!Number.isFinite(q) || Math.abs(q - Math.round(q)) > 1e-9)
        bad(`must be a multiple of ${s.multipleOf}`);
    }
  }

  if (typeof v === "string") {
    if (s.minLength !== undefined || s.maxLength !== undefined) {
      const len = codePointLength(v);
      if (s.minLength !== undefined && len < s.minLength)
        bad(`must NOT have fewer than ${s.minLength} characters`);
      if (s.maxLength !== undefined && len > s.maxLength)
        bad(`must NOT have more than ${s.maxLength} characters`);
    }
    if (s.pattern) {
      budget.spend(Math.min(v.length, 4096));
      // `test` returns false for inputs past MAX_PATTERN_INPUT — fail closed by design.
      if (!s.pattern.test(v)) bad(`must match pattern "${s.pattern.source}"`);
    }
    if (s.format !== undefined) {
      const fn = FORMATS[s.format];
      if (!fn || !fn(v)) bad(`must match format "${s.format}"`);
    }
  }

  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems)
      bad(`must NOT have fewer than ${s.minItems} items`);
    if (s.maxItems !== undefined && v.length > s.maxItems)
      bad(`must NOT have more than ${s.maxItems} items`);
    if (s.uniqueItems) {
      if (v.length > MAX_UNIQUE_ITEMS)
        bad(`has too many items to check for uniqueness`);
      else {
        budget.spend(v.length);
        const seen = new Set<string>();
        for (const item of v) {
          validateWork.canonicalised++;
          const key = canonical(item);
          if (seen.has(key)) {
            bad("must NOT have duplicate items");
            break;
          }
          seen.add(key);
        }
      }
    }
    if (s.items)
      for (let i = 0; i < v.length; i++)
        check(s.items, v[i], `${path}/${i}`, issues, budget);
    if (s.tuple) {
      for (let i = 0; i < Math.min(s.tuple.length, v.length); i++)
        check(s.tuple[i] as Prepared, v[i], `${path}/${i}`, issues, budget);
      if (s.additionalItems)
        for (let i = s.tuple.length; i < v.length; i++)
          check(s.additionalItems, v[i], `${path}/${i}`, issues, budget);
    }
    if (s.contains) {
      const found = v.some((item) => {
        const probe: ValidationIssue[] = [];
        check(s.contains as Prepared, item, path, probe, budget);
        return probe.length === 0;
      });
      if (!found) bad("must contain at least one matching item");
    }
  }

  if (isPlainObject(v)) {
    const keys = Object.keys(v);
    budget.spend(keys.length);
    if (s.minProperties !== undefined && keys.length < s.minProperties)
      bad(`must NOT have fewer than ${s.minProperties} properties`);
    if (s.maxProperties !== undefined && keys.length > s.maxProperties)
      bad(`must NOT have more than ${s.maxProperties} properties`);
    if (s.required)
      for (const key of s.required)
        if (!own(v, key)) bad(`must have required property "${key}"`);
    for (const key of keys) {
      const value = v[key];
      let covered = false;
      const declared = s.properties?.get(key);
      if (declared) {
        covered = true;
        check(declared, value, `${path}/${escapePointer(key)}`, issues, budget);
      }
      if (s.patternProperties)
        for (const pp of s.patternProperties)
          if (pp.re.test(key)) {
            covered = true;
            check(
              pp.schema,
              value,
              `${path}/${escapePointer(key)}`,
              issues,
              budget,
            );
          }
      if (!covered && s.additionalProperties)
        check(
          s.additionalProperties,
          value,
          `${path}/${escapePointer(key)}`,
          issues,
          budget,
        );
      if (s.propertyNames)
        check(
          s.propertyNames,
          key,
          `${path}/${escapePointer(key)}`,
          issues,
          budget,
        );
    }
  }

  if (s.allOf)
    for (const branch of s.allOf) check(branch, v, path, issues, budget);
  if (s.anyOf) {
    const ok = s.anyOf.some((branch) => passes(branch, v, path, budget));
    if (!ok) bad("must match a schema in anyOf");
  }
  if (s.oneOf) {
    let count = 0;
    for (const branch of s.oneOf) if (passes(branch, v, path, budget)) count++;
    if (count !== 1) bad("must match exactly one schema in oneOf");
  }
  if (s.not && passes(s.not, v, path, budget))
    bad("must NOT be valid against not");
  if (s.if) {
    const branch = passes(s.if, v, path, budget) ? s.then : s.else;
    if (branch) check(branch, v, path, issues, budget);
  }
}

function passes(
  s: Prepared,
  v: unknown,
  path: string,
  budget: Budget,
): boolean {
  const probe: ValidationIssue[] = [];
  check(s, v, path, probe, budget);
  return probe.length === 0;
}

function escapePointer(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Validate `value` against a prepared schema. Returns an empty array when valid. Never
 * throws: a value that blows the work budget comes back as an ordinary failure so the caller
 * prunes it rather than 500-ing.
 */
export function validatePrepared(
  prepared: PreparedSchema,
  value: unknown,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  try {
    check(prepared.root, value, "", issues, new Budget());
  } catch (e) {
    if (e instanceof BudgetExceeded)
      return [{ instancePath: "", message: e.message }];
    throw e;
  }
  return issues;
}
