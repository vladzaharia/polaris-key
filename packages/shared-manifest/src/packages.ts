/**
 * Package deliverables (F-03, plans/F-01.md §3): the vocabulary a `kind: "package"` deliverable
 * and its release descriptor are checked against. A package is a Release deliverable of a third
 * kind, beside `app` and `pack`; each version is a release of it, served only by the package
 * feeds on `pkg.plrs.im` (never by a device-facing route).
 *
 * This module holds constants and pure grammar only. The rules that USE them live in the
 * validators (`index.ts`'s `validateDeliverables`, `descriptor.ts`'s package branch,
 * `distribution.ts`'s transport refusal), whose codes the schema-parity sweep reads.
 *
 * Nothing here imports another module of this package but the per-ecosystem rule files
 * (`ecosystems/*.ts`, which import nothing but each other's `rules.ts`), so `index.ts` and
 * `descriptor.ts` can both read it at their top level without the cycle their own NOTE describes.
 * Each ecosystem declares its rules once, in its own `ecosystems/<ecosystem>.ts`; the tables
 * below are derived from `PACKAGE_ECOSYSTEM_RULES`.
 */

import { GODOT_PACKAGE_RULES } from "./ecosystems/godot.js";
import { MAVEN_PACKAGE_RULES } from "./ecosystems/maven.js";
import { NPM_PACKAGE_RULES } from "./ecosystems/npm.js";
import { OCI_PACKAGE_RULES } from "./ecosystems/oci.js";
import { PYPI_PACKAGE_RULES } from "./ecosystems/pypi.js";
import {
  namespaceIsEmpty,
  type PackageEcosystemRules,
} from "./ecosystems/rules.js";
import { SWIFT_PACKAGE_RULES } from "./ecosystems/swift.js";

export { npmScope } from "./ecosystems/npm.js";
export {
  namespaceIsEmpty,
  namespaceStrings,
  type PackageEcosystemRules,
  type PackageNamespaceField,
} from "./ecosystems/rules.js";

/**
 * The ecosystems a package feed serves (tier 1). Open for `cargo`, `go` and `nuget` in tier 3:
 * each new ecosystem is its own rule-9 change (validator, schema, mutation rows).
 */
export const PACKAGE_ECOSYSTEMS = [
  "npm",
  "pypi",
  "swift",
  "maven",
  "oci",
  "godot",
] as const;
export type PackageEcosystem = (typeof PACKAGE_ECOSYSTEMS)[number];

/**
 * The platform's own product, which owns the platform packages (our SDKs, the CLI image). Not a
 * reserved slug: `RESERVED_PRODUCT_SLUGS` is refused by the manifest validator and skipped by the
 * router, which would make the monorepo's own `.pkey/` invalid. Only the bootstrap action
 * (`ensureSystemProduct`) creates its row; a manual create refuses the slug (`reserved_slug`).
 */
export const SYSTEM_PRODUCT_SLUG = "polaris-key";

/**
 * At most this many package deliverables per `.pkey/release` (`too_many_package_deliverables`),
 * counted before any is validated, like packs.
 */
export const MAX_PACKAGE_DELIVERABLES = 64;

/** At most this many `artifacts` entries per package deliverable. */
export const MAX_PACKAGE_ARTIFACT_ENTRIES = 16;

/**
 * Fields of an app or pack deliverable that a package never takes (`invalid_package_field`): a
 * package has no platform, arch or format (its ecosystem says what it is), no content and no
 * pack binding or type.
 */
export const PACKAGE_REFUSED_FIELDS = [
  "platform",
  "arch",
  "format",
  "content",
  "binding",
  "type",
  "packType",
] as const;

/**
 * Every ecosystem's ingest rules, one declaration each (`ecosystems/<ecosystem>.ts`, through the
 * `PackageEcosystemRules` entry point). The mapped type makes a new `PACKAGE_ECOSYSTEMS` entry a
 * compile error until its rules exist. Every table below is derived from this one.
 */
export const PACKAGE_ECOSYSTEM_RULES: {
  readonly [E in PackageEcosystem]: PackageEcosystemRules<E>;
} = {
  npm: NPM_PACKAGE_RULES,
  pypi: PYPI_PACKAGE_RULES,
  swift: SWIFT_PACKAGE_RULES,
  maven: MAVEN_PACKAGE_RULES,
  oci: OCI_PACKAGE_RULES,
  godot: GODOT_PACKAGE_RULES,
};

function perEcosystem<T>(
  pick: (rules: PackageEcosystemRules) => T,
): Readonly<Record<PackageEcosystem, T>> {
  return Object.fromEntries(
    PACKAGE_ECOSYSTEMS.map((e) => [e, pick(PACKAGE_ECOSYSTEM_RULES[e])]),
  ) as Record<PackageEcosystem, T>;
}

/** The name grammar of each ecosystem (plans/F-01.md §3.1), anchored. */
export const PACKAGE_NAME_PATTERNS: Readonly<Record<PackageEcosystem, RegExp>> =
  perEcosystem((r) => r.name.pattern);

/** The longest name of each ecosystem. */
export const PACKAGE_NAME_MAX_LENGTH: Readonly<
  Record<PackageEcosystem, number>
> = perEcosystem((r) => r.name.maxLength);

export function isPackageEcosystem(value: unknown): value is PackageEcosystem {
  return (
    typeof value === "string" &&
    (PACKAGE_ECOSYSTEMS as readonly string[]).includes(value)
  );
}

/** Does `name` follow `ecosystem`'s name grammar? */
export function isPackageName(
  ecosystem: PackageEcosystem,
  name: unknown,
): name is string {
  return (
    typeof name === "string" &&
    name.length <= PACKAGE_NAME_MAX_LENGTH[ecosystem] &&
    PACKAGE_NAME_PATTERNS[ecosystem].test(name)
  );
}

/**
 * The key two names of one ecosystem collide on, and the uniqueness key of
 * `release_packages.name_norm`: PEP 503 for PyPI (lower case, runs of `-_.` become `-`), lower
 * case for npm, Swift and Maven (their registries compare case-insensitively), and the name
 * itself for OCI and Godot, whose grammars are lower case already.
 */
export function packageNameNorm(
  ecosystem: PackageEcosystem,
  name: string,
): string {
  return PACKAGE_ECOSYSTEM_RULES[ecosystem].name.norm(name);
}

/**
 * The file types each ecosystem's package release may carry (`package.files[].type`, plans/F-01.md
 * §3.2). The renderers of F-04 to F-09 key on these.
 */
export const PACKAGE_FILE_TYPES: Readonly<
  Record<PackageEcosystem, readonly string[]>
> = perEcosystem((r) => r.fileTypes);

/** At most this many files in one package release: 4,096 for OCI (an image's blobs), else 64. */
export function maxPackageFiles(ecosystem: PackageEcosystem): number {
  return PACKAGE_ECOSYSTEM_RULES[ecosystem].maxFiles;
}

/** The largest `package.metadata`, serialised (16 KiB). */
export const MAX_PACKAGE_METADATA_BYTES = 16 * 1024;

/**
 * The keys an ecosystem's `package.metadata` may carry besides `name` and `version` (which every
 * ecosystem's must carry, equal to the declaration and the descriptor). The CLI's extractors
 * write exactly these (`packages/cli/src/package/`); the Worker never unzips to check them.
 */
export const PACKAGE_METADATA_KEYS: Readonly<
  Record<PackageEcosystem, readonly string[]>
> = perEcosystem((r) => r.metadataKeys);

/**
 * Why `name` falls outside a feed's namespace, or null when it is inside (plans/F-01.md §6.7, the
 * dependency-confusion rule ingest enforces). `namespace` is `dist_registry_feeds.namespace_json`:
 * npm `{scope}`, Swift `{scope}`, Maven `{groupPrefixes[]}`, PyPI `{prefixes[], names[]}`, OCI `{}`
 * (the repository sits under the owner in every URL), Godot `{publisher}` (the store path's
 * publisher; an addon id carries none, so the feed only has to name one). An empty namespace is a
 * problem: a feed cannot take packages before its operator sets one.
 */
export function packageNamespaceProblem(
  ecosystem: PackageEcosystem,
  name: string,
  namespace: unknown,
): string | null {
  const ns =
    namespace !== null &&
    typeof namespace === "object" &&
    !Array.isArray(namespace)
      ? (namespace as Record<string, unknown>)
      : {};
  return PACKAGE_ECOSYSTEM_RULES[ecosystem].namespace.problem(name, ns);
}

/** Is a feed's namespace empty, so the feed cannot be enabled? (OCI's never is.) */
export function packageNamespaceEmpty(
  ecosystem: PackageEcosystem,
  namespace: Readonly<Record<string, unknown>>,
): boolean {
  return namespaceIsEmpty(PACKAGE_ECOSYSTEM_RULES[ecosystem], namespace);
}
