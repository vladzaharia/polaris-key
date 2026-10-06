/**
 * The Cargo sparse-index documents (F-30, plans/F-01.md §6.8; Cargo's "Registry Index" reference):
 * a pure function from a `RegistryPackage` to the crate's one index file, and from the owner's
 * origin to `config.json`.
 *
 *   - THE INDEX FILE is JSON Lines: one line per published version, oldest publication first, as
 *     Cargo appends them. A version's line carries the crate's declared `name`, `vers`, `deps`,
 *     `cksum` (the `.crate` file's SHA-256), `features`, `yanked` and `links`, plus
 *     `rust_version` when the crate declares one and `features2` with `v: 2` when a feature uses
 *     the `dep:` or `?/` syntax (the split crates.io makes, so an old Cargo never sees what it
 *     cannot parse). The path is Cargo's: the name in lower case under `1/`, `2/`, `3/<c>/` or
 *     `<ab>/<cd>/` (`indexPath`).
 *   - DEPENDENCIES come from the CLI's extractor (`packages/cli/src/package/cargo.ts`), which reads
 *     the `.crate`'s normalised `Cargo.toml`, so the Worker never unpacks a crate (the P2b-05
 *     rule). Each entry is re-shaped here, never trusted: a malformed entry is dropped. A
 *     dependency's `registry` is the URL of its index: no `registry-index` in the manifest means
 *     crates.io, and this feed's own index means "this registry" (`null`, the index format's
 *     spelling), so a dependency on a sibling crate of the same owner resolves here.
 *   - YANK is Cargo's own: a yanked version keeps its line with `yanked: true`, so a lockfile that
 *     pins it still builds and a new resolution skips it. DEPRECATE and CHANNELS have no Cargo
 *     equivalent: a deprecated version is listed as live and the index maps no tag.
 *   - `config.json` names the download template (`dl`, the content-addressed file route, so the
 *     bytes behind a URL never change) and, when the feed is not public, `auth-required: true`,
 *     which tells Cargo 1.74 and later to send the registry token on every request. It carries no
 *     `api`: crates publish through `pkey release publish`, never Cargo's `crates/new`.
 */

import type {
  PackageFile,
  PackageVersion,
  RegistryPackage,
  RenderContext,
  RenderedObject,
} from "../materialise.js";

/** The type both documents are served under: Cargo reads the body and ignores the type. */
export const CARGO_INDEX_TYPE = "application/json";

/** crates.io's index URL, the registry a dependency without `registry-index` comes from. */
export const CRATES_IO_INDEX = "https://github.com/rust-lang/crates.io-index";

/** The index format version a line declares when it carries `features2`. */
const INDEX_V2 = 2;

/** A crate name (crates.io's grammar, the manifest's `CARGO_PACKAGE_RULES`). */
const CRATE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** A feature name: crates.io allows letters, digits, `_`, `-`, `+` and `.` after the first. */
const FEATURE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_+.-]{0,99}$/;
/** What a `deps[].kind` may be. */
const DEP_KINDS = new Set(["normal", "dev", "build"]);
/** Bounds on what one line repeats from the metadata (the descriptor caps it at 16 KiB anyway). */
const MAX_DEPS = 512;
const MAX_FEATURES = 512;
const MAX_STRING = 512;

export function isCrateName(name: string): boolean {
  return CRATE_NAME.test(name);
}

/**
 * Cargo's index path for a crate, from its name in lower case: `1/<n>`, `2/<n>`, `3/<c>/<n>`
 * (`<c>` its first character) or `<ab>/<cd>/<n>` (its first four characters, in two pairs).
 */
export function indexPath(name: string): string {
  const n = name.toLowerCase();
  if (n.length === 1) return `1/${n}`;
  if (n.length === 2) return `2/${n}`;
  if (n.length === 3) return `3/${n[0]}/${n}`;
  return `${n.slice(0, 2)}/${n.slice(2, 4)}/${n}`;
}

/** The R2 key of a crate's index file, relative to the owner's `registry/cargo/<owner>/`. */
export function indexKey(name: string): string {
  return `index/${indexPath(name)}`;
}

/** A crate file's name, as the `dl` template spells it: `<crate>-<version>.crate`. */
export function crateFileName(name: string, version: string): string {
  return `${name}-${version}.crate`;
}

/** The feed's base URL on the registry host (`/cargo/<owner>/`). */
export function feedBase(origin: string, owner: string): string {
  return `${origin.replace(/\/+$/, "")}/cargo/${encodeURIComponent(owner)}/`;
}

/** The one `.crate` file of a version, or `null` (a version the index cannot list). */
export function crateOf(v: PackageVersion): PackageFile | null {
  return v.files.find((f) => f.type === "crate") ?? null;
}

function boundedString(v: unknown): string | null {
  return typeof v === "string" && v !== "" && v.length <= MAX_STRING ? v : null;
}

function stringList(v: unknown, max = MAX_FEATURES): string[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  const out: string[] = [];
  for (const x of v) {
    const s = boundedString(x);
    if (s === null) return null;
    out.push(s);
  }
  return out;
}

/** An index URL without Cargo's `sparse+` marker and trailing slashes, for comparison. */
function indexUrlKey(url: string): string {
  return url.replace(/^sparse\+/, "").replace(/\/+$/, "");
}

/** One dependency as the index spells it. */
interface IndexDep {
  readonly name: string;
  readonly req: string;
  readonly features: string[];
  readonly optional: boolean;
  readonly default_features: boolean;
  readonly target: string | null;
  readonly kind: string;
  readonly registry: string | null;
  readonly package?: string;
}

/**
 * One extractor entry as an index dependency, or `null` when it is malformed. `ownIndex` is this
 * feed's base URL: a dependency on it becomes `registry: null`.
 */
function indexDep(raw: unknown, ownIndex: string): IndexDep | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return null;
  const d = raw as Record<string, unknown>;
  const name = boundedString(d.name);
  if (name === null || !CRATE_NAME.test(name)) return null;
  const req = d.req === undefined ? "*" : boundedString(d.req);
  if (req === null) return null;
  const features = d.features === undefined ? [] : stringList(d.features);
  if (features === null) return null;
  const kind = d.kind === undefined ? "normal" : d.kind;
  if (typeof kind !== "string" || !DEP_KINDS.has(kind)) return null;
  const target =
    d.target === undefined || d.target === null
      ? null
      : boundedString(d.target);
  if (d.target !== undefined && d.target !== null && target === null)
    return null;
  const pkgName =
    d.package === undefined || d.package === null
      ? null
      : boundedString(d.package);
  if (pkgName !== null && !CRATE_NAME.test(pkgName)) return null;
  if (d.package !== undefined && d.package !== null && pkgName === null)
    return null;
  let registry: string | null;
  if (d.registry === undefined || d.registry === null)
    registry = CRATES_IO_INDEX;
  else {
    const url = boundedString(d.registry);
    if (url === null) return null;
    // Another registry's URL stays exactly as written: its `sparse+` marker is how Cargo knows
    // which protocol that index speaks.
    registry = indexUrlKey(url) === indexUrlKey(ownIndex) ? null : url;
  }
  return {
    name,
    req,
    features,
    optional: d.optional === true,
    default_features: d.default_features !== false,
    target,
    kind,
    registry,
    ...(pkgName !== null ? { package: pkgName } : {}),
  };
}

/** Does a feature's value list use the syntax only index v2 carries (`dep:x`, `x?/f`)? */
function needsV2(values: readonly string[]): boolean {
  return values.some((v) => v.startsWith("dep:") || v.includes("?/"));
}

/** The feature table split as crates.io splits it: plain features, and the v2-only ones. */
function featureTables(raw: unknown): {
  features: Record<string, string[]>;
  features2: Record<string, string[]>;
} {
  const features: Record<string, string[]> = {};
  const features2: Record<string, string[]> = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return { features, features2 };
  const entries = Object.entries(raw as Record<string, unknown>)
    .filter(([k]) => FEATURE_NAME.test(k))
    .slice(0, MAX_FEATURES)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [k, v] of entries) {
    const values = stringList(v);
    if (values === null) continue;
    (needsV2(values) ? features2 : features)[k] = values;
  }
  return { features, features2 };
}

/** One version's index line, or `null` when the version carries no crate. */
export function indexLine(
  pkg: RegistryPackage,
  v: PackageVersion,
  ownIndex: string,
): string | null {
  const crate = crateOf(v);
  if (!crate) return null;
  const m = v.metadata;
  const deps = (Array.isArray(m.deps) ? m.deps.slice(0, MAX_DEPS) : [])
    .map((d) => indexDep(d, ownIndex))
    .filter((d): d is IndexDep => d !== null)
    .sort((a, b) =>
      a.name < b.name
        ? -1
        : a.name > b.name
          ? 1
          : a.kind < b.kind
            ? -1
            : a.kind > b.kind
              ? 1
              : 0,
    );
  const { features, features2 } = featureTables(m.features);
  const links = boundedString(m.links);
  const rustVersion = boundedString(m.rustVersion);
  const hasV2 = Object.keys(features2).length > 0;
  return JSON.stringify({
    name: pkg.name,
    vers: v.version,
    deps,
    cksum: crate.sha256,
    features,
    yanked: v.state === "yanked",
    links,
    ...(hasV2 ? { features2, v: INDEX_V2 } : {}),
    ...(rustVersion !== null ? { rust_version: rustVersion } : {}),
  });
}

/** The crate's index file: one line per version that carries a crate, each ending in `\n`. */
export function indexFile(pkg: RegistryPackage, origin: string): string {
  const own = feedBase(origin, pkg.product);
  return pkg.versions
    .map((v) => indexLine(pkg, v, own))
    .filter((l): l is string => l !== null)
    .map((l) => `${l}\n`)
    .join("");
}

/**
 * The feed's `config.json`. `dl` is the content-addressed file route: Cargo fills in the
 * crate's checksum, name and version from its index line.
 */
export function configJson(
  origin: string,
  owner: string,
  authRequired: boolean,
): string {
  const base = feedBase(origin, owner);
  return JSON.stringify({
    dl: `${base}files/{sha256-checksum}/{crate}-{version}.crate`,
    ...(authRequired ? { "auth-required": true } : {}),
  });
}

/** Everything one package renders into R2: its index file (none before a crate is published). */
export function renderCargo(
  pkg: RegistryPackage,
  ctx: Pick<RenderContext, "origin">,
): RenderedObject[] {
  const body = indexFile(pkg, ctx.origin);
  if (body === "") return [];
  return [{ key: indexKey(pkg.name), body, contentType: CARGO_INDEX_TYPE }];
}
