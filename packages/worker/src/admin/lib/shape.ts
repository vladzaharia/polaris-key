/**
 * Output shaping for the admin surface: license summaries, the product-registry view, and
 * the active-catalog loader used for value validation + redaction.
 */

import { Catalog } from "@plrs/catalog";
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
import { countKeysByLicense } from "../repo.js";

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
}

interface ReleaseSetupRow {
  gh_owner: string | null;
  gh_repo: string | null;
  gh_installation_id: number | null;
  binary_name: string | null;
  sparkle_ed25519_pub: string | null;
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
    identityProvider: row.sub ? "oidc" : "manual",
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
  const setup = await productSetupView(
    env,
    db,
    p.slug,
    Boolean(signingPublicKey),
  );
  const portalSettings = await getPortalProductSettings(db, p.slug);
  // D-15: the console's nav is a projection of enablement, and the SHELL needs the answer before
  // it can draw the sidebar that frames the view. Carrying it on the product row the shell
  // already loads is what keeps the nav from popping in after its own content; a second
  // round-trip to `…/services` would be a strictly slower way to render the same tree.
  const services = serviceStateOf(p);
  return {
    slug: p.slug,
    name: p.name,
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
      configUrl: `/${p.slug}/config`,
      activateUrl: `/${p.slug}/activate`,
      jwksUrl,
      nextActions: setup.nextActions,
    },
    compatMin: p.compat_min,
    compatMax: p.compat_max,
    defaultMaxOfflineDays: p.default_max_offline_days,
    defaultDeviceLimit: p.default_device_limit,
    adminGroup: p.admin_group,
    createdAt: p.created_at,
    modifiedAt: p.modified_at,
  };
}

async function productSetupView(
  env: Env,
  db: Db,
  product: string,
  signingConfigured: boolean,
): Promise<Record<string, unknown>> {
  const oidc = await db.first<OidcSetupRow>(
    "SELECT provider, issuer, client_id, client_secret_secret FROM oidc_config WHERE product = ?",
    product,
  );
  const edgeMint = await db.all<EdgeMintSetupRow>(
    "SELECT id, signing_key_secret FROM edge_mint_config WHERE product = ? ORDER BY id",
    product,
  );
  const release = await db.first<ReleaseSetupRow>(
    `SELECT gh_owner, gh_repo, gh_installation_id, binary_name, sparkle_ed25519_pub
      FROM release_config WHERE product = ?`,
    product,
  );
  const portalSettings = await getPortalProductSettings(db, product);
  const syncState = await getProductSyncState(db, product);
  const sync = syncStateView(syncState);
  const configuredSecrets = new Set(
    (
      await db.all<{ name: string }>(
        "SELECT name FROM product_secrets WHERE product = ?",
        product,
      )
    ).map((row) => row.name),
  );

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

  const platformOidcIssuer =
    typeof env.PLATFORM_OIDC_ISSUER === "string"
      ? env.PLATFORM_OIDC_ISSUER
      : typeof env.ADMIN_OIDC_ISSUER === "string"
        ? env.ADMIN_OIDC_ISSUER
        : undefined;
  const platformOidcClientId =
    typeof env.PLATFORM_OIDC_CLIENT_ID === "string"
      ? env.PLATFORM_OIDC_CLIENT_ID
      : typeof env.ADMIN_OIDC_CLIENT_ID === "string"
        ? env.ADMIN_OIDC_CLIENT_ID
        : undefined;
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
  const releaseMissing = release
    ? [
        ...(release.gh_owner && release.gh_repo ? [] : ["GitHub repo"]),
        ...(release.gh_installation_id ? [] : ["GitHub installation"]),
        ...(release.binary_name ? [] : ["binary name"]),
      ]
    : [];
  const warnings =
    release && !release.sparkle_ed25519_pub
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
        ? edgeMissing.length
          ? "needs-secret"
          : "configured"
        : "not-configured",
      configured: edgeMint.length ? edgeMissing.length === 0 : null,
      missing: edgeMissing,
    },
  ];

  const missing = [
    ...(signingConfigured ? [] : ["product signing key"]),
    ...missingSecrets,
    ...releaseMissing.map((item) => `release: ${item}`),
    ...syncMissing,
  ];
  const nextActions = [
    ...missingSecrets.map((name) => ({
      id: `secret:${name}`,
      label: `Set required secret ${name}`,
      route: `#/p/${product}/settings`,
    })),
    ...(signingConfigured
      ? []
      : [
          {
            id: "signing-key",
            label: "Rotate or recreate the product signing key",
            route: `#/p/${product}/settings`,
          },
        ]),
    ...(release && releaseMissing.length > 0
      ? [
          {
            id: "release",
            label: "Review release setup",
            route: `#/p/${product}/releases`,
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
