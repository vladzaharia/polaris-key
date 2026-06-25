// A loaded product catalog: lookups + single-sourced Ajv validation. Ported from djdl's
// `configSchemaValidate.ts` but made per-instance (multi-product) and workerd-safe.
//
// workerd compiles Ajv validators only during the startup window (Ajv generates JS at
// runtime, which workerd forbids inside a request). Call `compileAll()` when a catalog is
// first loaded (cache the Catalog per product+schemaVersion) so request-time validation
// never triggers a compile. Node/tests can rely on lazy compilation.

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type { ConfigEntry, ConfigKind, ProductCatalog } from "./types.js";

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

export class Catalog {
  readonly schemaVersion: number;
  readonly entries: readonly ConfigEntry[];

  private readonly byKey: Map<string, ConfigEntry>;
  private readonly ajv: Ajv;
  private readonly compiled = new Map<string, ValidateFunction>();

  constructor(catalog: ProductCatalog) {
    this.schemaVersion = catalog.schemaVersion;
    this.entries = catalog.entries;
    this.byKey = new Map(catalog.entries.map((e) => [e.key, e]));
    // strict:false matches djdl — catalog fragments carry a few non-validation keywords.
    this.ajv = addFormats(new Ajv({ allErrors: true, strict: false }));
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

  /** Eagerly compile every validator (call once at load, before request handling). */
  compileAll(): void {
    for (const entry of this.entries) this.validatorFor(entry);
  }

  private validatorFor(entry: ConfigEntry): ValidateFunction {
    let fn = this.compiled.get(entry.key);
    if (!fn) {
      fn = this.ajv.compile(entry.schema);
      this.compiled.set(entry.key, fn);
    }
    return fn;
  }

  /** Validate a value against a known entry's schema fragment. */
  validateEntryValue(entry: ConfigEntry, value: unknown): ValidationResult {
    const fn = this.validatorFor(entry);
    if (fn(value)) return { ok: true };
    const errors = (fn.errors ?? []).map(
      (e) => `${entry.key}${e.instancePath ?? ""} ${e.message ?? "is invalid"}`,
    );
    return {
      ok: false,
      errors: errors.length ? errors : [`${entry.key} is invalid`],
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
