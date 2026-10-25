/**
 * Godot's ingest rules (F-09): an addon id. The namespace is the store path's publisher; an
 * addon id carries none, so the feed only has to name one.
 */

import type { PackageEcosystemRules } from "./rules.js";

const GODOT_PUBLISHER = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const GODOT_PACKAGE_RULES: PackageEcosystemRules<"godot"> = {
  ecosystem: "godot",
  name: {
    // A Godot addon id.
    pattern: /^[a-z0-9_]{1,64}$/,
    maxLength: 64,
    // The grammar is lower case already.
    norm: (name) => name,
  },
  fileTypes: ["godot-zip", "godot-icon"],
  maxFiles: 64,
  metadataKeys: ["displayName", "author", "description", "script"],
  namespace: {
    fields: {
      publisher: { kind: "string", pattern: GODOT_PUBLISHER },
    },
    problem: (_name, ns) =>
      typeof ns.publisher === "string" && ns.publisher !== ""
        ? null
        : "the Godot feed has no publisher set",
    // An addon id carries no publisher, so the publisher is the owner (the product slug).
    derive(names, owner) {
      if (names.length === 0) return { namespace: {}, ambiguous: null };
      if (!GODOT_PUBLISHER.test(owner))
        return {
          namespace: {},
          ambiguous: `the owner "${owner}" is not a valid Godot publisher`,
        };
      return { namespace: { publisher: owner }, ambiguous: null };
    },
  },
};
