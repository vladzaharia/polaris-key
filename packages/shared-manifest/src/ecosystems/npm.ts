/** npm's ingest rules (F-04): scoped names only, and the scope is the feed's namespace. */

import { sortedUnique, type PackageEcosystemRules } from "./rules.js";

/** The npm scope of a scoped name (`@polaris-key/node` → `@polaris-key`), else null. */
export function npmScope(name: string): string | null {
  const m = /^(@[^/]+)\//.exec(name);
  return m ? m[1]! : null;
}

export const NPM_PACKAGE_RULES: PackageEcosystemRules<"npm"> = {
  ecosystem: "npm",
  name: {
    // A scoped npm name, lower case (unscoped names are refused: the scope is the namespace).
    pattern: /^@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*$/,
    maxLength: 214,
    // npm compares case-insensitively.
    norm: (name) => name.toLowerCase(),
  },
  fileTypes: ["npm-tarball"],
  maxFiles: 64,
  metadataKeys: [
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
  namespace: {
    fields: {
      scope: { kind: "string", pattern: /^@[a-z0-9][a-z0-9._~-]{0,213}$/ },
    },
    problem(name, ns) {
      const scope = typeof ns.scope === "string" ? ns.scope.toLowerCase() : "";
      if (!scope) return "the npm feed has no scope set";
      return npmScope(name.toLowerCase()) === scope
        ? null
        : `${name} is not under the feed's scope ${scope}`;
    },
    derive(names) {
      const scopes = sortedUnique(
        names.flatMap((n) => {
          const s = npmScope(n.toLowerCase());
          return s ? [s] : [];
        }),
      );
      if (scopes.length === 0) return { namespace: {}, ambiguous: null };
      if (scopes.length > 1)
        return {
          namespace: {},
          ambiguous: `the packages span several npm scopes (${scopes.join(", ")}); a feed takes one`,
        };
      return { namespace: { scope: scopes[0]! }, ambiguous: null };
    },
  },
};
