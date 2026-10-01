// A loaded product catalog: lookups + single-sourced schema validation. Ported from djdl's
// `configSchemaValidate.ts` but made per-instance (multi-product) and workerd-safe.
//
// WORKERD. Validation *interprets* each schema fragment (`./validate.js`); it never generates
// code. That is not an optimisation, it is the only thing that works: Ajv validates by
// building JavaScript source and passing it to the `Function` constructor, and workerd allows
// code generation from strings only during the startup window. Catalogs are read
// asynchronously from D1, i.e. only ever mid-request, so an Ajv validator for a catalog can
// never be compiled legally — `GET /<product>/config` 500'd on every poll
// (docs/security/findings/R10-dos.md §R10-01, verified on real workerd in VERIFY-R10-01.md).
// Caching a `Catalog` per product+schemaVersion, which an older version of this header
// recommended, does not fix that; it only turns a per-request throw into a per-isolate one.
//
// `compileAll()` survives with a narrower meaning: eagerly *analyse* every fragment so a
// malformed, unsupported, or ReDoS-prone one is rejected at publish time (422) instead of
// silently pruning values later. It is now cheap and side-effect free.

import {
  prepareSchema,
  UnsupportedSchemaError,
  validatePrepared,
  type PreparedSchema,
} from "./validate.js";
import type { ConfigEntry, ConfigKind, ProductCatalog } from "./types.js";
import {
  describeRepresentabilityIssue,
  representabilityIssue,
  type RepresentabilityIssue,
} from "./representable.js";

/**
 * A failed validation carries `representability` when the value breaks one of the five
 * representability rules (`representabilityIssue`), so a write path can answer
 * `value_not_representable` rather than a schema failure.
 */
export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: string[]; representability?: RepresentabilityIssue };

/** A fragment that failed analysis: every value under it is invalid, and we say why once. */
interface RejectedSchema {
  readonly rejected: string;
}

type Analysed = PreparedSchema | RejectedSchema;

function isRejected(a: Analysed): a is RejectedSchema {
  return (a as RejectedSchema).rejected !== undefined;
}

export class Catalog {
  readonly schemaVersion: number;
  readonly entries: readonly ConfigEntry[];

  private readonly byKey: Map<string, ConfigEntry>;
  private readonly analysed = new Map<string, Analysed>();

  constructor(catalog: ProductCatalog) {
    this.schemaVersion = catalog.schemaVersion;
    this.entries = catalog.entries;
    this.byKey = new Map(catalog.entries.map((e) => [e.key, e]));
  }

  entryByKey(key: string): ConfigEntry | undefined {
    return this.byKey.get(key);
  }

  entriesByKind(kind: ConfigKind): ConfigEntry[] {
    return this.entries.filter((e) => e.kind === kind);
  }

  categories(): string[] {
    const seen: string[] = [];
    for (const e of this.entries)
      if (!seen.includes(e.category)) seen.push(e.category);
    return seen;
  }

  /**
   * Analyse every entry's schema, throwing on the first one this validator will not accept.
   * Call it on any path that *publishes* a catalog so operators get told at publish time;
   * request-time validation never calls it and never throws.
   */
  compileAll(): void {
    for (const entry of this.entries) {
      const result = this.analyse(entry);
      if (isRejected(result))
        throw new UnsupportedSchemaError(`${entry.key}: ${result.rejected}`);
    }
  }

  private analyse(entry: ConfigEntry): Analysed {
    let result = this.analysed.get(entry.key);
    if (!result) {
      try {
        result = prepareSchema(entry.schema);
      } catch (e) {
        result = {
          rejected:
            e instanceof Error ? e.message : "schema could not be interpreted",
        };
      }
      this.analysed.set(entry.key, result);
    }
    return result;
  }

  /**
   * Validate a value against a known entry's schema fragment. Representability runs first
   * (plans/P3-01.md §2.2): a value no signed document could carry is invalid whatever its
   * schema says, so the write paths refuse it and the catalog prune drops one already stored.
   */
  validateEntryValue(entry: ConfigEntry, value: unknown): ValidationResult {
    const issue = representabilityIssue(value);
    if (issue)
      return {
        ok: false,
        errors: [describeRepresentabilityIssue(issue, entry.key)],
        representability: issue,
      };
    const analysed = this.analyse(entry);
    // Fail closed: an uninterpretable fragment must not be read as "no constraints".
    if (isRejected(analysed))
      return { ok: false, errors: [`${entry.key} ${analysed.rejected}`] };
    const issues = validatePrepared(analysed, value);
    if (issues.length === 0) return { ok: true };
    return {
      ok: false,
      errors: issues.map((i) => `${entry.key}${i.instancePath} ${i.message}`),
    };
  }

  /** Validate a value for a dotted key. An unknown key is rejected — admins assign
   *  values to predeclared keys, never invent keys. Returns the matched entry on success. */
  validateKeyValue(
    key: string,
    value: unknown,
  ): ValidationResult & { entry?: ConfigEntry } {
    const entry = this.byKey.get(key);
    if (!entry) return { ok: false, errors: [`unknown config key: ${key}`] };
    const res = this.validateEntryValue(entry, value);
    return res.ok ? { ok: true, entry } : { ...res, entry };
  }
}
