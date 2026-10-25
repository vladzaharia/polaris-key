/** The Swift registry's ingest rules (F-06): SE-0292 `scope.Name`, the scope is the namespace. */

import { sortedUnique, type PackageEcosystemRules } from "./rules.js";

export const SWIFT_PACKAGE_RULES: PackageEcosystemRules<"swift"> = {
  ecosystem: "swift",
  name: {
    // SE-0292: `scope.Name`, scope 1-39 of [A-Za-z0-9-], name 1-100 of [A-Za-z0-9_-], each
    // starting with a letter or digit.
    pattern: /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\.[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/,
    maxLength: 140,
    // The registry compares case-insensitively.
    norm: (name) => name.toLowerCase(),
  },
  fileTypes: ["source-archive", "manifest", "source-archive-signature"],
  maxFiles: 64,
  metadataKeys: ["toolsVersions", "signatureFormat"],
  namespace: {
    fields: {
      scope: { kind: "string", pattern: /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/ },
    },
    problem(name, ns) {
      const scope = typeof ns.scope === "string" ? ns.scope.toLowerCase() : "";
      if (!scope) return "the Swift feed has no scope set";
      return name.split(".")[0]!.toLowerCase() === scope
        ? null
        : `${name} is not under the feed's scope ${scope}`;
    },
    derive(names) {
      const scopes = sortedUnique(
        names
          .map((n) => n.split(".")[0]!.toLowerCase())
          .filter((s) => s !== ""),
      );
      if (scopes.length === 0) return { namespace: {}, ambiguous: null };
      if (scopes.length > 1)
        return {
          namespace: {},
          ambiguous: `the packages span several Swift scopes (${scopes.join(", ")}); a feed takes one`,
        };
      return { namespace: { scope: scopes[0]! }, ambiguous: null };
    },
  },
};
