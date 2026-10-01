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
  adminGroup?: string;
  releaseOwner?: string;
  releaseRepo?: string;
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
      throw new Error(
        `Unknown module "${item}". Expected one of ${MODULES.join(", ")}.`,
      );
  }
  return servicesOf(parsed as ProductModule[]);
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
  const product = parseFile(productFile, await readFile(productFile, "utf8"));
  if (!isRecord(product))
    throw new Error(
      `${path.relative(cwd, productFile)} must parse to an object.`,
    );
  return {
    rootDir,
    productPath: productFile,
    product,
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

export function trustSnippet(kid: string, publicKey: string): string {
  const trust = JSON.stringify({ [kid]: publicKey }, null, 2);
  return [
    "JSON trust set:",
    trust,
    "",
    "Node/React:",
    `trust: { pinnedKeys: ${trust} }`,
    "",
    "Python:",
    `trusted_keys = ${trust}`,
    "",
    "Swift:",
    // Swift dictionary literals use square brackets — emitting the JSON `{…}` form here
    // produced a snippet that did not compile.
    `let trustedKeys = [${JSON.stringify(kid)}: ${JSON.stringify(publicKey)}]`,
  ].join("\n");
}

export function sdkSnippet(opts: {
  baseUrl: string;
  product: string;
  kid?: string;
  publicKey?: string;
}): string {
  const trust =
    opts.kid && opts.publicKey
      ? `,\n  trust: { pinnedKeys: ${JSON.stringify({ [opts.kid]: opts.publicKey })} }`
      : "";
  return `import { PolarisKeyClient } from "@polaris-key/node";

const client = await PolarisKeyClient.create({
  productSlug: "${opts.product}",
  baseUrl: "${opts.baseUrl}",
  version: "1.0.0"${trust}
});

await client.sync();

const enabled = client.isLicensed();
const value = client.config.getConfig("your.config.key", "fallback");
const secret = client.config.getSecret("your.secret.key");`;
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
  return `# yaml-language-server: $schema=${SCHEMA_BASE}/product.schema.json
apiVersion: pkey.dev/v1
product:
  slug: ${quoteYaml(opts.slug)}
  name: ${quoteYaml(opts.name)}
${opts.adminGroup ? `  adminGroup: ${quoteYaml(opts.adminGroup)}\n` : ""}modules:
${moduleLines.join("\n")}

licensing:
  defaultDeviceLimit: 5
  defaultMaxOfflineDays: 14
  profiles:
    - id: standard-defaults
      name: Standard defaults
      payload:
        config: {}
        secrets: {}
        entitlements: {}
  tiers:
    - id: standard
      label: Standard
      profile: standard-defaults
      policyDeviceLimit: 5
      channels: ["stable"]${oidc}

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
  if (!withExamples) return `${header}catalog: []\n`;
  return `${header}catalog:
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

function parseFile(file: string, raw: string): unknown {
  if (file.endsWith(".json")) return JSON.parse(raw) as unknown;
  return parseYaml(raw) as unknown;
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
