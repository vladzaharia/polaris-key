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
 * Nothing here imports another module of this package, so `index.ts` and `descriptor.ts` can both
 * read it at their top level without the cycle their own NOTE describes.
 */

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

/** The name grammar of each ecosystem (plans/F-01.md §3.1), anchored. */
export const PACKAGE_NAME_PATTERNS: Readonly<Record<PackageEcosystem, RegExp>> =
  {
    // A scoped npm name, lower case (unscoped names are refused: the scope is the namespace).
    npm: /^@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*$/,
    // PEP 508: letters, digits, `.`, `_` and `-`, starting and ending with a letter or digit.
    pypi: /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/,
    // SE-0292: `scope.Name`, scope 1-39 of [A-Za-z0-9-], name 1-100 of [A-Za-z0-9_-], each
    // starting with a letter or digit.
    swift: /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\.[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/,
    // Maven `groupId:artifactId`.
    maven: /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*:[A-Za-z0-9_][A-Za-z0-9_.-]*$/,
    // An OCI repository path under the owner: lower-case components joined by `/`.
    oci: /^[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*(\/[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*)*$/,
    // A Godot addon id.
    godot: /^[a-z0-9_]{1,64}$/,
  };

/** The longest name of each ecosystem. */
export const PACKAGE_NAME_MAX_LENGTH: Readonly<
  Record<PackageEcosystem, number>
> = {
  npm: 214,
  pypi: 128,
  swift: 140,
  maven: 255,
  oci: 255,
  godot: 64,
};

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
  switch (ecosystem) {
    case "pypi":
      return name.toLowerCase().replace(/[-_.]+/g, "-");
    case "npm":
    case "swift":
    case "maven":
      return name.toLowerCase();
    default:
      return name;
  }
}

/**
 * The file types each ecosystem's package release may carry (`package.files[].type`, plans/F-01.md
 * §3.2). The renderers of F-04 to F-09 key on these.
 */
export const PACKAGE_FILE_TYPES: Readonly<
  Record<PackageEcosystem, readonly string[]>
> = {
  npm: ["npm-tarball"],
  pypi: ["wheel", "sdist", "core-metadata"],
  swift: ["source-archive", "manifest", "source-archive-signature"],
  maven: ["maven-file"],
  oci: ["oci-blob", "oci-manifest", "oci-index"],
  godot: ["godot-zip", "godot-icon"],
};

/** At most this many files in one package release: 4,096 for OCI (an image's blobs), else 64. */
export function maxPackageFiles(ecosystem: PackageEcosystem): number {
  return ecosystem === "oci" ? 4096 : 64;
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
> = {
  npm: [
    "description",
    "license",
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
    "engines",
    "bin",
    "exports",
    "main",
    "types",
    "os",
    "cpu",
    "keywords",
    "homepage",
    "repository",
  ],
  pypi: ["summary", "requiresPython", "license"],
  swift: ["toolsVersions", "signatureFormat"],
  maven: ["groupId", "artifactId", "packaging"],
  // `root`: the digest of the manifest or index the version's tag points to.
  oci: ["mediaType", "platforms", "root"],
  godot: ["displayName", "author", "description", "script"],
};

/** The npm scope of a scoped name (`@polaris-key/node` → `@polaris-key`), else null. */
export function npmScope(name: string): string | null {
  const m = /^(@[^/]+)\//.exec(name);
  return m ? m[1]! : null;
}

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
  const strings = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && x !== "")
      : [];
  switch (ecosystem) {
    case "npm": {
      const scope = typeof ns.scope === "string" ? ns.scope.toLowerCase() : "";
      if (!scope) return "the npm feed has no scope set";
      return npmScope(name.toLowerCase()) === scope
        ? null
        : `${name} is not under the feed's scope ${scope}`;
    }
    case "swift": {
      const scope = typeof ns.scope === "string" ? ns.scope.toLowerCase() : "";
      if (!scope) return "the Swift feed has no scope set";
      return name.split(".")[0]!.toLowerCase() === scope
        ? null
        : `${name} is not under the feed's scope ${scope}`;
    }
    case "maven": {
      const prefixes = strings(ns.groupPrefixes).map((p) => p.toLowerCase());
      if (prefixes.length === 0) return "the Maven feed has no group prefixes";
      const group = name.split(":")[0]!.toLowerCase();
      return prefixes.some((p) => group === p || group.startsWith(`${p}.`))
        ? null
        : `${name}'s groupId is not under ${prefixes.join(", ")}`;
    }
    case "pypi": {
      const norm = packageNameNorm("pypi", name);
      const names = strings(ns.names).map((n) => packageNameNorm("pypi", n));
      const prefixes = strings(ns.prefixes).map((n) =>
        packageNameNorm("pypi", n),
      );
      if (names.length === 0 && prefixes.length === 0)
        return "the PyPI feed has no names or prefixes";
      return names.includes(norm) || prefixes.some((p) => norm.startsWith(p))
        ? null
        : `${name} is not one of the feed's names or prefixes`;
    }
    case "oci":
      return null;
    case "godot":
      return typeof ns.publisher === "string" && ns.publisher !== ""
        ? null
        : "the Godot feed has no publisher set";
  }
}
