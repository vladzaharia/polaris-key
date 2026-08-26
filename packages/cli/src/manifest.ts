import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateManifestDocuments, type ServiceSlug } from "@plrs/manifest";
import { parse as parseYaml } from "yaml";

export type ProductModule =
  | "licensing"
  | "config"
  | "releases"
  | "oidc"
  | "edgeMint";

export interface ValidationMessage {
  file: "product" | "schema" | "release";
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
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationMessage[];
  warnings: ValidationMessage[];
  /**
   * The enabled set, reported in Polaris SERVICE-SLUG vocabulary (`license`, `config`,
   * `release`, `update`, `identity`) whichever vocabulary the manifest wrote — the validator
   * translates. `--modules` still takes the module names below; only the report is normalised.
   */
  enabledModules: ServiceSlug[];
  requiredSecrets: string[];
}

export interface InitOptions {
  cwd: string;
  slug: string;
  name: string;
  modules: ProductModule[];
  adminGroup?: string;
  releaseOwner?: string;
  releaseRepo?: string;
  force?: boolean;
}

export interface InitResult {
  files: string[];
}

const PRODUCT_FILES = ["product.json", "product.yaml", "product.yml"];
const SCHEMA_FILES = ["schema.json", "schema.yaml", "schema.yml"];
const RELEASE_FILES = ["release.json", "release.yaml", "release.yml"];
const MODULES: ProductModule[] = [
  "licensing",
  "config",
  "releases",
  "oidc",
  "edgeMint",
];

export function normalizeModules(raw: string | undefined): ProductModule[] {
  if (!raw) return ["licensing", "config"];
  const parsed = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const out: ProductModule[] = [];
  for (const item of parsed) {
    if (!isProductModule(item))
      throw new Error(
        `Unknown module "${item}". Expected one of ${MODULES.join(", ")}.`,
      );
    if (!out.includes(item)) out.push(item);
  }
  return out;
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
  };
}

export function validateLoadedManifest(
  manifest: LoadedManifest,
): ValidationResult {
  return validateManifestDocuments({
    product: manifest.product,
    schema: manifest.schema,
    release: manifest.release,
  });
}

export async function initManifest(opts: InitOptions): Promise<InitResult> {
  const rootDir = path.join(opts.cwd, ".pkey");
  await mkdir(rootDir, { recursive: true });
  const files: string[] = [];
  const productPath = path.join(rootDir, "product.yaml");
  await writeNewFile(productPath, productYaml(opts), opts.force);
  files.push(productPath);
  if (opts.modules.includes("config")) {
    const schemaPath = path.join(rootDir, "schema.yaml");
    await writeNewFile(schemaPath, schemaYaml(), opts.force);
    files.push(schemaPath);
  }
  if (opts.modules.includes("releases")) {
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
    `let trustedKeys = ${trust}`,
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
  return `import { PolarisKeyClient } from "@plrs/node";

const client = await PolarisKeyClient.create({
  productSlug: "${opts.product}",
  baseUrl: "${opts.baseUrl}",
  version: "1.0.0"${trust}
});

await client.refresh();

const enabled = client.isLicensed();
const value = client.getConfig("your.config.key", "fallback");
const secret = client.getSecret("your.secret.key");`;
}

function productYaml(opts: InitOptions): string {
  const moduleLines = MODULES.map(
    (module) =>
      `  ${module}:\n    enabled: ${opts.modules.includes(module) ? "true" : "false"}`,
  );
  const oidc = opts.modules.includes("oidc")
    ? `\noidc:\n  provider: platform\n  groupRoleMap: {}\n`
    : "";
  return `apiVersion: pkey.dev/v1
product:
  slug: ${quoteYaml(opts.slug)}
  name: ${quoteYaml(opts.name)}
${opts.adminGroup ? `  adminGroup: ${quoteYaml(opts.adminGroup)}\n` : ""}modules:
${moduleLines.join("\n")}

licensing:
  defaultDeviceLimit: 5
  defaultMaxOfflineDays: 14
  keyActivation:
    enabled: ${opts.modules.includes("licensing") ? "true" : "false"}
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
      deviceLimit: 5
      maxOfflineDays: 14
      channels: ["stable"]${oidc}

secrets:
  required: []
`;
}

function schemaYaml(): string {
  return `apiVersion: pkey.dev/v1
schemaVersion: 1
catalog:
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
  return `apiVersion: pkey.dev/v1
release:
  provider:
    type: github
    owner: ${quoteYaml(opts.releaseOwner ?? "OWNER")}
    repo: ${quoteYaml(opts.releaseRepo ?? opts.slug)}
  channels:
    stable:
      selector: latest
    beta:
      selector: prerelease
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

function enabledModules(product: Record<string, unknown>): ProductModule[] {
  const modules = asRecord(product.modules);
  if (!modules) return ["licensing", "config"];
  return MODULES.filter((module) => {
    const value = modules[module];
    if (typeof value === "boolean") return value;
    const record = asRecord(value);
    return record?.enabled === true;
  });
}

function collectRequiredSecrets(
  secrets: Record<string, unknown> | null,
): string[] {
  const required = secrets?.required;
  if (!Array.isArray(required)) return [];
  const names = required
    .map((item) =>
      typeof item === "string" ? item : stringAt(asRecord(item), "name"),
    )
    .filter((item): item is string => Boolean(item));
  return [...new Set(names)];
}

function add(
  list: ValidationMessage[],
  file: ValidationMessage["file"],
  pointer: string,
  code: string,
  message: string,
): void {
  list.push({ file, path: pointer, code, message });
}

function stringAt(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProductModule(value: string): value is ProductModule {
  return (MODULES as string[]).includes(value);
}

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}
