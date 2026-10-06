/**
 * Go's ingest rules (F-31, tier 3): a module path, under one of the feed's module prefixes.
 *
 * A Go package release is one module version: its module zip (`go-zip`, the layout
 * `golang.org/x/mod/zip` defines: every entry under `<module>@v<version>/`) and its `go.mod`
 * (`go-mod`, served as the proxy's `.mod` answer, so the Worker never unzips). The release
 * version is the semantic version without Go's `v`, which the feed adds: release `1.4.0` is the
 * module version `v1.4.0`.
 *
 * Module paths are case-sensitive in Go (the proxy protocol case-encodes upper case as `!x`), so
 * the namespace compares them exactly; the uniqueness key is lower case all the same, so two
 * modules that differ only in case can never be published side by side (they collide on a
 * case-insensitive file system, and `golang.org/x/mod` refuses such pairs in one build).
 */

import { namespaceStrings, type PackageEcosystemRules } from "./rules.js";

/** One element after the first: letters, digits and `-._~`, never starting or ending with `.`. */
const ELEMENT = "[A-Za-z0-9_~-](?:[A-Za-z0-9._~-]*[A-Za-z0-9_~-])?";
/** The first element: a lower-case host name with at least one dot (`golang.org/x/mod` CheckPath). */
const HOST =
  "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+";

/** A Go module path (and a module prefix: the same grammar). */
export const GO_MODULE_PATH = new RegExp(`^${HOST}(?:/${ELEMENT})*$`);

/** The major-version suffix of a module path (`/v2`), or null when it has none. */
export function goPathMajor(path: string): number | null {
  const m = /\/v([0-9]+)$/.exec(path);
  return m ? Number(m[1]) : null;
}

/**
 * Why a module path cannot carry `version` (a release version: semver without the `v`), or null.
 * Go's import-compatibility rule: a v2+ module's path ends in `/v<major>`, and a v0 or v1
 * module's path carries no major suffix (`/v0`, `/v1` and a leading zero are never valid ones).
 * `+incompatible` versions are never published here.
 */
export function goMajorProblem(path: string, version: string): string | null {
  const major = Number(/^([0-9]+)\./.exec(version)?.[1] ?? NaN);
  if (!Number.isInteger(major)) return null;
  const suffix = /\/v([0-9]+)$/.exec(path)?.[1];
  if (suffix !== undefined && (suffix.startsWith("0") || Number(suffix) < 2))
    return `${path} ends in /v${suffix}, which is not a Go major-version suffix (the first is /v2).`;
  if (major >= 2 && suffix !== String(major))
    return `a v${major} Go module's path ends in /v${major}; ${path} does not.`;
  if (major < 2 && suffix !== undefined)
    return `a v${major} Go module's path carries no major suffix; ${path} ends in /v${suffix}.`;
  return null;
}

export const GO_PACKAGE_RULES: PackageEcosystemRules<"go"> = {
  ecosystem: "go",
  name: {
    pattern: GO_MODULE_PATH,
    maxLength: 255,
    // Paths are case-sensitive, but two that differ only in case must never coexist.
    norm: (name) => name.toLowerCase(),
  },
  fileTypes: ["go-zip", "go-mod"],
  // One module zip and its go.mod.
  maxFiles: 2,
  // The CLI computes both go.sum hashes (`h1:` dirhashes of the zip and of go.mod) and reads the
  // go directive; the setup page shows the hashes, so a go.sum line can be checked by hand.
  metadataKeys: ["h1", "goModH1", "goVersion"],
  namespace: {
    fields: {
      modulePrefixes: { kind: "list", pattern: GO_MODULE_PATH },
    },
    problem(name, ns) {
      const prefixes = namespaceStrings(ns.modulePrefixes);
      if (prefixes.length === 0) return "the Go feed has no module prefixes";
      return prefixes.some((p) => name === p || name.startsWith(`${p}/`))
        ? null
        : `${name} is not under ${prefixes.join(", ")}`;
    },
  },
};
