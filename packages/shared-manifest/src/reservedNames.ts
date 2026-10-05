/**
 * Reserved entitlement names (S-19 §7.4, decision 15; G13).
 *
 * The Worker injects a few system keys into every licence document's `entitlements` after the
 * profile and override merge (`packages/worker/src/core/entitlements.ts`): `channels`,
 * `deviceLimit`, `app.minVersion`, `app.maxVersion`, `license.tier` and `license.tierLabel`. They
 * share one namespace with the product's own catalog `flag` entries, so a product flag of the same
 * name is silently overwritten. This module is the ONE place that knows which names are reserved
 * and what a compatible declaration of one looks like; the manifest validator, the Worker's
 * console write paths and the platform "Reserved names" report all ask it.
 *
 * A **compatible** declaration stays valid forever: it matches the system key's type (`channels`
 * an array of strings, `deviceLimit` an integer, the `app.*` and `license.*` keys strings), may
 * narrow it (`enum`, `pattern`, bounds, `uniqueItems`) and may carry presentation fields (`label`,
 * `category`, `description`, `default`, `examples`, `ui`, `userGrant`, `grantLabel`). djdl's four
 * declarations are compatible. An **incompatible** one is reported with the severity of the
 * platform setting `LICENSING_RESERVED_NAMES` (`licensing.reservedNames` in S-19): `warn` during
 * the window decision 15 sets (two minor releases or 60 days, whichever is later), then `error`
 * (LX-05b flips it).
 *
 * The `license.`, `app.` and `pkey.` prefixes are reserved for future system keys. A declaration
 * under `app.` that is a string is compatible (the `app.*` keys are semver strings); any other
 * name under `license.` or `pkey.` that is not a known system key is incompatible, because no
 * declaration can be compatible with a key that does not exist yet.
 *
 * Only `flag` entries are judged: config and secret keys live in their own documents and never
 * collide with an entitlement.
 */

/** The severity an incompatible reserved-name declaration is reported with. */
export const RESERVED_NAMES_MODES = ["warn", "error"] as const;
export type ReservedNamesMode = (typeof RESERVED_NAMES_MODES)[number];
/** The mode during decision 15's window, and wherever the platform setting cannot be read. */
export const DEFAULT_RESERVED_NAMES_MODE: ReservedNamesMode = "warn";

export function isReservedNamesMode(v: unknown): v is ReservedNamesMode {
  return v === "warn" || v === "error";
}

/** The JSON type a reserved key's declaration must have. */
export type ReservedKeyType = "string" | "integer" | "string-array";

export interface ReservedEntitlementKey {
  key: string;
  type: ReservedKeyType;
  /** How the Worker sets it (shown read-only in the console). */
  rule: string;
}

/** The system keys the Worker injects today (S-19 §7.4 "Reserved policy keys"). */
export const RESERVED_ENTITLEMENT_KEYS: readonly ReservedEntitlementKey[] = [
  {
    key: "channels",
    type: "string-array",
    rule: "The union of the tier's and the license's channels.",
  },
  {
    key: "deviceLimit",
    type: "integer",
    rule: "The tier's device limit, else the license's, else the product default.",
  },
  {
    key: "app.minVersion",
    type: "string",
    rule: "The lower of the tier's and the license's minimum version.",
  },
  {
    key: "app.maxVersion",
    type: "string",
    rule: "The higher of the tier's and the license's maximum version.",
  },
  {
    key: "license.tier",
    type: "string",
    rule: "The license's tier id.",
  },
  {
    key: "license.tierLabel",
    type: "string",
    rule: "The license's tier label.",
  },
];

/** Prefixes reserved for future system keys. */
export const RESERVED_ENTITLEMENT_PREFIXES = [
  "license.",
  "app.",
  "pkey.",
] as const;

const BY_KEY: ReadonlyMap<string, ReservedEntitlementKey> = new Map(
  RESERVED_ENTITLEMENT_KEYS.map((k) => [k.key, k]),
);

/** True for a system key or any name under a reserved prefix. */
export function isReservedEntitlementName(key: string): boolean {
  return (
    BY_KEY.has(key) ||
    RESERVED_ENTITLEMENT_PREFIXES.some((p) => key.startsWith(p))
  );
}

/** Entry fields a compatible declaration may carry. */
const ENTRY_FIELDS: ReadonlySet<string> = new Set([
  "key",
  "kind",
  "schema",
  "label",
  "category",
  "description",
  "default",
  "examples",
  "ui",
  "userGrant",
  "grantLabel",
]);

/** Schema keywords that only annotate. */
const ANNOTATIONS = ["title", "description", "default", "examples", "$comment"];

/** Schema keywords each type may use: the type itself, annotations, and narrowing keywords. */
const STRING_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  ...ANNOTATIONS,
  "enum",
  "const",
  "pattern",
  "minLength",
  "maxLength",
  "format",
]);
const INTEGER_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  ...ANNOTATIONS,
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);
const ARRAY_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  ...ANNOTATIONS,
  "items",
  "uniqueItems",
  "minItems",
  "maxItems",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function valueMatches(type: ReservedKeyType, v: unknown): boolean {
  if (type === "string") return typeof v === "string";
  if (type === "integer") return Number.isSafeInteger(v);
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

const TYPE_WORDS: Record<ReservedKeyType, string> = {
  string: "a string",
  integer: "an integer",
  "string-array": "an array of strings",
};

/** The first keyword of `schema` outside `allowed`, or `undefined`. */
function extraKeyword(
  schema: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): string | undefined {
  return Object.keys(schema).find((k) => !allowed.has(k));
}

/** Why `schema` is not a narrowing of a `type` value; `null` when it is. */
function schemaProblem(
  type: ReservedKeyType,
  schema: unknown,
  where = "schema",
): string | null {
  if (!isRecord(schema)) return `${where} must be an object`;
  const want =
    type === "string" ? "string" : type === "integer" ? "integer" : "array";
  if (schema.type !== want)
    return `${where}.type must be "${want}" (the system key is ${TYPE_WORDS[type]})`;
  const allowed =
    type === "string"
      ? STRING_KEYWORDS
      : type === "integer"
        ? INTEGER_KEYWORDS
        : ARRAY_KEYWORDS;
  const extra = extraKeyword(schema, allowed);
  if (extra !== undefined)
    return `${where}.${extra} is not a narrowing keyword the system key allows`;
  if (type === "string-array") {
    const items = schemaProblem("string", schema.items, `${where}.items`);
    if (items !== null) return items;
  }
  for (const k of ["enum", "examples"] as const) {
    const list = schema[k];
    if (list !== undefined) {
      if (!Array.isArray(list) || !list.every((v) => valueMatches(type, v)))
        return `${where}.${k} must list ${TYPE_WORDS[type]} values`;
    }
  }
  for (const k of ["const", "default"] as const) {
    if (schema[k] !== undefined && !valueMatches(type, schema[k]))
      return `${where}.${k} must be ${TYPE_WORDS[type]}`;
  }
  return null;
}

/** The type a reserved name's declaration must have; `null` when the name has no compatible form. */
function requiredType(key: string): ReservedKeyType | null {
  const known = BY_KEY.get(key);
  if (known) return known.type;
  if (key.startsWith("app.")) return "string";
  return null;
}

/**
 * Why a catalog entry is an incompatible declaration of a reserved name, or `null` when it is not
 * a reserved-name declaration at all or is a compatible one.
 */
export function reservedNameProblem(entry: unknown): string | null {
  if (!isRecord(entry) || entry.kind !== "flag") return null;
  const key = entry.key;
  if (typeof key !== "string" || !isReservedEntitlementName(key)) return null;
  const type = requiredType(key);
  if (type === null) {
    const prefix = RESERVED_ENTITLEMENT_PREFIXES.find((p) => key.startsWith(p));
    return `the "${prefix}" prefix is reserved for future system keys; rename the flag`;
  }
  const field = Object.keys(entry).find((f) => !ENTRY_FIELDS.has(f));
  if (field !== undefined)
    return `${field} is not allowed on a reserved key, whose rule the platform fixes`;
  const schema = schemaProblem(type, entry.schema);
  if (schema !== null) return schema;
  if (entry.default !== undefined && !valueMatches(type, entry.default))
    return `default must be ${TYPE_WORDS[type]}`;
  return null;
}

export interface ReservedNameDeclaration {
  /** The entry's index in `entries`. */
  index: number;
  key: string;
  compatible: boolean;
  /** Why it is incompatible; `null` when compatible. */
  problem: string | null;
}

/** Every `flag` entry of a catalog that declares a reserved name, judged. */
export function reservedNameDeclarations(
  catalog: unknown,
): ReservedNameDeclaration[] {
  const entries = isRecord(catalog)
    ? Array.isArray(catalog.entries)
      ? catalog.entries
      : Array.isArray(catalog.catalog)
        ? catalog.catalog
        : []
    : [];
  const out: ReservedNameDeclaration[] = [];
  entries.forEach((entry: unknown, index) => {
    if (
      !isRecord(entry) ||
      entry.kind !== "flag" ||
      typeof entry.key !== "string" ||
      !isReservedEntitlementName(entry.key)
    )
      return;
    const problem = reservedNameProblem(entry);
    out.push({ index, key: entry.key, compatible: problem === null, problem });
  });
  return out;
}

/** The one-line message for an incompatible declaration (validator and Worker share it). */
export function reservedNameMessage(
  decl: ReservedNameDeclaration,
  mode: ReservedNamesMode,
): string {
  const tail =
    mode === "error"
      ? "Incompatible reserved-name declarations are refused on this platform."
      : "This is a warning for now; it becomes an error when the platform switches licensing.reservedNames to error.";
  return `${decl.key} is a reserved entitlement name the platform sets itself: ${decl.problem}. ${tail}`;
}
