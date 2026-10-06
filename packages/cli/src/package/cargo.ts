/**
 * Cargo (F-30's feed): one `cargo package` output, `<name>-<version>.crate`. Its normalised
 * `<name>-<version>/Cargo.toml` gives the name, the version and what the sparse index needs for
 * each version: the dependencies (every kind, every target), the feature table, `links` and
 * `rust-version` (plans/F-01.md §6.8). The Worker never unpacks the crate: the index line is
 * rendered from this metadata alone.
 *
 * A dependency's registry is what `cargo package` wrote: no `registry-index` means crates.io, and
 * a `registry-index` is the URL of the dependency's index, which the feed compares with its own.
 * A manifest that still names a registry by its local name (`registry = "…"`) has not been
 * through `cargo package`, so it is refused: the name means nothing outside the publisher's own
 * `.cargo/config.toml`.
 */

import { parse as parseToml } from "smol-toml";
import { readTarMember } from "./tar.js";
import { declaredFiles, exactlyOne } from "./files.js";
import {
  PackageExtractError,
  type Extracted,
  type ExtractInput,
} from "./types.js";

/** One dependency as the feed's index line spells it (`registry: null` is crates.io here). */
export interface CargoDep {
  name: string;
  req: string;
  features: string[];
  optional: boolean;
  default_features: boolean;
  target: string | null;
  kind: "normal" | "dev" | "build";
  registry: string | null;
  package?: string;
}

type Table = Record<string, unknown>;

function isTable(v: unknown): v is Table {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function strings(v: unknown, what: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
    throw new PackageExtractError(`${what} must be a list of strings.`);
  return v as string[];
}

/** The dependency tables of one manifest level (the top, or one `[target.<cfg>]`). */
const KINDS: ReadonlyArray<[string, CargoDep["kind"]]> = [
  ["dependencies", "normal"],
  ["dev-dependencies", "dev"],
  ["dev_dependencies", "dev"],
  ["build-dependencies", "build"],
  ["build_dependencies", "build"],
];

function depsOf(level: Table, target: string | null): CargoDep[] {
  const out: CargoDep[] = [];
  for (const [key, kind] of KINDS) {
    const table = level[key];
    if (table === undefined) continue;
    if (!isTable(table))
      throw new PackageExtractError(`Cargo.toml's [${key}] is not a table.`);
    for (const [name, spec] of Object.entries(table)) {
      const at = `${target ? `target.${target}.` : ""}${key}.${name}`;
      if (typeof spec === "string") {
        out.push({
          name,
          req: spec,
          features: [],
          optional: false,
          default_features: true,
          target,
          kind,
          registry: null,
        });
        continue;
      }
      if (!isTable(spec))
        throw new PackageExtractError(`Cargo.toml's ${at} is not a table.`);
      if (spec.git !== undefined)
        throw new PackageExtractError(
          `Cargo.toml's ${at} is a git dependency; a published crate depends on registries only.`,
        );
      if (spec.registry !== undefined && spec["registry-index"] === undefined)
        throw new PackageExtractError(
          `Cargo.toml's ${at} names the registry ${JSON.stringify(spec.registry)} by its local name: publish the output of cargo package, which writes its index URL.`,
        );
      // A path-only dependency is a development convenience `cargo package` strips; one left in
      // a dev table has nothing to resolve from a registry.
      if (spec.version === undefined && spec.path !== undefined) {
        if (kind === "dev") continue;
        throw new PackageExtractError(
          `Cargo.toml's ${at} is a path dependency with no version.`,
        );
      }
      const req = spec.version ?? "*";
      if (typeof req !== "string")
        throw new PackageExtractError(
          `Cargo.toml's ${at}.version is not a string.`,
        );
      const index = spec["registry-index"];
      if (index !== undefined && typeof index !== "string")
        throw new PackageExtractError(
          `Cargo.toml's ${at}.registry-index is not a string.`,
        );
      const pkg = spec.package;
      if (pkg !== undefined && typeof pkg !== "string")
        throw new PackageExtractError(
          `Cargo.toml's ${at}.package is not a string.`,
        );
      const defaults = spec["default-features"] ?? spec.default_features;
      out.push({
        name,
        req,
        features: strings(spec.features, `Cargo.toml's ${at}.features`),
        optional: spec.optional === true,
        default_features: defaults !== false,
        target,
        kind,
        registry: index ?? null,
        ...(pkg !== undefined ? { package: pkg } : {}),
      });
    }
  }
  return out;
}

/** Every dependency of a parsed manifest: the top level's, then each target's. */
export function cargoDeps(manifest: Table): CargoDep[] {
  const out = depsOf(manifest, null);
  const targets = manifest.target;
  if (targets !== undefined) {
    if (!isTable(targets))
      throw new PackageExtractError("Cargo.toml's [target] is not a table.");
    for (const [cfg, level] of Object.entries(targets))
      if (isTable(level)) out.push(...depsOf(level, cfg));
  }
  return out;
}

/** The feature table, each value a list of strings. */
export function cargoFeatures(manifest: Table): Record<string, string[]> {
  const raw = manifest.features;
  if (raw === undefined) return {};
  if (!isTable(raw))
    throw new PackageExtractError("Cargo.toml's [features] is not a table.");
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw))
    out[k] = strings(v, `Cargo.toml's features.${k}`);
  return out;
}

/** The metadata of a crate from its normalised `Cargo.toml` text. */
export function cargoMetadata(text: string): {
  name: string;
  version: string;
  metadata: Record<string, unknown>;
} {
  let manifest: Table;
  try {
    manifest = parseToml(text) as Table;
  } catch (e) {
    throw new PackageExtractError(
      `the crate's Cargo.toml is not TOML (${(e as Error).message}).`,
    );
  }
  const pkg = manifest.package;
  if (
    !isTable(pkg) ||
    typeof pkg.name !== "string" ||
    typeof pkg.version !== "string"
  )
    throw new PackageExtractError(
      "the crate's Cargo.toml carries no [package] name and version.",
    );
  const metadata: Record<string, unknown> = {
    name: pkg.name,
    version: pkg.version,
  };
  if (typeof pkg.description === "string")
    metadata.description = pkg.description;
  if (typeof pkg.license === "string") metadata.license = pkg.license;
  if (typeof pkg["rust-version"] === "string")
    metadata.rustVersion = pkg["rust-version"];
  if (typeof pkg.links === "string") metadata.links = pkg.links;
  metadata.deps = cargoDeps(manifest);
  metadata.features = cargoFeatures(manifest);
  return { name: pkg.name, version: pkg.version, metadata };
}

export async function extractCargo(input: ExtractInput): Promise<Extracted> {
  const crate = exactlyOne(await declaredFiles(input), "crate (.crate)");
  const member = await readTarMember(crate.path, (p) =>
    /^[^/]+\/Cargo\.toml$/.test(p),
  );
  if (!member)
    throw new PackageExtractError(
      `${crate.name} has no <name>-<version>/Cargo.toml; is it the output of cargo package?`,
    );
  const { name, version, metadata } = cargoMetadata(
    member.data.toString("utf8"),
  );
  if (name !== input.declaration.name)
    throw new PackageExtractError(
      `${crate.name} packs ${name}, but .pkey/release declares ${input.declaration.id} as ${input.declaration.name}.`,
    );
  return {
    version,
    files: [{ path: crate.path, name: crate.name, type: "crate" }],
    metadata,
  };
}
