import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_ENABLED_SERVICES,
  MODULE_SERVICES,
  SERVICE_SLUGS,
  distributionOutletIds,
  normalizeDistribution,
  validateIngestDocuments,
  type ProductModule,
  type ServiceSlug,
} from "@polaris-key/manifest";
import { parse as parseYaml } from "yaml";
import { UsageError } from "./errors.js";

/**
 * What `--modules` (and `InitOptions.modules`) may name: a Polaris Key service slug or one of the
 * legacy module names (`licensing`, `releases`, `oidc`, `edgeMint`) the `.pkey/product` `modules:`
 * block still accepts. Both vocabularies come from the generated service table
 * (`tools/services.json`), via `@polaris-key/manifest`.
 */
export type { ProductModule };

export interface ValidationMessage {
  file: "product" | "schema" | "release" | "distribution";
  path: string;
  code: string;
  message: string;
}

export interface LoadedManifest {
  rootDir: string;
  productPath: string;
  product: Record<string, unknown>;
  schemaPath?: string;
  schema?: unknown;
  releasePath?: string;
  release?: unknown;
  /** `.pkey/distribution` (P2b-02), when the repo has one. */
  distributionPath?: string;
  distribution?: unknown;
  /**
   * Problems with the files themselves, not their content (ST-19, plans/ST-19.md Q5): today,
   * one document present under more than one extension. Only the CLI sees the directory, so
   * these are not validator codes; `pkey validate` prints them as warnings.
   */
  fileWarnings?: string[];
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationMessage[];
  warnings: ValidationMessage[];
  /**
   * The enabled set, reported in Polaris Key SERVICE-SLUG vocabulary (`SERVICE_SLUGS`, in
   * canonical order) whichever vocabulary the manifest wrote — the validator translates.
   */
  enabledModules: ServiceSlug[];
  requiredSecrets: string[];
}

export interface InitOptions {
  cwd: string;
  slug: string;
  name: string;
  /** Services to enable, in either vocabulary; the scaffold writes canonical service slugs. */
  modules: readonly ProductModule[];
  releaseOwner?: string;
  releaseRepo?: string;
  /** `free` (the default) writes the console wizard's Free tier when License is on. */
  starterTier?: "free" | "none";
  force?: boolean;
}

export interface InitResult {
  files: string[];
}

/**
 * Where scaffolded manifests point their editor schema headers. A PATH, not a URL: the
 * canonical $id URLs live on the auth-gated docs site, which editors cannot fetch — the
 * schemas ship inside the @polaris-key/manifest npm package instead, and `.pkey/` sits one
 * level below the repo root where node_modules lives.
 */
const SCHEMA_BASE = "../node_modules/@polaris-key/manifest/schemas/v1";

const PRODUCT_FILES = ["product.json", "product.yaml", "product.yml"];
const SCHEMA_FILES = ["schema.json", "schema.yaml", "schema.yml"];
const RELEASE_FILES = ["release.json", "release.yaml", "release.yml"];
const DISTRIBUTION_FILES = [
  "distribution.json",
  "distribution.yaml",
  "distribution.yml",
];
/** Every name `--modules` accepts: the service slugs, then the legacy module names. */
const MODULES: readonly ProductModule[] = [
  ...SERVICE_SLUGS,
  ...(Object.keys(MODULE_SERVICES) as ProductModule[]).filter(
    (name) => !(SERVICE_SLUGS as readonly string[]).includes(name),
  ),
];

/** The service slugs a list of module names enables, in canonical order. */
function servicesOf(modules: readonly ProductModule[]): ServiceSlug[] {
  const on = new Set<ServiceSlug>();
  for (const name of modules)
    for (const slug of MODULE_SERVICES[name]) on.add(slug);
  return SERVICE_SLUGS.filter((slug) => on.has(slug));
}

/**
 * Parse `--modules`: a comma list in either vocabulary (`license,config` or `licensing,config`),
 * returned as the service slugs it enables, in canonical order. Absent means the table's defaults.
 */
export function normalizeModules(raw: string | undefined): ServiceSlug[] {
  if (!raw) return [...DEFAULT_ENABLED_SERVICES];
  const parsed = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  for (const item of parsed) {
    if (!isProductModule(item))
      throw new UsageError(
        `Unknown module "${item}". Expected one of ${MODULES.join(", ")}.`,
      );
  }
  return servicesOf(parsed as ProductModule[]);
}

/** The product a `.pkey/product` names, and the file that names it. */
export interface FoundProduct {
  slug: string;
  name?: string;
  file: string;
}

/**
 * The nearest `.pkey/product` at or above `cwd` (the way git finds a repository), read only far
 * enough to take the slug and name: a flat document or the `product:` wrapper. `null` when there
 * is none, or when the nearest one has no readable slug (`pkey validate` says what is wrong).
 */
export async function findProductManifest(
  cwd: string,
): Promise<FoundProduct | null> {
  const file = await findProductFile(cwd);
  if (!file) return null;
  try {
    const doc = parseFile(file, await readFile(file, "utf8"));
    if (!isRecord(doc)) return null;
    const wrapped = isRecord(doc.product) ? doc.product : doc;
    const slug = wrapped.slug;
    if (typeof slug !== "string" || !slug.trim()) return null;
    const name = wrapped.name;
    return {
      slug: slug.trim(),
      ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}),
      file,
    };
  } catch {
    return null;
  }
}

/** The nearest `.pkey/product` file at or above `cwd`, readable or not. */
async function findProductFile(cwd: string): Promise<string | null> {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const file = await findExisting(path.join(dir, ".pkey"), PRODUCT_FILES);
    if (file) return file;
    if (path.dirname(dir) === dir) return null;
  }
}

/**
 * The directory that holds the nearest `.pkey/` (at or above `cwd`), whether or not its product
 * file reads, so `pkey doctor` validates what `pkey help` named. `cwd` itself when there is none.
 */
export async function findManifestRoot(cwd: string): Promise<string> {
  const file = await findProductFile(cwd);
  return file ? path.dirname(path.dirname(file)) : cwd;
}

export async function loadManifest(cwd: string): Promise<LoadedManifest> {
  const rootDir = path.join(cwd, ".pkey");
  const productFile = await findExisting(rootDir, PRODUCT_FILES);
  if (!productFile) {
    throw new Error(
      `No .pkey/product manifest found in ${rootDir}. Run pkey init or create product.yaml.`,
    );
  }
  const schemaFile = await findExisting(rootDir, SCHEMA_FILES);
  const releaseFile = await findExisting(rootDir, RELEASE_FILES);
  const distributionFile = await findExisting(rootDir, DISTRIBUTION_FILES);
  const fileWarnings: string[] = [];
  for (const names of [
    PRODUCT_FILES,
    SCHEMA_FILES,
    RELEASE_FILES,
    DISTRIBUTION_FILES,
  ]) {
    const found = await findAll(rootDir, names);
    if (found.length > 1)
      fileWarnings.push(
        `${found.map((f) => `.pkey/${f}`).join(" and ")} are one document; only .pkey/${found[0]} is read (json, then yaml, then yml), here and on the platform. Keep one file.`,
      );
  }
  const product = parseFile(productFile, await readFile(productFile, "utf8"));
  if (!isRecord(product))
    throw new Error(
      `${path.relative(cwd, productFile)} must parse to an object.`,
    );
  return {
    rootDir,
    productPath: productFile,
    product,
    ...(fileWarnings.length ? { fileWarnings } : {}),
    ...(schemaFile
      ? {
          schemaPath: schemaFile,
          schema: parseFile(schemaFile, await readFile(schemaFile, "utf8")),
        }
      : {}),
    ...(releaseFile
      ? {
          releasePath: releaseFile,
          release: parseFile(releaseFile, await readFile(releaseFile, "utf8")),
        }
      : {}),
    ...(distributionFile
      ? {
          distributionPath: distributionFile,
          distribution: parseFile(
            distributionFile,
            await readFile(distributionFile, "utf8"),
          ),
        }
      : {}),
  };
}

/**
 * The `.pkey/distribution` file in `cwd`, or `null` when there is none — checked WITHOUT loading
 * the rest of the manifest, so `pkey distribution outlet-ids` can answer `{}` for a repo with no
 * distribution document even where the other documents are absent.
 */
export async function findDistributionFile(
  cwd: string,
): Promise<string | null> {
  return findExisting(path.join(cwd, ".pkey"), DISTRIBUTION_FILES);
}

/**
 * The `outletIds` object for one build outlet (`pkey distribution outlet-ids`, P2b-02): the
 * product's store ids, every value a string, keys sorted — what CI passes to a Godot export as
 * `PKEY_OUTLET_IDS` (P1-11; notes/S-06 rule 4). `null` when the document declares no such outlet.
 * Call only on a manifest that validated.
 */
export function outletIdsFor(
  manifest: LoadedManifest,
  outletId: string,
): Record<string, string> | null {
  return distributionOutletIds(
    normalizeDistribution(manifest.distribution),
    outletId,
  );
}

export function validateLoadedManifest(
  manifest: LoadedManifest,
): ValidationResult {
  // The same rule link and resync apply (schema always required), so validate cannot pass a
  // manifest that fails at link.
  return validateIngestDocuments({
    product: manifest.product,
    schema: manifest.schema,
    release: manifest.release,
    distribution: manifest.distribution,
  });
}

export async function initManifest(opts: InitOptions): Promise<InitResult> {
  const rootDir = path.join(opts.cwd, ".pkey");
  await mkdir(rootDir, { recursive: true });
  const files: string[] = [];
  const services = servicesOf(opts.modules);
  const productPath = path.join(rootDir, "product.yaml");
  await writeNewFile(productPath, productYaml(opts, services), opts.force);
  files.push(productPath);
  // Always written: ingest requires .pkey/schema even when Config is off.
  const schemaPath = path.join(rootDir, "schema.yaml");
  await writeNewFile(
    schemaPath,
    schemaYaml(services.includes("config")),
    opts.force,
  );
  files.push(schemaPath);
  if (services.includes("release")) {
    const releasePath = path.join(rootDir, "release.yaml");
    await writeNewFile(releasePath, releaseYaml(opts), opts.force);
    files.push(releasePath);
  }
  return { files };
}

function productYaml(opts: InitOptions, services: ServiceSlug[]): string {
  // Canonical service slugs, every one of them, so the scaffold shows what can be turned on.
  const moduleLines = SERVICE_SLUGS.map(
    (slug) =>
      `  ${slug}:\n    enabled: ${services.includes(slug) ? "true" : "false"}`,
  );
  const oidc = services.includes("identity")
    ? `\noidc:\n  provider: platform\n  groupRoleMap: {}\n`
    : "";
  // The wizard's rows: a Free tier only when License is on and the starter tier is `free`.
  const tiers =
    services.includes("license") && opts.starterTier !== "none"
      ? `\n  tiers:\n    - id: free\n      label: Free\n      profileId: default\n      policyDeviceLimit: 5\n      channels: ["stable"]`
      : "";
  return `# yaml-language-server: $schema=${SCHEMA_BASE}/product.schema.json
apiVersion: pkey.dev/v1
product:
  slug: ${quoteYaml(opts.slug)}
  name: ${quoteYaml(opts.name)}
modules:
${moduleLines.join("\n")}

profiles:
  - id: default
    name: Default
    payload:
      config: {}
      secrets: {}
      entitlements: {}

licensing:
  defaultDeviceLimit: 5
  defaultMaxOfflineDays: 14${tiers}${oidc}

secrets:
  required: []
`;
}

function schemaYaml(withExamples: boolean): string {
  const header = `# yaml-language-server: $schema=${SCHEMA_BASE}/schema.schema.json
apiVersion: pkey.dev/v1
schemaVersion: 1
`;
  // Ingest requires the document even for a product with no config; an empty catalog is the
  // valid "nothing to configure yet" state.
  if (!withExamples) return `${header}entries: []\n`;
  return `${header}entries:
  - key: feature.example
    kind: flag
    label: Example feature
    category: General
    description: Example feature entitlement.
    schema:
      type: boolean
    default: false
  - key: app.welcomeMessage
    kind: config
    label: Welcome message
    category: General
    description: Greeting shown in the app.
    schema:
      type: string
    default: "Welcome"
    managementDefault: default
`;
}

function releaseYaml(opts: InitOptions): string {
  return `# yaml-language-server: $schema=${SCHEMA_BASE}/release.schema.json
apiVersion: pkey.dev/v1
release:
  provider:
    type: github
    owner: ${quoteYaml(opts.releaseOwner ?? "OWNER")}
    repo: ${quoteYaml(opts.releaseRepo ?? opts.slug)}
  # stable and beta are built in and need no declaration. Named channels beyond them are
  # optional, matched by anchored regex against release tags:
  # manualChannels:
  #   - name: nightly
  #     regex: v.*-nightly\\..*
  # Which tags are real app releases (candidates for stable/latest). Undeclared means any semver
  # tag with an optional leading v; list tags that are not app releases in ignoreTags:
  # stableTagPattern: v\\d+\\.\\d+\\.\\d+
  # ignoreTags: [channels, packs]
`;
}

async function writeNewFile(
  file: string,
  body: string,
  force = false,
): Promise<void> {
  if (!force) {
    try {
      await stat(file);
      throw new Error(`${file} already exists. Pass --force to overwrite.`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  await writeFile(file, body, "utf8");
}

async function findExisting(
  rootDir: string,
  names: string[],
): Promise<string | null> {
  for (const name of names) {
    const file = path.join(rootDir, name);
    try {
      await stat(file);
      return file;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return null;
}

/** Every one of `names` that exists in `rootDir`, in the order given. */
async function findAll(rootDir: string, names: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const name of names) {
    try {
      await stat(path.join(rootDir, name));
      out.push(name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return out;
}

/** The words for a YAML parser error, in the reader's terms (the parser's own are for its authors). */
function yamlReason(err: { code?: string; message: string }): string {
  const first = err.message.split("\n")[0]!;
  if (/end with a \]/.test(first)) return "an unclosed [";
  if (/end with a \}/.test(first)) return "an unclosed {";
  switch (err.code) {
    case "BAD_INDENT":
      return "the indentation is off";
    case "TAB_AS_INDENT":
      return "a tab where spaces go";
    case "DUPLICATE_KEY":
      return "a key is written twice";
    case "MISSING_CHAR":
      return "an unclosed quote or bracket";
    default:
      return "the syntax is off here";
  }
}

/**
 * A manifest file that does not parse. `message` is the one plain sentence
 * (`.pkey/schema.yaml line 23: not valid YAML (an unclosed [).`): it names the file by its
 * `.pkey/` name, never its path, and carries no next step, which the command that prints it adds.
 */
export class ManifestSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestSyntaxError";
  }
}

function parseFile(file: string, raw: string): unknown {
  const json = file.endsWith(".json");
  try {
    return json ? (JSON.parse(raw) as unknown) : (parseYaml(raw) as unknown);
  } catch (err) {
    const e = err as Error & {
      code?: string;
      linePos?: Array<{ line: number }>;
    };
    const line = e.linePos?.[0]?.line;
    const why = json ? "the JSON is malformed" : yamlReason(e);
    throw new ManifestSyntaxError(
      `.pkey/${path.basename(file)}${line ? ` line ${line}` : ""}: not valid ${json ? "JSON" : "YAML"} (${why}).`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProductModule(value: string): value is ProductModule {
  return (MODULES as readonly string[]).includes(value);
}

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}
