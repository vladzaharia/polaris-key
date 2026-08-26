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

/** A product-declared companion-application probe the client answers present/absent. */
export interface ManifestProbe {
  id: string;
  label: string;
  macos?: string;
  windows?: string;
  linux?: string;
}

/** Per-product hardware-fingerprint policy (migrations/0010_fingerprint.sql). */
export interface ManifestFingerprint {
  /** Per-product opt-out. When false, clients are told not to collect hardware components. */
  enabled: boolean;
  /** Default enforcement strength; a tier's own policy overrides it. */
  defaultMode: "off" | "lenient" | "normal" | "strict";
  probes: ManifestProbe[];
}

/** Per-product auto-issue ("always free") policy (migrations/0011_auto_issue.sql). */
export interface ManifestAutoIssue {
  enabled: boolean;
  /** The tier an auto-issued license lands on. Required when enabled. */
  tierId: string | null;
  mode: "anonymous" | "oidcDefault" | "both";
  rateLimitPerHour: number;
}

export interface ManifestTier {
  id: string;
  label: string;
  profileId: string | null;
  policyExpiryDays: number | null;
  policyDeviceLimit: number | null;
  /** Fingerprint enforcement for this tier; null inherits the product default. */
  policyFingerprint: "off" | "lenient" | "normal" | "strict" | null;
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

/**
 * Repo-owned artifact expectations. `requireSparkleSignature` is deliberately NOT part of
 * this shape: signature enforcement is an operator-owned control and a repo must not be able
 * to disable the platform's own check by pushing one line of YAML (R6-03).
 */
export interface ManifestReleaseArtifactPolicy {
  channels: string[];
  architectures: string[];
  requireDmg: boolean;
  requireCli: boolean;
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
  fingerprint?: ManifestFingerprint;
  autoIssue?: ManifestAutoIssue;
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
// Release strings reach a shell (`install.sh`), a GitHub API path, or a RegExp source. Every
// one of them is character-class-bounded HERE, at the ingest boundary, so a `.pkey/` push can
// never smuggle a quote, a newline, a `$`, a backtick, or a dot-segment downstream (R6-01,
// R6-07). Reject, never coerce: a manifest that fails these is not applied at all.
/** `binaryName` — interpolated into the served POSIX shell installer. */
const BINARY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** `ghOwner` / `ghRepo` — interpolated unencoded into `api.github.com` paths. */
const GH_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** `channelWorkflow` — a workflow filename or numeric id in an API path segment. */
const CHANNEL_WORKFLOW_RE = /^(?:[0-9]{1,20}|[A-Za-z0-9._-]{1,100}\.ya?ml)$/;
/** `betaBranch` — a git branch name used as a query value. */
const BRANCH_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,254}$/;
/** `summaryMarker` — embedded (escaped) in a RegExp source; capped to bound the pattern. */
const SUMMARY_MARKER_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
/** `sparkleEd25519Pub` — a base64/base64url public key (or an operator placeholder). */
const SPARKLE_PUB_RE = /^[A-Za-z0-9+/=_-]{1,512}$/;
const RELEASE_ACCESS_VALUES = ["public", "authenticated", "licensed"] as const;
const OIDC_PROVIDER_VALUES = ["platform", "custom"] as const;
const FINGERPRINT_MODE_VALUES = ["off", "lenient", "normal", "strict"] as const;
const AUTO_ISSUE_MODE_VALUES = ["anonymous", "oidcDefault", "both"] as const;
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
      releaseString(
        errors,
        owner,
        "/release/provider/owner",
        "invalid_github_owner",
        GH_SLUG_RE,
        "release owner must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$.",
      );
      releaseString(
        errors,
        repo,
        "/release/provider/repo",
        "invalid_github_repo",
        GH_SLUG_RE,
        "release repo must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$.",
      );
      releaseString(
        errors,
        relRoot.binaryName,
        "/release/binaryName",
        "invalid_binary_name",
        BINARY_NAME_RE,
        "release.binaryName must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ — it is interpolated into the published install.sh.",
      );
      releaseString(
        errors,
        relRoot.channelWorkflow,
        "/release/channelWorkflow",
        "invalid_channel_workflow",
        CHANNEL_WORKFLOW_RE,
        "release.channelWorkflow must be a workflow filename (*.yml / *.yaml) or a numeric workflow id.",
      );
      releaseString(
        errors,
        relRoot.betaBranch,
        "/release/betaBranch",
        "invalid_beta_branch",
        BRANCH_RE,
        "release.betaBranch must be a plain git branch name.",
      );
      releaseString(
        errors,
        relRoot.summaryMarker,
        "/release/summaryMarker",
        "invalid_summary_marker",
        SUMMARY_MARKER_RE,
        "release.summaryMarker must match ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$.",
      );
      releaseString(
        errors,
        relRoot.sparkleEd25519Pub,
        "/release/sparkleEd25519Pub",
        "invalid_sparkle_pub",
        SPARKLE_PUB_RE,
        "release.sparkleEd25519Pub must be a base64/base64url key of at most 512 characters.",
      );
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
  if (productRoot.fingerprint !== undefined) {
    parsed.fingerprint = normalizeFingerprint(productRoot.fingerprint);
  }
  if (productRoot.autoIssue !== undefined) {
    parsed.autoIssue = normalizeAutoIssue(productRoot.autoIssue);
  }
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
    // `requireSparkleSignature` is intentionally dropped, not copied: see the interface note.
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
    policyFingerprint: isOneOf(raw.policyFingerprint, FINGERPRINT_MODE_VALUES)
      ? raw.policyFingerprint
      : null,
    channels: arrayAt(raw, "channels")?.filter(isString) ?? [],
    minVersion: typeof raw.minVersion === "string" ? raw.minVersion : null,
    maxVersion: typeof raw.maxVersion === "string" ? raw.maxVersion : null,
  };
}

function normalizeProbe(raw: unknown): ManifestProbe | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.length === 0) {
    return null;
  }
  const probe: ManifestProbe = {
    id: raw.id,
    label: typeof raw.label === "string" ? raw.label : raw.id,
  };
  if (typeof raw.macos === "string") probe.macos = raw.macos;
  if (typeof raw.windows === "string") probe.windows = raw.windows;
  if (typeof raw.linux === "string") probe.linux = raw.linux;
  return probe;
}

function normalizeFingerprint(raw: unknown): ManifestFingerprint {
  const record = isRecord(raw) ? raw : {};
  return {
    // Fingerprinting is ON unless a product explicitly opts out.
    enabled: record.enabled === false ? false : true,
    defaultMode: isOneOf(record.defaultMode, FINGERPRINT_MODE_VALUES)
      ? record.defaultMode
      : "normal",
    probes: (arrayAt(record, "probes") ?? [])
      .map(normalizeProbe)
      .filter(notNull),
  };
}

function normalizeAutoIssue(raw: unknown): ManifestAutoIssue {
  const record = isRecord(raw) ? raw : {};
  const tierId =
    typeof record.tierId === "string" && record.tierId ? record.tierId : null;
  return {
    // A policy with no tier can't issue anything coherent, so it counts as disabled rather
    // than quietly minting tier-less licenses.
    enabled: record.enabled === true && tierId !== null,
    tierId,
    mode: isOneOf(record.mode, AUTO_ISSUE_MODE_VALUES)
      ? record.mode
      : "anonymous",
    rateLimitPerHour:
      typeof record.rateLimitPerHour === "number" &&
      record.rateLimitPerHour >= 0
        ? Math.trunc(record.rateLimitPerHour)
        : 10,
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

/**
 * Enforce a character class on an optional release string. Absent/empty means "unset" (the
 * worker substitutes its own default), so only present values are checked — but a present
 * value that fails the class is a hard error, never a coerced one.
 */
function releaseString(
  errors: ValidationMessage[],
  value: unknown,
  path: string,
  code: string,
  re: RegExp,
  message: string,
): void {
  if (value === undefined || value === null || value === "") return;
  if (typeof value !== "string" || !re.test(value)) {
    add(errors, "release", path, code, message);
  }
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
