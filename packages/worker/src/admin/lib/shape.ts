/**
 * Output shaping for the admin surface: license summaries, the product-registry view, and
 * the active-catalog loader used for value validation + redaction.
 */

import { listClaims } from "../../core/settingsClaims.js";
import { Catalog } from "@polaris-key/catalog";
import type { Db } from "../../db/types.js";
import type { Env } from "../../env.js";
import {
  listDevicesByLicense,
  getActiveSchema,
  listLicenseProfiles,
  getProductSyncState,
  type LicenseRow,
  type ProductRow,
  type ProductSyncStateRow,
} from "../../repo.js";
import { loadPublicSigningKey } from "../../core/products.js";
import { serviceStateOf } from "../../core/services.js";
import {
  getPortalProductSettings,
  portalProductSettingsView,
} from "../../services/identity/portal/repo.js";
import { shipsDmgs } from "../../services/release/config.js";
import { packageFeedsOf } from "../../services/distribution/registryFeeds.js";
import { latestReleaseHasDmg } from "../../services/release/store.js";
import { readAppDeliverable } from "../../services/release/descriptor.js";
import { hasArtifactMap } from "../../services/release/artifactMap.js";
import { countKeysByLicense } from "../repo.js";
import { subjectFor } from "../../core/accountSubjects.js";
import {
  approvalMismatch,
  listEdgeMintRecipesWithApprovals,
  mintApprovalBasis,
  type MintPolicyProduct,
} from "../../services/config/mint.js";
import { parseAutoIssue } from "../../core/fingerprint.js";

interface RequiredSecretStatus {
  name: string;
  configured: boolean;
  sources: string[];
}

interface OidcSetupRow {
  provider: string | null;
  issuer: string | null;
  client_id: string | null;
  client_secret_secret: string | null;
}

interface EdgeMintSetupRow {
  id: string;
  signing_key_secret: string | null;
  /** P0-12: whether an operator approved this recipe as it currently stands. */
  approval: "approved" | "pending" | "changed";
}

interface ReleaseSetupRow {
  gh_owner: string | null;
  gh_repo: string | null;
  gh_installation_id: number | null;
  binary_name: string | null;
  sparkle_ed25519_pub: string | null;
  artifact_policy_json: string | null;
}

/**
 * R11-06 — the ONE guarded reader for every `_json` column on the admin surface.
 *
 * No `_json` column has a `json_valid()` constraint behind it, and a truncated D1 write, a
 * manual `wrangler d1 execute` repair, or any future writer that forgets `JSON.stringify`
 * produces a value that is accepted silently and then throws a `SyntaxError` out of whatever
 * handler reads it next. A corrupt column has to DEGRADE, not 500 — most sharply for
 * `licenses.channels_json`, which `licenseSummary` reads for every row of the license list, so
 * one bad row used to take down the entire admin view including the one an operator would use
 * to repair it.
 */
export function parseJsonColumn<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/** A `_json` column that must read back as an array of strings; anything else is dropped. */
export function parseJsonList(value: string | null | undefined): string[] {
  const parsed = parseJsonColumn<unknown>(value);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function syncStateView(
  row: ProductSyncStateRow | null,
): Record<string, unknown> | null {
  if (!row) return null;
  return {
    source: row.source,
    status: row.status,
    lastCheckedAt: row.last_checked_at,
    lastSyncedAt: row.last_synced_at,
    commitSha: row.commit_sha,
    changedPaths: parseJsonList(row.changed_paths_json),
    updated: parseJsonList(row.updated_json),
    errors: parseJsonList(row.errors_json),
    message: row.message,
  };
}

/** Load + compile a product's active catalog (for value validation). Null if none/invalid. */
export async function loadCatalog(
  db: Db,
  product: string,
): Promise<Catalog | null> {
  const row = await getActiveSchema(db, product);
  if (!row) return null;
  try {
    return new Catalog(JSON.parse(row.catalog_json));
  } catch {
    return null;
  }
}

/** The list/detail summary projection of a license row (with derived key + device counts). */
export async function licenseSummary(
  db: Db,
  product: string,
  row: LicenseRow,
): Promise<Record<string, unknown>> {
  const keyCounts = await countKeysByLicense(db, product, row.id);
  const devices = await listDevicesByLicense(db, product, row.id);
  const profiles = await listLicenseProfiles(db, product, row.id);
  // PX-W17: the owner as this product sees them — the pairwise subject, never the account id
  // (S-16 §5.1). Subjects are platform-wide, so this is set for every product whatever its
  // Identity toggle; `null` for a floating licence.
  const ownerSubject = row.account_id
    ? await subjectFor(
        db,
        row.account_id,
        product,
        Math.floor(Date.now() / 1000),
      )
    : null;
  return {
    id: row.id,
    name: row.name ?? "",
    email: row.email ?? "",
    status: row.status,
    activatedAt: row.activated_at,
    expiresAt: row.expires_at,
    keyCount: keyCounts.total,
    activeKeyCount: keyCounts.active,
    deviceCount: devices.filter((m) => m.status === "authorized").length,
    profile: profiles[0]?.profile_id ?? null,
    profiles: profiles.map((p) => p.profile_id),
    tier: row.tier_id,
    // R11-06: guarded — a single corrupt channels_json must not 500 the whole license list.
    channels: parseJsonList(row.channels_json),
    minVersion: row.min_version,
    maxVersion: row.max_version,
    ownerSubject,
    identityProvider: row.sub ? "oidc" : "manual",
    // How the row was minted (`admin`, `oidc`, `enroll`): decides whether it may be deleted.
    origin: row.origin ?? "admin",
    oidcSubject: row.sub ?? undefined,
    modifiedBy: row.modified_by ?? undefined,
    modifiedAt: row.modified_at,
  };
}

/** The registry projection of a product row. */
export async function productView(
  env: Env,
  db: Db,
  p: ProductRow,
  now: number = Math.floor(Date.now() / 1000),
): Promise<Record<string, unknown>> {
  const activeKey = await loadPublicSigningKey(db, p.slug);
  const signingKid = activeKey?.kid ?? p.signing_kid;
  const signingPublicKey = activeKey?.publicKey ?? p.signing_pub;
  const signingAlg = activeKey?.alg ?? "Ed25519";
  const jwksUrl = `/${p.slug}/.well-known/jwks.json`;
  const signing = signingPublicKey
    ? {
        kid: signingKid,
        alg: signingAlg,
        publicKey: signingPublicKey,
        jwksUrl,
        trustKeys: { [signingKid]: signingPublicKey },
      }
    : null;
  // D-15: the console's nav is a projection of enablement, and the SHELL needs the answer before
  // it can draw the sidebar that frames the view. Carrying it on the product row the shell
  // already loads is what keeps the nav from popping in after its own content; a second
  // round-trip to `…/services` would be a strictly slower way to render the same tree.
  const services = serviceStateOf(p);
  const setup = await productSetupView(
    env,
    db,
    p.slug,
    Boolean(signingPublicKey),
    services.services.update.enabled,
    {
      slug: p.slug,
      registration: services.effectiveRegistration,
      autoIssue: parseAutoIssue(p.auto_issue_json),
      services: services.services,
    },
  );
  const portalSettings = await getPortalProductSettings(db, p.slug);
  return {
    slug: p.slug,
    name: p.name,
    // F-03: the platform's own product (the package-feeds owner of our SDKs). The console keeps it
    // out of the product switcher and the Products registry; it is reached from Platform.
    system: p.system === 1,
    // F-11: the operator-owned `packageFeeds` sub-capability (`dist_registry_owners`). The shell
    // shows Distribution → Package feeds only while it is on, so it rides the row the shell loads.
    packageFeeds: (await packageFeedsOf(db, p.slug)).enabled,
    releaseSource: p.release_source ?? "manual",
    signingKid,
    jwksUrl,
    signing,
    modules: setup.modules,
    portalSettings: portalProductSettingsView(portalSettings),
    services: services.services,
    registration: services.registration,
    effectiveRegistration: services.effectiveRegistration,
    servicesSource: services.source,
    setup,
    onboarding: {
      setup,
      modules: setup.modules,
      baseUrl: `/${p.slug}`,
      // Wire v3 route names. `/<p>/config` and `/<p>/activate` are GONE — the fused document
      // split in two and activation moved under the license namespace — so emitting the old
      // spellings here handed an operator two 404s from the one panel that exists to tell them
      // where to point a client.
      configUrl: `/${p.slug}/config/document`,
      activateUrl: `/${p.slug}/license/activate`,
      jwksUrl,
      nextActions: setup.nextActions,
    },
    compatMin: p.compat_min,
    compatMax: p.compat_max,
    defaultMaxOfflineDays: p.default_max_offline_days,
    defaultDeviceLimit: p.default_device_limit,
    adminGroup: p.admin_group,
    // ST-01b: the column-backed settings the console has claimed from the manifest (the resync
    // leaves these alone until a Revert). Empty for a product with no manifest to claim from.
    claims: await listClaims(db, p.slug, now),
    createdAt: p.created_at,
    modifiedAt: p.modified_at,
  };
}

/**
 * Which product secrets the product's configuration names, and what names each (a custom OIDC
 * provider's client secret, each edge-mint recipe's signing key). Shared by the setup projection
 * and the secrets inventory (A-5), so both say the same thing.
 */
function collectRequiredSecrets(
  oidc: Pick<OidcSetupRow, "provider" | "client_secret_secret"> | null,
  edgeMint: Pick<EdgeMintSetupRow, "id" | "signing_key_secret">[],
): Map<string, Set<string>> {
  const secretSources = new Map<string, Set<string>>();
  const requireSecret = (name: string | null | undefined, source: string) => {
    if (!name) return;
    const sources = secretSources.get(name) ?? new Set<string>();
    sources.add(source);
    secretSources.set(name, sources);
  };
  if ((oidc?.provider ?? "platform") === "custom") {
    requireSecret(oidc?.client_secret_secret, "OIDC client secret");
  }
  for (const row of edgeMint) {
    requireSecret(row.signing_key_secret, `Edge mint ${row.id}`);
  }
  return secretSources;
}

/** One row of the secrets inventory (A-5): metadata only, never a value. */
export interface ProductSecretListing {
  name: string;
  /** Stored at all. A required secret that was never set is listed with `false`. */
  configured: boolean;
  /** `null` for a secret that is not stored. */
  usage: "general" | "edge-mint" | null;
  createdAt: number | null;
  updatedAt: number | null;
  /** What in the product's configuration names it ("OIDC client secret", "Edge mint studio"). */
  requiredBy: string[];
}

/**
 * The product's secrets inventory (A-5): every stored secret's name, usage and timestamps, plus
 * every secret the configuration requires but nobody has set. Values are never read here: the
 * sealed column is not even selected.
 */
export async function listProductSecretsView(
  db: Db,
  product: string,
): Promise<ProductSecretListing[]> {
  const oidc = await db.first<OidcSetupRow>(
    "SELECT provider, issuer, client_id, client_secret_secret FROM oidc_config WHERE product = ?",
    product,
  );
  const recipes = (await listEdgeMintRecipesWithApprovals(db, product)).map(
    ({ recipe }) => ({
      id: recipe.id,
      signing_key_secret: recipe.signing_key_secret,
    }),
  );
  const required = collectRequiredSecrets(oidc, recipes);
  const stored = await db.all<{
    name: string;
    usage: string | null;
    created_at: number;
    modified_at: number;
  }>(
    "SELECT name, usage, created_at, modified_at FROM product_secrets WHERE product = ? ORDER BY name",
    product,
  );
  const out: ProductSecretListing[] = stored.map((row) => ({
    name: row.name,
    configured: true,
    usage: row.usage === "edge-mint" ? "edge-mint" : "general",
    createdAt: row.created_at,
    updatedAt: row.modified_at,
    requiredBy: [...(required.get(row.name) ?? [])],
  }));
  const storedNames = new Set(stored.map((row) => row.name));
  for (const [name, sources] of required) {
    if (storedNames.has(name)) continue;
    out.push({
      name,
      configured: false,
      usage: null,
      createdAt: null,
      updatedAt: null,
      requiredBy: [...sources],
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function productSetupView(
  env: Env,
  db: Db,
  product: string,
  signingConfigured: boolean,
  updateEnabled: boolean,
  /** The product policy an edge-mint approval is checked against (`approvalMismatch`): an
   *  approval that no longer applies does not count as approved here either. */
  mintPolicy: MintPolicyProduct,
): Promise<Record<string, unknown>> {
  const oidc = await db.first<OidcSetupRow>(
    "SELECT provider, issuer, client_id, client_secret_secret FROM oidc_config WHERE product = ?",
    product,
  );
  const mintBasis = await mintApprovalBasis(db, mintPolicy);
  const edgeMint: EdgeMintSetupRow[] = (
    await listEdgeMintRecipesWithApprovals(db, product)
  ).map(({ recipe, approval }) => ({
    id: recipe.id,
    signing_key_secret: recipe.signing_key_secret,
    approval: !approval
      ? "pending"
      : approvalMismatch(recipe, approval, mintBasis).length === 0
        ? "approved"
        : "changed",
  }));
  const release = await db.first<ReleaseSetupRow>(
    `SELECT gh_owner, gh_repo, gh_installation_id, binary_name, sparkle_ed25519_pub,
            artifact_policy_json
      FROM release_config WHERE product = ?`,
    product,
  );
  const portalSettings = await getPortalProductSettings(db, product);
  const syncState = await getProductSyncState(db, product);
  const sync = syncStateView(syncState);
  const secretRows = await db.all<{ name: string; usage: string | null }>(
    "SELECT name, usage FROM product_secrets WHERE product = ?",
    product,
  );
  const configuredSecrets = new Set(secretRows.map((row) => row.name));
  const edgeMintSecrets = new Set(
    secretRows
      .filter((row) => row.usage === "edge-mint")
      .map((row) => row.name),
  );

  const secretSources = collectRequiredSecrets(oidc, edgeMint);

  const secrets: RequiredSecretStatus[] = [...secretSources.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, sources]) => ({
      name,
      configured: configuredSecrets.has(name),
      sources: [...sources],
    }));
  const missingSecrets = secrets
    .filter((secret) => !secret.configured)
    .map((secret) => secret.name);

  // The platform client only (I-03): `ADMIN_OIDC_*` is the console's own client and never
  // serves a `provider: platform` product.
  // Per field, so the readiness row names exactly the variable that is missing.
  const platformOidcIssuer =
    typeof env.PLATFORM_OIDC_ISSUER === "string" && env.PLATFORM_OIDC_ISSUER;
  const platformOidcClientId =
    typeof env.PLATFORM_OIDC_CLIENT_ID === "string" &&
    env.PLATFORM_OIDC_CLIENT_ID;
  const oidcProvider = oidc?.provider === "custom" ? "custom" : "platform";
  const oidcMissing = oidc
    ? oidcProvider === "custom"
      ? [
          ...(oidc.issuer ? [] : ["issuer"]),
          ...(oidc.client_id ? [] : ["client id"]),
          ...(oidc.client_secret_secret &&
          !configuredSecrets.has(oidc.client_secret_secret)
            ? [oidc.client_secret_secret]
            : []),
        ]
      : [
          ...(platformOidcIssuer ? [] : ["PLATFORM_OIDC_ISSUER"]),
          ...(platformOidcClientId ? [] : ["PLATFORM_OIDC_CLIENT_ID"]),
        ]
    : [];
  const edgeMissing = edgeMint
    .filter(
      (row) =>
        row.signing_key_secret &&
        !configuredSecrets.has(row.signing_key_secret),
    )
    .map((row) => row.signing_key_secret as string);
  // P0-12: the two operator-held conditions a recipe needs beyond its manifest row. A secret
  // that is configured but not marked `edge-mint` signs nothing (500 misconfigured); a recipe
  // that is pending or changed answers 404 until someone approves it.
  const edgeWrongUsage = [
    ...new Set(
      edgeMint
        .filter(
          (row) =>
            row.signing_key_secret &&
            configuredSecrets.has(row.signing_key_secret) &&
            !edgeMintSecrets.has(row.signing_key_secret),
        )
        .map((row) => row.signing_key_secret as string),
    ),
  ];
  const edgeUnapproved = edgeMint
    .filter((row) => row.approval !== "approved")
    .map((row) => row.id);
  const edgeProblems = [
    ...edgeMissing,
    ...edgeWrongUsage.map((name) => `${name} is not marked edge-mint`),
    ...edgeUnapproved.map((id) => `recipe ${id} awaits approval`),
  ];
  const releaseMissing = release
    ? [
        ...(release.gh_owner && release.gh_repo ? [] : ["GitHub repo"]),
        ...(release.gh_installation_id ? [] : ["GitHub installation"]),
        ...(release.binary_name ? [] : ["binary name"]),
      ]
    : [];
  // The Sparkle warning is only meaningful when Update renders appcasts for DMGs: the product
  // has Update enabled AND ships DMGs — the same evidence-based predicate release health uses.
  // The setup state has no GitHub listing, so "the latest release carries a .dmg" is read from
  // the truth store, and only for a product that declares no map (a map is its own evidence).
  const app =
    release && updateEnabled ? await readAppDeliverable(db, product) : null;
  const latestHasDmg =
    release && updateEnabled && !hasArtifactMap(app)
      ? await latestReleaseHasDmg(db, product)
      : false;
  const warnings =
    release &&
    updateEnabled &&
    shipsDmgs({
      policyJson: release.artifact_policy_json,
      app,
      latestReleaseHasDmg: latestHasDmg,
    }) &&
    !release.sparkle_ed25519_pub
      ? ["release: Sparkle public key not configured; appcasts may be unsigned"]
      : [];
  const syncMissing =
    syncState && syncState.status === "error"
      ? [`manifest sync: ${syncState.message ?? "failed"}`]
      : [];

  const modules = [
    {
      id: "signing",
      label: "Signing key",
      status: signingConfigured ? "configured" : "missing",
      configured: signingConfigured,
      missing: signingConfigured ? [] : ["product signing key"],
    },
    {
      id: "oidc",
      label: oidc
        ? oidcProvider === "custom"
          ? "Custom OIDC"
          : "Platform OIDC"
        : "OIDC",
      status: oidc
        ? oidcMissing.length
          ? oidcProvider === "custom"
            ? "needs-secret"
            : "needs-setup"
          : "configured"
        : "not-configured",
      configured: oidc ? oidcMissing.length === 0 : null,
      provider: oidc ? oidcProvider : null,
      missing: oidcMissing,
    },
    {
      id: "release",
      label: "Release",
      status: release
        ? releaseMissing.length
          ? "needs-setup"
          : "configured"
        : "not-configured",
      configured: release ? releaseMissing.length === 0 : null,
      missing: release ? releaseMissing : [],
    },
    {
      id: "portal",
      label: "Customer portal",
      status: portalSettings.portal_enabled === 1 ? "enabled" : "disabled",
      configured: true,
      enabled: portalSettings.portal_enabled === 1,
      missing: [],
    },
    {
      id: "manifestSync",
      label: "Manifest sync",
      status: syncState ? syncState.status : "not-run",
      configured: syncState ? syncState.status === "ok" : null,
      missing: syncMissing,
    },
    {
      id: "edgeMint",
      label: "Edge mint",
      status: edgeMint.length
        ? edgeMissing.length || edgeWrongUsage.length
          ? "needs-secret"
          : edgeUnapproved.length
            ? "needs-approval"
            : "configured"
        : "not-configured",
      configured: edgeMint.length ? edgeProblems.length === 0 : null,
      missing: edgeProblems,
      pendingApproval: edgeUnapproved,
    },
  ];

  const missing = [
    ...(signingConfigured ? [] : ["product signing key"]),
    ...missingSecrets,
    ...releaseMissing.map((item) => `release: ${item}`),
    ...syncMissing,
    ...edgeWrongUsage.map(
      (name) => `edge mint: ${name} is not marked edge-mint`,
    ),
    ...edgeUnapproved.map((id) => `edge mint: recipe ${id} awaits approval`),
  ];
  const nextActions = [
    ...missingSecrets.map((name) => ({
      id: `secret:${name}`,
      label: `Set required secret ${name}`,
      route: `#/p/${product}/keys`,
    })),
    ...(signingConfigured
      ? []
      : [
          {
            id: "signing-key",
            label: "Rotate or recreate the product signing key",
            route: `#/p/${product}/keys`,
          },
        ]),
    ...edgeWrongUsage.map((name) => ({
      id: `secret-usage:${name}`,
      label: `Mark secret ${name} for edge-minting`,
      route: `#/p/${product}/keys`,
    })),
    ...edgeUnapproved.map((id) => ({
      id: `edge-mint:${id}`,
      label: `Review and approve edge-mint recipe ${id}`,
      route: `#/p/${product}/config/edge-mint`,
    })),
    ...(release && releaseMissing.length > 0
      ? [
          {
            id: "release",
            label: "Review release setup",
            route: `#/p/${product}/release/releases`,
          },
        ]
      : []),
  ];

  return {
    status: missing.length ? "needs-attention" : "healthy",
    healthy: missing.length === 0,
    complete: missing.length === 0,
    missing,
    warnings,
    requiredSecrets: secrets.map((secret) => secret.name),
    missingSecrets,
    secrets,
    modules,
    sync,
    nextActions,
  };
}
