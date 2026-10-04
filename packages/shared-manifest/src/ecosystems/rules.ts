/**
 * The ONE entry point through which a package feed declares its ingest rules (F-03's vocabulary,
 * regrouped per ecosystem by the feed-adapter contract): its name grammar and normalisation, the
 * file types and metadata keys a release may carry, and its namespace (the keys a feed's
 * `namespace_json` takes, and the dependency-confusion rule ingest enforces against them).
 *
 * Each ecosystem has one file beside this one (`npm.ts`, `pypi.ts`, …) that exports one
 * `PackageEcosystemRules`, and `../packages.ts` collects them into `PACKAGE_ECOSYSTEM_RULES` and
 * derives every older per-ecosystem table from it. The Worker's feed adapter for the ecosystem
 * (`packages/worker/src/services/distribution/registry/<ecosystem>/index.ts`) points at the same
 * object, so the manifest validator, the Worker's ingest and the console's settings validation
 * all read one declaration. Adding an ecosystem is still a rule-9 change: the validators'
 * codes, the JSON Schemas and the mutation table do not change shape, but the enum does.
 *
 * Nothing here imports another module of this package (the cycle `packages.ts` describes).
 */

/** One key of a feed's namespace: a single string, or a list of strings, each matching `pattern`. */
export interface PackageNamespaceField {
  readonly kind: "string" | "list";
  /** The grammar an operator's value must match (anchored). */
  readonly pattern: RegExp;
}

/** Everything ingest and the console know about one ecosystem's packages. */
export interface PackageEcosystemRules<E extends string = string> {
  readonly ecosystem: E;
  /** The name grammar (plans/F-01.md §3.1) and the key two names collide on. */
  readonly name: {
    readonly pattern: RegExp;
    readonly maxLength: number;
    /** The uniqueness key (`release_packages.name_norm`). */
    norm(name: string): string;
  };
  /** `package.files[].type` values a release may carry (plans/F-01.md §3.2). */
  readonly fileTypes: readonly string[];
  /** At most this many files in one release. */
  readonly maxFiles: number;
  /** `package.metadata` keys besides `name` and `version`. */
  readonly metadataKeys: readonly string[];
  readonly namespace: {
    /** The keys `dist_registry_feeds.namespace_json` may carry, and each one's grammar. An
     *  ecosystem with none (OCI: the repository sits under the owner) is never "empty". */
    readonly fields: Readonly<Record<string, PackageNamespaceField>>;
    /** Why `name` falls outside the namespace `ns`, or `null` when it is inside. An empty
     *  namespace is a problem: a feed takes no packages before its operator sets one. */
    problem(name: string, ns: Readonly<Record<string, unknown>>): string | null;
  };
}

/** The non-empty strings of a namespace list value. */
export function namespaceStrings(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x !== "")
    : [];
}

/** Is a namespace empty: every declared field unset (never, for an ecosystem with no fields)? */
export function namespaceIsEmpty(
  rules: PackageEcosystemRules,
  ns: Readonly<Record<string, unknown>>,
): boolean {
  const fields = Object.entries(rules.namespace.fields);
  if (fields.length === 0) return false;
  return fields.every(([key, field]) => {
    const v = ns[key];
    return field.kind === "string"
      ? typeof v !== "string" || v === ""
      : !Array.isArray(v) || v.length === 0;
  });
}
