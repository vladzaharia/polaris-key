/**
 * Cargo's ingest rules (F-30): a crate name. The namespace is the owner itself: every crate sits
 * in the owner's own sparse index (`/cargo/<owner>/`) and Cargo routes each dependency to a
 * registry only through its explicit `registry = "…"` key, so the feed declares no namespace
 * keys and nothing is outside.
 */

import type { PackageEcosystemRules } from "./rules.js";

/**
 * crates.io's uniqueness key: names compare case-insensitively and with `-` and `_` equal, so
 * `Foo_Bar` and `foo-bar` are one crate. The index file path is the name in lower case, which the
 * feed derives on its own (`registry/cargo/render.ts`).
 */
function crateNorm(name: string): string {
  return name.toLowerCase().replace(/_/g, "-");
}

export const CARGO_PACKAGE_RULES: PackageEcosystemRules<"cargo"> = {
  ecosystem: "cargo",
  name: {
    // crates.io's grammar: an ASCII letter, then letters, digits, `-` and `_`, at most 64.
    pattern: /^[A-Za-z][A-Za-z0-9_-]{0,63}$/,
    maxLength: 64,
    norm: crateNorm,
  },
  // One `cargo package` output per version.
  fileTypes: ["crate"],
  maxFiles: 1,
  // What the index line needs from the normalised Cargo.toml (the CLI's extractor reads it):
  // the dependency list, the feature table, `links` and `rust-version`.
  metadataKeys: [
    "description",
    "license",
    "rustVersion",
    "links",
    "deps",
    "features",
  ],
  namespace: {
    fields: {},
    problem: () => null,
  },
};
