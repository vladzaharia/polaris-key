/** npm's ingest rules (F-04): scoped names only, and the scope is the feed's namespace. */

import type { PackageEcosystemRules } from "./rules.js";

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
  },
};
