import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
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
  enabledModules: ProductModule[];
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
  const errors: ValidationMessage[] = [];
  const warnings: ValidationMessage[] = [];
  const product = manifest.product;
  const modules = enabledModules(product);
  const productNode = asRecord(product.product);
  const licensing = asRecord(product.licensing);
  const oidc = asRecord(product.oidc);
  const secrets = asRecord(product.secrets);

  if (!stringAt(product, "apiVersion"))
    add(
      errors,
      "product",
      "/apiVersion",
      "missing_api_version",
      "Set apiVersion to pkey.dev/v1.",
    );
  if (!productNode)
    add(
      errors,
      "product",
      "/product",
      "missing_product",
      "Add a product object.",
    );
  if (!stringAt(productNode, "slug"))
    add(
      errors,
      "product",
      "/product/slug",
      "missing_slug",
      "Add product.slug.",
    );
  if (!stringAt(productNode, "name"))
    add(
      errors,
      "product",
      "/product/name",
      "missing_name",
      "Add product.name.",
    );
  if (
    productNode &&
    productNode.adminGroup !== undefined &&
    !stringAt(productNode, "adminGroup")
  ) {
    add(
      errors,
      "product",
      "/product/adminGroup",
      "invalid_admin_group",
      "adminGroup must be a non-empty string when present.",
    );
  }
  if (modules.includes("config") && manifest.schema === undefined) {
    add(
      errors,
      "schema",
      "/",
      "missing_schema",
      "Config is enabled, so .pkey/schema.yaml or schema.json is required.",
    );
  }
  if (modules.includes("releases") && manifest.release === undefined) {
    add(
      errors,
      "release",
      "/",
      "missing_release",
      "Releases are enabled, so .pkey/release.yaml or release.json is required.",
    );
  }
  if (modules.includes("oidc") && !modules.includes("licensing")) {
    add(
      errors,
      "product",
      "/modules/oidc",
      "oidc_requires_licensing",
      "OIDC enrollment currently requires the licensing module.",
    );
  }
  if (
    modules.includes("config") &&
    !modules.includes("licensing") &&
    !modules.includes("oidc")
  ) {
    add(
      warnings,
      "product",
      "/modules/config",
      "config_without_activation",
      "Config is enabled without an activation method.",
    );
  }
  if (
    modules.includes("licensing") &&
    licensing?.tiers !== undefined &&
    !Array.isArray(licensing.tiers)
  ) {
    add(
      errors,
      "product",
      "/licensing/tiers",
      "invalid_tiers",
      "licensing.tiers must be an array.",
    );
  }
  if (modules.includes("oidc")) {
    if (!stringAt(oidc, "issuer"))
      add(
        errors,
        "product",
        "/oidc/issuer",
        "missing_oidc_issuer",
        "OIDC is enabled, so oidc.issuer is required.",
      );
    if (!stringAt(oidc, "clientId"))
      add(
        errors,
        "product",
        "/oidc/clientId",
        "missing_oidc_client_id",
        "OIDC is enabled, so oidc.clientId is required.",
      );
  }
  if (modules.includes("releases")) {
    const releaseRoot = asRecord(manifest.release);
    const release = asRecord(releaseRoot?.release ?? releaseRoot);
    const provider = asRecord(release?.provider);
    if (!provider)
      add(
        errors,
        "release",
        "/release/provider",
        "missing_release_provider",
        "Add release.provider.",
      );
    if (provider && stringAt(provider, "type") !== "github") {
      add(
        errors,
        "release",
        "/release/provider/type",
        "unsupported_release_provider",
        "Only github is implemented.",
      );
    }
    if (
      provider &&
      (!stringAt(provider, "owner") || !stringAt(provider, "repo"))
    ) {
      add(
        errors,
        "release",
        "/release/provider",
        "missing_github_repo",
        "GitHub releases require provider.owner and provider.repo.",
      );
    }
  }

  const requiredSecrets = collectRequiredSecrets(secrets);
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    enabledModules: modules,
    requiredSecrets,
  };
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
  return `import { PolarisKeyClient } from "@polaris-key/node";

const client = await PolarisKeyClient.create({
  productSlug: "${opts.product}",
  baseUrl: "${opts.baseUrl}",
  version: "1.0.0"${trust}
});

const config = await client.getConfig();`;
}

function productYaml(opts: InitOptions): string {
  const moduleLines = MODULES.map(
    (module) =>
      `  ${module}:\n    enabled: ${opts.modules.includes(module) ? "true" : "false"}`,
  );
  const secrets = opts.modules.includes("oidc")
    ? `\nsecrets:\n  required:\n    - name: oidc_client_secret\n      usedBy: oidc\n`
    : "\nsecrets:\n  required: []\n";
  const oidc = opts.modules.includes("oidc")
    ? `\noidc:\n  issuer: "https://id.example.com"\n  clientId: "${opts.slug}"\n  clientSecretRef: oidc_client_secret\n  groupRoleMap: {}\n`
    : "";
  return `apiVersion: pkey.dev/v1
product:
  slug: ${quoteYaml(opts.slug)}
  name: ${quoteYaml(opts.name)}
${opts.adminGroup ? `  adminGroup: ${quoteYaml(opts.adminGroup)}\n` : ""}modules:
${moduleLines.join("\n")}

licensing:
  defaultMachineLimit: 5
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
      machineLimit: 5
      maxOfflineDays: 14
      channels: ["stable"]${oidc}${secrets}`;
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
