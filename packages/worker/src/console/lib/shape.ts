/**
 * Output shaping for the console: the product-registry view and the secrets inventory. The licence
 * summary and the active-catalog loader are Core's (`core/licensing/summary.ts`,
 * `core/activeCatalog.ts`), because services' admin handlers use them too.
 */

import { listAudit } from "../../core/audit.js";
import { claimsView } from "../../core/settingsClaims.js";
import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { type ProductRow, type ProductSyncStateRow } from "../../core/repo.js";
import { getProductSyncState } from "../../core/products/store.js";
import { loadPublicSigningKey } from "../../core/products.js";
import { serviceStateOf } from "../../core/services.js";
import {
  getPortalProductSettings,
  portalProductSettingsView,
} from "../../services/identity/public.js";
import { packageFeedsOf } from "../../services/distribution/public.js";
import {
  approvalMismatch,
  listEdgeMintRecipesWithApprovals,
  mintApprovalBasis,
} from "../../services/config/public.js";
import { parseAutoIssue } from "../../core/fingerprint.js";
import {
  productIcons,
  type ProductIconView,
  type ProductPresentationView,
} from "./presentation.js";
import { parseJsonStringList } from "../../platform/json.js";
import { parseWebOrigins } from "../../core/cors.js";

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
    changedPaths: parseJsonStringList(row.changed_paths_json),
    updated: parseJsonStringList(row.updated_json),
    errors: parseJsonStringList(row.errors_json),
    message: row.message,
  };
}

/** The package deliverables the product declares (`.pkey/release`), of any ecosystem. */
async function declaredPackages(db: Db, slug: string): Promise<number> {
  const row = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM release_deliverables WHERE product = ? AND kind = 'package'",
    slug,
  );
  return row?.n ?? 0;
}

/** The registry projection of a product row. */
export async function productView(
  env: Env,
  db: Db,
  p: ProductRow,
  now: number = Math.floor(Date.now() / 1000),
  /** Every product's icon, read once by the list (`productIcons(env, db)`); one product's
   *  own read otherwise. */
  icons?: Map<string, ProductIconView>,
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
  const feeds = await packageFeedsOf(db, p.slug);
  const portalSettings = await getPortalProductSettings(db, p.slug);
  const icon =
    (icons ?? (await productIcons(env, db, p.slug))).get(p.slug) ?? null;
  const presentation: ProductPresentationView = { icon };
  return {
    slug: p.slug,
    name: p.name,
    // The console's logo (Home, Products): the hosted icon as image-host URLs, or null.
    presentation,
    // F-03: the platform's own product (the package-feeds owner of our SDKs). The console keeps it
    // out of the product switcher and the Products registry; it is reached from Platform.
    system: p.system === 1,
    // F-11: the operator-owned `packageFeeds` sub-capability (`dist_registry_owners`). The shell
    // shows Distribution → Package feeds only while it is on, so it rides the row the shell loads.
    packageFeeds: feeds.enabled,
    // F-34.3 (decision F13): what the Packages nav and card need in one read. `declared` counts the
    // package deliverables in `.pkey/release`; `offBy` and `offAt` say who turned the feeds off
    // and when (`manifest` is a row the ingest provisioned), null while they are on or never set.
    packages: {
      declared: await declaredPackages(db, p.slug),
      feedsOn: feeds.enabled,
      offBy: !feeds.enabled
        ? await offByName(db, p.slug, feeds.updatedBy)
        : null,
      offAt: !feeds.enabled ? feeds.updatedAt : null,
    },
    releaseSource: p.release_source ?? "manual",
    signingKid,
    jwksUrl,
    signing,
    portalSettings: portalProductSettingsView(portalSettings),
    services: services.services,
    effectiveRegistration: services.effectiveRegistration,
    servicesSource: services.source,
    // The last manifest resync (`null` before the first): Settings, Overview and Releases.
    sync: syncStateView(await getProductSyncState(db, p.slug)),
    compatMin: p.compat_min,
    compatMax: p.compat_max,
    defaultMaxOfflineDays: p.default_max_offline_days,
    defaultDeviceLimit: p.default_device_limit,
    adminGroup: p.admin_group,
    // ST-08: the browser origins the product answers CORS for (`core.web.origins`, claimable).
    webOrigins: parseWebOrigins(p.web_origins_json),
    // ST-01b: the column-backed settings the console has claimed from the manifest (the resync
    // leaves these alone until a Revert). Empty for a product with no manifest to claim from.
    // ST-20: each break-glass claim carries its reason and expiry, and `manifestAuthoritative`
    // is the mode (the console's switch; locked on for the system product).
    ...(await claimsView(db, p, now)),
    createdAt: p.created_at,
    modifiedAt: p.modified_at,
  };
}

/**
 * The slim row `GET /products` answers (ST-44): what the shell, the switcher and Home's cards
 * draw, and nothing that costs a query per product beyond enablement. The last resync, the signing
 * block, the claims and the portal settings ride `GET /products/:slug` (`productView`); what
 * needs the operator is the attention read's (`GET /attention`, `./attention.ts`).
 */
export async function productListView(
  db: Db,
  p: ProductRow,
  icons: Map<string, ProductIconView>,
  headers: Map<string, ProductIconView>,
  verified: ReadonlySet<string>,
): Promise<Record<string, unknown>> {
  const services = serviceStateOf(p);
  const presentation: ProductPresentationView = {
    icon: icons.get(p.slug) ?? null,
    header: headers.get(p.slug) ?? null,
  };
  return {
    slug: p.slug,
    name: p.name,
    presentation,
    system: p.system === 1,
    packageFeeds: (await packageFeedsOf(db, p.slug)).enabled,
    releaseSource: p.release_source ?? "manual",
    services: services.services,
    effectiveRegistration: services.effectiveRegistration,
    servicesSource: services.source,
    // Integration verified (Home's facet): an SDK has been seen calling a service
    // (`verifiedProducts`); the Integration page has the per-feature answer.
    verified: verified.has(p.slug),
    // Plain columns, no query: the one-product read's placeholder (`useProduct`) shows them until
    // the full row arrives.
    signingKid: p.signing_kid,
    jwksUrl: `/${p.slug}/.well-known/jwks.json`,
    compatMin: p.compat_min,
    compatMax: p.compat_max,
    defaultMaxOfflineDays: p.default_max_offline_days,
    defaultDeviceLimit: p.default_device_limit,
    adminGroup: p.admin_group,
    webOrigins: parseWebOrigins(p.web_origins_json),
    createdAt: p.created_at,
    modifiedAt: p.modified_at,
  };
}

/** The products an SDK has been seen calling a service of, in one statement. */
export async function verifiedProducts(db: Db): Promise<Set<string>> {
  const rows = await db.all<{ product: string }>(
    "SELECT DISTINCT product FROM sdk_sightings WHERE services_ok != 0",
  );
  return new Set(rows.map((r) => r.product));
}

/**
 * Which product secrets the product's configuration names, and what names each (a custom OIDC
 * provider's client secret, each edge-mint recipe's signing key). Shared by the attention facts
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
    requireSecret(oidc?.client_secret_secret, "OIDC sign-in");
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
  /** What in the product's configuration names it ("OIDC sign-in", "Edge mint studio"). */
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

/**
 * The facts the attention read (`./attention.ts`) turns into items: whether the product has a
 * usable signing key, which required secrets are unset, which edge-mint secrets are not marked
 * for edge minting, and which recipes await approval. This replaces the six-module setup model
 * (ST-47): nothing else reads it, and no console payload carries it.
 */
export interface AttentionFacts {
  signingConfigured: boolean;
  secrets: RequiredSecretStatus[];
  wrongUsage: string[];
  unapprovedRecipes: string[];
}

export async function attentionFactsFor(
  db: Db,
  p: ProductRow,
): Promise<AttentionFacts> {
  const activeKey = await loadPublicSigningKey(db, p.slug);
  const services = serviceStateOf(p);
  const product = p.slug;
  const oidc = await db.first<OidcSetupRow>(
    "SELECT provider, issuer, client_id, client_secret_secret FROM oidc_config WHERE product = ?",
    product,
  );
  const mintBasis = await mintApprovalBasis(db, {
    slug: p.slug,
    registration: services.effectiveRegistration,
    autoIssue: parseAutoIssue(p.auto_issue_json),
    services: services.services,
  });
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
  const secrets: RequiredSecretStatus[] = [
    ...collectRequiredSecrets(oidc, edgeMint).entries(),
  ]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, sources]) => ({
      name,
      configured: configuredSecrets.has(name),
      sources: [...sources],
    }));
  // P0-12: a secret that is configured but not marked `edge-mint` signs nothing (500
  // misconfigured); a recipe that is pending or changed answers 404 until someone approves it.
  const wrongUsage = [
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
  return {
    signingConfigured: Boolean(activeKey?.publicKey ?? p.signing_pub),
    secrets,
    wrongUsage,
    unapprovedRecipes: edgeMint
      .filter((row) => row.approval !== "approved")
      .map((row) => row.id),
  };
}

/**
 * Who turned a product's package feeds off, as a display name: the actor of the latest
 * `package_feeds.update` audit row, resolved as the activity feed does. Never the raw IdP `sub`
 * the owner row records; `manifest` stays as is, and a write with no named actor reads as
 * "an operator".
 */
async function offByName(
  db: Db,
  slug: string,
  updatedBy: string | null,
): Promise<string | null> {
  if (updatedBy === null) return null;
  if (updatedBy === "manifest" || updatedBy === "system") return updatedBy;
  const [row] = await listAudit(db, slug, {
    action: "distribution.package_feeds.update",
    targetKind: "package-feeds",
    targetId: slug,
    limit: 1,
  });
  return row?.actor_name || row?.actor_email || "an operator";
}
