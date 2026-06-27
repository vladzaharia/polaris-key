import { type ProductCatalog } from "@polaris-key/catalog";
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

export interface ManifestDocuments {
  product: Record<string, unknown>;
  schema?: unknown;
  release?: unknown;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationMessage[];
  warnings: ValidationMessage[];
  enabledModules: ProductModule[];
  requiredSecrets: string[];
}

export interface ManifestProduct {
  slug: string;
  name: string;
  compatMin: string;
  compatMax: string;
  defaultMaxOfflineDays: number;
  defaultDeviceLimit: number;
  adminGroup: string;
}

export interface ManifestOidc {
  provider: "platform" | "custom";
  issuer: string;
  clientId: string;
  clientSecretSecret: string;
  redirectUris: string[];
  groupRoleMap: Record<string, unknown>;
}

export interface ManifestTier {
  id: string;
  label: string;
  profileId: string | null;
  policyExpiryDays: number | null;
  policyDeviceLimit: number | null;
  channels: string[];
  minVersion: string | null;
  maxVersion: string | null;
}

export interface ManifestProfile {
  id: string;
  name: string;
  description?: string | null;
  payload: Record<string, unknown>;
}

export interface ManifestProvisioning {
  claim: string;
  entitlementKey?: string;
  entitlementValue?: unknown;
  secretKey?: string;
  secretUrlTemplate?: string;
  allowedHosts?: string[];
}

export interface ManifestReleaseArtifactPolicy {
  channels: string[];
  architectures: string[];
  requireDmg: boolean;
  requireCli: boolean;
  requireSparkleSignature: boolean;
  allowAmbiguousAssets: boolean;
}

export type ManifestReleaseAccess = "public" | "authenticated" | "licensed";

export interface ManifestReleaseAccessPolicy {
  metadata: ManifestReleaseAccess;
  artifacts: ManifestReleaseAccess;
}

export interface ManifestRelease {
  ghOwner: string;
  ghRepo: string;
  binaryName: string;
  channelWorkflow: string;
  betaBranch: string;
  summaryMarker: string;
  sparkleEd25519Pub: string;
  artifactPolicy: ManifestReleaseArtifactPolicy | null;
  access: ManifestReleaseAccessPolicy;
}

export type ManifestSecretDelivery = "serverOnly" | "clientScoped" | "edgeMint";

export type ManifestCatalogEntry = ProductCatalog["entries"][number] & {
  delivery?: ManifestSecretDelivery;
};

export type ManifestCatalog = Omit<ProductCatalog, "entries"> & {
  entries: ManifestCatalogEntry[];
};

export interface ManifestEdgeMint {
  id: string;
  alg: string;
  signingKeySecret: string;
  kid?: string;
  claimsTemplate: Record<string, unknown>;
  ttlSeconds: number;
  audience?: string | null;
}

export interface ParsedManifest {
  product: ManifestProduct;
  catalog: ManifestCatalog;
  oidc?: ManifestOidc;
  profiles: ManifestProfile[];
  tiers: ManifestTier[];
  provisioning: ManifestProvisioning[];
  release?: ManifestRelease;
  edgeMint: ManifestEdgeMint[];
}

export type ParseManifestResult =
  | { ok: true; manifest: ParsedManifest }
  | { ok: false; errors: string[] };

const MODULES: ProductModule[] = [
  "licensing",
  "config",
  "releases",
  "oidc",
  "edgeMint",
];
const SLUG_RE = /^[a-z0-9-]+$/;
const ID_RE = /^[A-Za-z0-9._:-]+$/;
const SECRET_RE = /^[A-Z0-9][A-Z0-9_:-]{1,127}$/;
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const RELEASE_ACCESS_VALUES = ["public", "authenticated", "licensed"] as const;
const OIDC_PROVIDER_VALUES = ["platform", "custom"] as const;
const SECRET_DELIVERY_VALUES = [
  "serverOnly",
  "clientScoped",
  "edgeMint",
] as const;
const DEFAULT_RELEASE_ACCESS: ManifestReleaseAccessPolicy = {
  metadata: "public",
  artifacts: "public",
};

export function normalizeModules(raw: unknown): ProductModule[] {
  if (!isRecord(raw)) return ["licensing", "config"];
  const out: ProductModule[] = [];
  for (const module of MODULES) {
    const cfg = raw[module];
    if (isRecord(cfg) && cfg.enabled === true) out.push(module);
  }
  return out.length ? out : ["licensing", "config"];
}

export function validateManifestDocuments(
  manifest: ManifestDocuments,
): ValidationResult {
  const errors: ValidationMessage[] = [];
  const warnings: ValidationMessage[] = [];
  const productRoot = manifest.product;
  const modules = normalizeModules(productRoot.modules);
  const productNode = nestedProductDoc(productRoot);
  const licensing = asRecord(productRoot.licensing);
  const oidc = asRecord(productRoot.oidc);
  const secrets = asRecord(productRoot.secrets);

  if (
    productRoot.apiVersion !== undefined &&
    productRoot.apiVersion !== "pkey.dev/v1"
  ) {
    add(
      errors,
      "product",
      "/apiVersion",
      "invalid_api_version",
      "apiVersion must be pkey.dev/v1 when present.",
    );
  }
  const productSlug =
    typeof productNode.slug === "string" ? productNode.slug : "";
  if (!productSlug || !SLUG_RE.test(productSlug)) {
    add(
      errors,
      "product",
      "/product/slug",
      "invalid_slug",
      "product.slug must match ^[a-z0-9-]+$.",
    );
  }
  if (!stringAt(productNode, "name")) {
    add(
      errors,
      "product",
      "/product/name",
      "missing_name",
      "Add product.name.",
    );
  }
  for (const [key, path] of [
    [productNode.compatMin ?? productRoot.compatMin, "/compatMin"],
    [productNode.compatMax ?? productRoot.compatMax, "/compatMax"],
  ] as const) {
    if (
      key !== undefined &&
      (typeof key !== "string" || !SEMVER_RE.test(key))
    ) {
      add(
        errors,
        "product",
        path,
        "invalid_semver",
        "Version bounds must be semver strings.",
      );
    }
  }
  for (const [key, path] of [
    [
      productNode.defaultDeviceLimit ??
        productRoot.defaultDeviceLimit ??
        licensing.defaultDeviceLimit,
      "/licensing/defaultDeviceLimit",
    ],
    [
      productNode.defaultMaxOfflineDays ??
        productRoot.defaultMaxOfflineDays ??
        licensing.defaultMaxOfflineDays,
      "/licensing/defaultMaxOfflineDays",
    ],
  ] as const) {
    if (key !== undefined && !nonNegativeInteger(key)) {
      add(
        errors,
        "product",
        path,
        "invalid_number",
        "Value must be a non-negative integer.",
      );
    }
  }

  if (modules.includes("config")) {
    if (manifest.schema === undefined) {
      add(
        errors,
        "schema",
        "/",
        "missing_schema",
        "Config is enabled, so .pkey/schema.yaml or schema.json is required.",
      );
    } else {
      const catalog = normalizeCatalog(manifest.schema);
      if (!catalog) {
        add(
          errors,
          "schema",
          "/",
          "invalid_schema",
          "Schema must be a ProductCatalog object with entries[].",
        );
      } else {
        for (const issue of validateCatalogShape(catalog)) {
          add(errors, "schema", "/entries", "invalid_catalog_shape", issue);
        }
      }
    }
  }

  const profiles =
    arrayAt(productRoot, "profiles") ?? arrayAt(licensing, "profiles") ?? [];
  const profileIds = new Set<string>();
  for (const [i, raw] of profiles.entries()) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !ID_RE.test(raw.id)) {
      add(
        errors,
        "product",
        `/licensing/profiles/${i}/id`,
        "invalid_profile_id",
        "Profile ids must be non-empty simple identifiers.",
      );
      continue;
    }
    const record = raw;
    const id = raw.id;
    if (profileIds.has(id)) {
      add(
        errors,
        "product",
        `/licensing/profiles/${i}/id`,
        "duplicate_profile_id",
        "Profile ids must be unique.",
      );
    }
    profileIds.add(id);
    if (record.payload !== undefined && !isRecord(record.payload)) {
      add(
        errors,
        "product",
        `/licensing/profiles/${i}/payload`,
        "invalid_payload",
        "Profile payload must be an object.",
      );
    }
  }

  const tiers =
    arrayAt(productRoot, "tiers") ?? arrayAt(licensing, "tiers") ?? [];
  const tierIds = new Set<string>();
  for (const [i, raw] of tiers.entries()) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !ID_RE.test(raw.id)) {
      add(
        errors,
        "product",
        `/licensing/tiers/${i}/id`,
        "invalid_tier_id",
        "Tier ids must be non-empty simple identifiers.",
      );
      continue;
    }
    const record = raw;
    const id = raw.id;
    if (tierIds.has(id)) {
      add(
        errors,
        "product",
        `/licensing/tiers/${i}/id`,
        "duplicate_tier_id",
        "Tier ids must be unique.",
      );
    }
    tierIds.add(id);
    const profile = record.profileId ?? record.profile;
    if (
      profile !== undefined &&
      profile !== null &&
      typeof profile !== "string"
    ) {
      add(
        errors,
        "product",
        `/licensing/tiers/${i}/profile`,
        "invalid_profile_ref",
        "Tier profile must be a string profile id.",
      );
    } else if (typeof profile === "string" && !profileIds.has(profile)) {
      add(
        errors,
        "product",
        `/licensing/tiers/${i}/profile`,
        "unknown_profile_ref",
        `Tier references unknown profile ${profile}.`,
      );
    }
    if (
      record.policyDeviceLimit !== undefined &&
      !nonNegativeInteger(record.policyDeviceLimit)
    ) {
      add(
        errors,
        "product",
        `/licensing/tiers/${i}/policyDeviceLimit`,
        "invalid_device_limit",
        "policyDeviceLimit must be a non-negative integer.",
      );
    }
  }

  if (modules.includes("oidc") || productRoot.oidc !== undefined) {
    if (!isRecord(productRoot.oidc)) {
      add(
        errors,
        "product",
        "/oidc",
        "invalid_oidc",
        "oidc must be an object.",
      );
    } else {
      const provider = oidc.provider ?? "platform";
      if (!isOneOf(provider, OIDC_PROVIDER_VALUES)) {
        add(
          errors,
          "product",
          "/oidc/provider",
          "invalid_oidc_provider",
          "oidc.provider must be platform or custom.",
        );
      }
      if (provider === "custom") {
        if (!urlAt(oidc, "issuer")) {
          add(
            errors,
            "product",
            "/oidc/issuer",
            "invalid_oidc_issuer",
            "oidc.issuer must be an absolute URL for custom OIDC.",
          );
        }
        if (!stringAt(oidc, "clientId")) {
          add(
            errors,
            "product",
            "/oidc/clientId",
            "missing_oidc_client_id",
            "OIDC clientId is required for custom OIDC.",
          );
        }
      }
      const ref = oidc.clientSecretSecret ?? oidc.clientSecretRef;
      if (
        ref !== undefined &&
        (typeof ref !== "string" || !SECRET_RE.test(ref))
      ) {
        add(
          errors,
          "product",
          "/oidc/clientSecretRef",
          "invalid_secret_ref",
          "Secret refs must be stable uppercase names.",
        );
      }
      const redirects = arrayAt(oidc, "redirectUris") ?? [];
      for (const [i, uri] of redirects.entries()) {
        if (typeof uri !== "string" || !isUrl(uri)) {
          add(
            errors,
            "product",
            `/oidc/redirectUris/${i}`,
            "invalid_redirect_uri",
            "Redirect URIs must be absolute URLs.",
          );
        }
      }
    }
  }

  const relDoc =
    releaseRoot(manifest.release) ?? releaseRoot(productRoot.release);
  if (modules.includes("releases") || relDoc) {
    const relRoot = relDoc;
    if (!relRoot) {
      add(
        errors,
        "release",
        "/",
        "missing_release",
        "Releases are enabled, so .pkey/release.yaml or release.json is required.",
      );
    } else {
      const provider = asRecord(relRoot.provider);
      const owner = relRoot.ghOwner ?? provider.owner;
      const repo = relRoot.ghRepo ?? provider.repo;
      if (provider.type !== undefined && provider.type !== "github") {
        add(
          errors,
          "release",
          "/release/provider/type",
          "unsupported_release_provider",
          "Only github is implemented.",
        );
      }
      if (!stringAt({ owner }, "owner") || !stringAt({ repo }, "repo")) {
        add(
          errors,
          "release",
          "/release/provider",
          "missing_github_repo",
          "GitHub releases require owner and repo.",
        );
      }
      if (relRoot.access !== undefined && !isRecord(relRoot.access)) {
        add(
          errors,
          "release",
          "/release/access",
          "invalid_release_access",
          "release.access must be an object when present.",
        );
      } else {
        const access = asRecord(relRoot.access);
        for (const key of ["metadata", "artifacts"] as const) {
          const value = access[key];
          if (value !== undefined && !isOneOf(value, RELEASE_ACCESS_VALUES)) {
            add(
              errors,
              "release",
              `/release/access/${key}`,
              "invalid_release_access",
              "release.access values must be public, authenticated, or licensed.",
            );
          }
        }
      }
    }
  }

  const provisioning = arrayAt(productRoot, "provisioning") ?? [];
  for (const [i, raw] of provisioning.entries()) {
    if (!isRecord(raw) || !stringAt(raw, "claim")) {
      add(
        errors,
        "product",
        `/provisioning/${i}/claim`,
        "invalid_claim",
        "Provisioning hooks require claim.",
      );
    }
    if (
      isRecord(raw) &&
      raw.secretKey !== undefined &&
      (typeof raw.secretKey !== "string" || !ID_RE.test(raw.secretKey))
    ) {
      add(
        errors,
        "product",
        `/provisioning/${i}/secretKey`,
        "invalid_secret_key",
        "Provisioned secret keys must be catalog identifiers.",
      );
    }
  }

  const edgeMint =
    arrayAt(productRoot, "edgeMint") ??
    arrayAt(asRecord(manifest.release), "edgeMint") ??
    [];
  for (const [i, raw] of edgeMint.entries()) {
    if (!isRecord(raw) || !stringAt(raw, "id")) {
      add(
        errors,
        "release",
        `/edgeMint/${i}/id`,
        "invalid_edge_mint_id",
        "Edge mint recipes require id.",
      );
      continue;
    }
    if (!["ES256", "RS256", "EdDSA"].includes(String(raw.alg ?? ""))) {
      add(
        errors,
        "release",
        `/edgeMint/${i}/alg`,
        "invalid_edge_mint_alg",
        "Edge mint alg must be ES256, RS256, or EdDSA.",
      );
    }
    const ref = raw.signingKeySecret;
    if (typeof ref !== "string" || !SECRET_RE.test(ref)) {
      add(
        errors,
        "release",
        `/edgeMint/${i}/signingKeySecret`,
        "invalid_secret_ref",
        "Edge mint signing key refs must be stable uppercase names.",
      );
    }
    if (raw.ttlSeconds !== undefined && !positiveInteger(raw.ttlSeconds)) {
      add(
        errors,
        "release",
        `/edgeMint/${i}/ttlSeconds`,
        "invalid_ttl",
        "Edge mint TTL must be a positive integer.",
      );
    }
  }

  const requiredSecrets = collectRequiredSecrets(
    secrets,
    productRoot,
    manifest.release,
  );
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

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    enabledModules: modules,
    requiredSecrets,
  };
}

export function parseManifest(
  files: Record<string, string>,
): ParseManifestResult {
  const errors: string[] = [];
  const docs: Record<string, unknown> = {};
  for (const name of ["schema", "product", "release"] as const) {
    const raw = files[name];
    if (raw === undefined) continue;
    const res = parseDocument(name, raw);
    if ("error" in res) errors.push(res.error);
    else docs[name] = res.value;
  }
  if (files.schema === undefined)
    errors.push("schema: required (.pkey/schema.{json,yaml,yml} is missing)");
  if (files.product === undefined)
    errors.push("product: required (.pkey/product.{json,yaml,yml} is missing)");
  if (errors.length) return { ok: false, errors };
  if (!isRecord(docs.product))
    return { ok: false, errors: ["product: must be an object"] };

  const validation = validateManifestDocuments({
    product: docs.product,
    schema: docs.schema,
    release: docs.release,
  });
  if (!validation.ok)
    return {
      ok: false,
      errors: validation.errors.map((e) => `${e.file}${e.path}: ${e.message}`),
    };

  const productRoot = docs.product;
  const prod = nestedProductDoc(productRoot);
  const licensing = asRecord(productRoot.licensing);
  const catalog = normalizeCatalog(docs.schema) as ManifestCatalog;
  const releaseDoc =
    releaseRoot(docs.release) ?? releaseRoot(productRoot.release);
  const oidcRoot = asRecord(productRoot.oidc);
  const rawProfiles =
    arrayAt(productRoot, "profiles") ?? arrayAt(licensing, "profiles") ?? [];
  const rawTiers =
    arrayAt(productRoot, "tiers") ?? arrayAt(licensing, "tiers") ?? [];
  const rawProvisioning = arrayAt(productRoot, "provisioning") ?? [];
  const rawEdgeMint =
    arrayAt(productRoot, "edgeMint") ??
    arrayAt(asRecord(docs.release), "edgeMint") ??
    [];

  const parsed: ParsedManifest = {
    product: {
      slug: String(prod.slug),
      name: String(prod.name ?? prod.slug),
      compatMin: String(prod.compatMin ?? productRoot.compatMin ?? "0.0.0"),
      compatMax: String(prod.compatMax ?? productRoot.compatMax ?? "99.0.0"),
      defaultMaxOfflineDays: Number(
        prod.defaultMaxOfflineDays ??
          productRoot.defaultMaxOfflineDays ??
          licensing.defaultMaxOfflineDays ??
          30,
      ),
      defaultDeviceLimit: Number(
        prod.defaultDeviceLimit ??
          productRoot.defaultDeviceLimit ??
          licensing.defaultDeviceLimit ??
          5,
      ),
      adminGroup: String(prod.adminGroup ?? productRoot.adminGroup ?? "admin"),
    },
    catalog,
    profiles: rawProfiles.map(normalizeProfile).filter(notNull),
    tiers: rawTiers.map(normalizeTier).filter(notNull),
    provisioning: rawProvisioning.map(normalizeProvisioning).filter(notNull),
    edgeMint: rawEdgeMint.map(normalizeEdgeMint).filter(notNull),
  };

  if (productRoot.oidc !== undefined) {
    const provider = isOneOf(oidcRoot.provider, OIDC_PROVIDER_VALUES)
      ? oidcRoot.provider
      : "platform";
    parsed.oidc = {
      provider,
      issuer: String(oidcRoot.issuer ?? ""),
      clientId: String(oidcRoot.clientId ?? ""),
      clientSecretSecret: String(
        oidcRoot.clientSecretSecret ?? oidcRoot.clientSecretRef ?? "",
      ),
      redirectUris: arrayAt(oidcRoot, "redirectUris")?.filter(isString) ?? [],
      groupRoleMap: asRecord(oidcRoot.groupRoleMap),
    };
  }
  if (releaseDoc) parsed.release = normalizeRelease(releaseDoc);
  return { ok: true, manifest: parsed };
}

function normalizeRelease(rel: Record<string, unknown>): ManifestRelease {
  const provider = asRecord(rel.provider);
  return {
    ghOwner: String(rel.ghOwner ?? provider.owner ?? ""),
    ghRepo: String(rel.ghRepo ?? provider.repo ?? ""),
    binaryName: String(rel.binaryName ?? ""),
    channelWorkflow: String(rel.channelWorkflow ?? ""),
    betaBranch: String(rel.betaBranch ?? "main"),
    summaryMarker: String(rel.summaryMarker ?? "pkey:summary"),
    sparkleEd25519Pub: String(rel.sparkleEd25519Pub ?? ""),
    artifactPolicy: normalizeArtifactPolicy(rel.artifactPolicy),
    access: normalizeReleaseAccess(rel.access),
  };
}

function normalizeReleaseAccess(raw: unknown): ManifestReleaseAccessPolicy {
  if (!isRecord(raw)) return { ...DEFAULT_RELEASE_ACCESS };
  return {
    metadata: normalizeReleaseAccessValue(
      raw.metadata,
      DEFAULT_RELEASE_ACCESS.metadata,
    ),
    artifacts: normalizeReleaseAccessValue(
      raw.artifacts,
      DEFAULT_RELEASE_ACCESS.artifacts,
    ),
  };
}

function normalizeReleaseAccessValue(
  raw: unknown,
  fallback: ManifestReleaseAccess,
): ManifestReleaseAccess {
  if (!isOneOf(raw, RELEASE_ACCESS_VALUES)) return fallback;
  return raw;
}

function normalizeArtifactPolicy(
  raw: unknown,
): ManifestReleaseArtifactPolicy | null {
  if (!isRecord(raw)) return null;
  return {
    channels: arrayAt(raw, "channels")?.filter(isString) ?? [],
    architectures: arrayAt(raw, "architectures")?.filter(isString) ?? [],
    requireDmg: raw.requireDmg === true,
    requireCli: raw.requireCli === true,
    requireSparkleSignature: raw.requireSparkleSignature !== false,
    allowAmbiguousAssets: raw.allowAmbiguousAssets === true,
  };
}

function normalizeProfile(raw: unknown): ManifestProfile | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.length === 0)
    return null;
  const id = raw.id;
  return {
    id,
    name: String(raw.name ?? raw.label ?? id),
    description: typeof raw.description === "string" ? raw.description : null,
    payload: asRecord(raw.payload),
  };
}

function normalizeTier(raw: unknown): ManifestTier | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.length === 0)
    return null;
  const id = raw.id;
  return {
    id,
    label: String(raw.label ?? id),
    profileId:
      typeof raw.profileId === "string"
        ? raw.profileId
        : typeof raw.profile === "string"
          ? raw.profile
          : null,
    policyExpiryDays:
      typeof raw.policyExpiryDays === "number"
        ? raw.policyExpiryDays
        : typeof raw.expiryDays === "number"
          ? raw.expiryDays
          : typeof raw.maxOfflineDays === "number"
            ? raw.maxOfflineDays
            : null,
    policyDeviceLimit:
      typeof raw.policyDeviceLimit === "number" ? raw.policyDeviceLimit : null,
    channels: arrayAt(raw, "channels")?.filter(isString) ?? [],
    minVersion: typeof raw.minVersion === "string" ? raw.minVersion : null,
    maxVersion: typeof raw.maxVersion === "string" ? raw.maxVersion : null,
  };
}

function normalizeProvisioning(raw: unknown): ManifestProvisioning | null {
  if (
    !isRecord(raw) ||
    typeof raw.claim !== "string" ||
    raw.claim.length === 0
  ) {
    return null;
  }
  const claim = raw.claim;
  return {
    claim,
    entitlementKey:
      typeof raw.entitlementKey === "string" ? raw.entitlementKey : undefined,
    entitlementValue: raw.entitlementValue,
    secretKey: typeof raw.secretKey === "string" ? raw.secretKey : undefined,
    secretUrlTemplate:
      typeof raw.secretUrlTemplate === "string"
        ? raw.secretUrlTemplate
        : undefined,
    allowedHosts: arrayAt(raw, "allowedHosts")?.filter(isString),
  };
}

function normalizeEdgeMint(raw: unknown): ManifestEdgeMint | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.length === 0)
    return null;
  const id = raw.id;
  return {
    id,
    alg: String(raw.alg ?? ""),
    signingKeySecret: String(raw.signingKeySecret ?? ""),
    kid: typeof raw.kid === "string" ? raw.kid : undefined,
    claimsTemplate: asRecord(raw.claimsTemplate),
    ttlSeconds: typeof raw.ttlSeconds === "number" ? raw.ttlSeconds : 3600,
    audience: typeof raw.audience === "string" ? raw.audience : null,
  };
}

function collectRequiredSecrets(
  secrets: Record<string, unknown>,
  product: Record<string, unknown>,
  release: unknown,
): string[] {
  const names = new Set<string>();
  const required = arrayAt(secrets, "required") ?? [];
  for (const item of required) {
    if (isRecord(item) && typeof item.name === "string" && item.name) {
      names.add(item.name);
    } else if (typeof item === "string") names.add(item);
  }
  const oidc = asRecord(product.oidc);
  const oidcSecret = oidc.clientSecretSecret ?? oidc.clientSecretRef;
  const oidcProvider =
    isOneOf(oidc.provider, OIDC_PROVIDER_VALUES) && oidc.provider === "custom"
      ? "custom"
      : "platform";
  if (oidcProvider === "custom" && typeof oidcSecret === "string" && oidcSecret)
    names.add(oidcSecret);
  const edgeMint =
    arrayAt(product, "edgeMint") ??
    arrayAt(asRecord(release), "edgeMint") ??
    [];
  for (const item of edgeMint) {
    if (!isRecord(item)) continue;
    const ref = item.signingKeySecret;
    if (typeof ref === "string" && ref) names.add(ref);
  }
  return [...names].sort();
}

function parseDocument(
  name: string,
  raw: string,
): { value: unknown } | { error: string } {
  try {
    return { value: JSON.parse(raw) };
  } catch {
    // fall through to YAML
  }
  try {
    return { value: parseYaml(raw) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `${name}: not valid JSON or YAML (${msg})` };
  }
}

function normalizeCatalog(parsed: unknown): ProductCatalog | null {
  if (!isRecord(parsed)) return null;
  if (Array.isArray(parsed.entries)) return parsed as unknown as ProductCatalog;
  if (Array.isArray(parsed.catalog)) {
    return {
      schemaVersion: Number(parsed.schemaVersion ?? 1),
      entries: parsed.catalog,
    } as unknown as ProductCatalog;
  }
  return null;
}

function validateCatalogShape(catalog: ProductCatalog): string[] {
  const issues: string[] = [];
  const keys = new Set<string>();
  if (!nonNegativeInteger(catalog.schemaVersion)) {
    issues.push("catalog.schemaVersion must be a non-negative integer.");
  }
  for (const [i, raw] of catalog.entries.entries()) {
    if (!isRecord(raw)) {
      issues.push(`entries[${i}] must be an object.`);
      continue;
    }
    const entry = raw;
    for (const field of ["key", "category", "label"] as const) {
      if (typeof entry[field] !== "string" || entry[field].length === 0) {
        issues.push(`entries[${i}].${field} must be a non-empty string.`);
      }
    }
    if (typeof entry.description !== "string") {
      issues.push(`entries[${i}].description must be a string.`);
    }
    if (!["config", "secret", "flag"].includes(String(entry.kind ?? ""))) {
      issues.push(`entries[${i}].kind must be config, secret, or flag.`);
    }
    if (entry.delivery !== undefined) {
      if (entry.kind !== "secret") {
        issues.push(`entries[${i}].delivery is only valid for secret entries.`);
      } else if (!isOneOf(entry.delivery, SECRET_DELIVERY_VALUES)) {
        issues.push(
          `entries[${i}].delivery must be serverOnly, clientScoped, or edgeMint.`,
        );
      }
    }
    if (typeof entry.key === "string") {
      if (!ID_RE.test(entry.key))
        issues.push(`entries[${i}].key is not valid.`);
      if (keys.has(entry.key)) issues.push(`entries[${i}].key is duplicated.`);
      keys.add(entry.key);
    }
    if (!isRecord(entry.schema)) {
      issues.push(`entries[${i}].schema must be an object.`);
      continue;
    }
    const type = entry.schema.type;
    if (
      type !== undefined &&
      !(
        typeof type === "string" ||
        (Array.isArray(type) && type.every((v) => typeof v === "string"))
      )
    ) {
      issues.push(
        `entries[${i}].schema.type must be a string or string array.`,
      );
    }
  }
  return issues;
}

function releaseRoot(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return isRecord(value.release) ? value.release : value;
}

function nestedProductDoc(p: Record<string, unknown>): Record<string, unknown> {
  return isRecord(p.product) ? p.product : p;
}

function asRecord(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function arrayAt(
  v: Record<string, unknown>,
  key: string,
): unknown[] | undefined {
  return Array.isArray(v[key]) ? v[key] : undefined;
}

function stringAt<T extends Record<string, unknown>>(
  v: T | undefined,
  key: string,
): v is T & Record<typeof key, string> {
  return typeof v?.[key] === "string" && v[key].length > 0;
}

function urlAt(v: Record<string, unknown>, key: string): boolean {
  return typeof v[key] === "string" && isUrl(v[key]);
}

function isUrl(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    const url = new URL(v);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function positiveInteger(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function nonNegativeInteger(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): value is T[number] {
  return typeof value === "string" && allowed.includes(value as T[number]);
}

function notNull<T>(v: T | null): v is T {
  return v !== null;
}

function add(
  list: ValidationMessage[],
  file: ValidationMessage["file"],
  path: string,
  code: string,
  message: string,
): void {
  list.push({ file, path, code, message });
}
