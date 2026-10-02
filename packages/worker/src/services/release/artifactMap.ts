/**
 * Map classification (P2-04, README §3.4 "declared, not sniffed").
 *
 * A product that declares `deliverables.app.artifacts` in `.pkey/release` has every release file
 * classified by that map instead of by its name's extension:
 *
 *   - a file matching an entry's `match` glob is that entry's build's file, in the entry's role
 *     (`payload` unless declared), with the entry's platform, arch and format;
 *   - `<payload>.sig` and `<payload>.sha256` are that build's signature and checksum — this
 *     wins over an entry match, since a broad glob (`Diceroll-*`) matches the sidecars too;
 *   - an entry that matches MORE than one file classifies none of them: two candidate payloads
 *     is a bad upload or a too-broad glob, and picking one would serve a guess (the
 *     `assets.ts` rule: ambiguous by design);
 *   - every other file is unclassified (no build, no platform, no arch).
 *
 * Products are data (AGENTS rule 5): nothing here knows a platform, arch or format. Filename
 * sniffing (`store.ts`) runs only when a product declares no map.
 */

import {
  matchesArtifactGlob,
  type ArtifactRole,
  type ManifestAppDeliverable,
  type ManifestArtifactEntry,
} from "@polaris-key/manifest";

export interface ClassifiedFile {
  buildId: string;
  role: ArtifactRole;
  platform: string;
  arch: string;
  format: string;
}

export interface MapClassification {
  /** File name → its build and role. Unclassified files are absent. */
  files: Map<string, ClassifiedFile>;
  /** The builds the release carries: one per entry that matched exactly one file. */
  builds: ManifestArtifactEntry[];
  /** Entry id → the files it matched, for every entry that matched MORE than one (and so
   *  classified none). Release health names these candidates; nothing serves them. */
  ambiguous: Map<string, string[]>;
  /** Entry id → the files its glob matches that an EARLIER entry claimed (first entry in
   *  declaration order wins a file). Release health explains a "missing" entry with these. */
  shadowed: Map<string, { name: string; by: string }[]>;
}

/** True when the product declares a non-empty artifact map; otherwise sniffing applies. */
export function hasArtifactMap(
  app: ManifestAppDeliverable | null | undefined,
): app is ManifestAppDeliverable {
  return !!app && app.artifacts.length > 0;
}

/** The sidecar suffixes and the role a file with one plays in its payload's build. */
const SIDECARS: readonly (readonly [string, ArtifactRole])[] = [
  [".sig", "signature"],
  [".sha256", "checksum"],
];

/** Classify a release's file names by the declared map. Pure; order-independent. */
export function classifyByMap(
  app: ManifestAppDeliverable,
  names: readonly string[],
): MapClassification {
  const all = new Set(names);
  // Sidecars first: `X.sig` beside a file `X` is X's sidecar, whatever else it matches.
  const sidecarOf = new Map<string, { stem: string; role: ArtifactRole }>();
  for (const name of all) {
    for (const [suffix, role] of SIDECARS) {
      if (name.endsWith(suffix) && all.has(name.slice(0, -suffix.length))) {
        sidecarOf.set(name, { stem: name.slice(0, -suffix.length), role });
      }
    }
  }

  // Each entry's matches, among the files that are not sidecars.
  const matchesOf = new Map<string, string[]>();
  const shadowed = new Map<string, { name: string; by: string }[]>();
  for (const name of [...all].sort()) {
    if (sidecarOf.has(name)) continue;
    // First entry in declaration order wins a file both would match.
    const matching = app.artifacts.filter((e) =>
      matchesArtifactGlob(e.match, name),
    );
    const entry = matching[0];
    if (!entry) continue;
    matchesOf.set(entry.id, [...(matchesOf.get(entry.id) ?? []), name]);
    for (const later of matching.slice(1)) {
      if (later.id === entry.id) continue;
      shadowed.set(later.id, [
        ...(shadowed.get(later.id) ?? []),
        { name, by: entry.id },
      ]);
    }
  }

  const files = new Map<string, ClassifiedFile>();
  const builds: ManifestArtifactEntry[] = [];
  const ambiguous = new Map<string, string[]>();
  for (const entry of app.artifacts) {
    const matched = matchesOf.get(entry.id) ?? [];
    if (matched.length > 1) ambiguous.set(entry.id, matched);
    if (matched.length !== 1) continue; // none, or ambiguous
    const name = matched[0]!;
    builds.push(entry);
    files.set(name, fileOf(entry, entry.role));
  }
  for (const [name, { stem, role }] of sidecarOf) {
    const owner = files.get(stem);
    // Only a PAYLOAD's sidecar joins its build; a sidecar of a sidecar or of an unclassified
    // file stays unclassified.
    if (!owner || owner.role !== "payload") continue;
    files.set(name, { ...owner, role });
  }
  return { files, builds, ambiguous, shadowed };
}

function fileOf(
  entry: ManifestArtifactEntry,
  role: ArtifactRole,
): ClassifiedFile {
  return {
    buildId: entry.id,
    role,
    platform: entry.platform,
    arch: entry.arch,
    format: entry.format,
  };
}
