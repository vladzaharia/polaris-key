/** Maven's ingest rules (F-07): `groupId:artifactId`, the groupId under the feed's prefixes. */

import { namespaceStrings, type PackageEcosystemRules } from "./rules.js";

export const MAVEN_PACKAGE_RULES: PackageEcosystemRules<"maven"> = {
  ecosystem: "maven",
  name: {
    // Maven `groupId:artifactId`.
    pattern: /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*:[A-Za-z0-9_][A-Za-z0-9_.-]*$/,
    maxLength: 255,
    // Repositories compare case-insensitively.
    norm: (name) => name.toLowerCase(),
  },
  fileTypes: ["maven-file"],
  maxFiles: 64,
  metadataKeys: ["groupId", "artifactId", "packaging"],
  namespace: {
    fields: {
      groupPrefixes: {
        kind: "list",
        pattern: /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/,
      },
    },
    problem(name, ns) {
      const prefixes = namespaceStrings(ns.groupPrefixes).map((p) =>
        p.toLowerCase(),
      );
      if (prefixes.length === 0) return "the Maven feed has no group prefixes";
      const group = name.split(":")[0]!.toLowerCase();
      return prefixes.some((p) => group === p || group.startsWith(`${p}.`))
        ? null
        : `${name}'s groupId is not under ${prefixes.join(", ")}`;
    },
  },
};
