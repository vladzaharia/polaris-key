/** PyPI's ingest rules (F-05): PEP 508 names, PEP 503 normalisation, names or prefixes. */

import { namespaceStrings, type PackageEcosystemRules } from "./rules.js";

/** PEP 503: lower case, runs of `-_.` become `-`. */
function pep503(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

const PYPI_NAME = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export const PYPI_PACKAGE_RULES: PackageEcosystemRules<"pypi"> = {
  ecosystem: "pypi",
  name: {
    // PEP 508: letters, digits, `.`, `_` and `-`, starting and ending with a letter or digit.
    pattern: PYPI_NAME,
    maxLength: 128,
    norm: pep503,
  },
  fileTypes: ["wheel", "sdist", "core-metadata"],
  maxFiles: 64,
  metadataKeys: ["summary", "requiresPython", "license"],
  namespace: {
    fields: {
      prefixes: { kind: "list", pattern: PYPI_NAME },
      names: { kind: "list", pattern: PYPI_NAME },
    },
    problem(name, ns) {
      const norm = pep503(name);
      const names = namespaceStrings(ns.names).map(pep503);
      const prefixes = namespaceStrings(ns.prefixes).map(pep503);
      if (names.length === 0 && prefixes.length === 0)
        return "the PyPI feed has no names or prefixes";
      return names.includes(norm) || prefixes.some((p) => norm.startsWith(p))
        ? null
        : `${name} is not one of the feed's names or prefixes`;
    },
  },
};
