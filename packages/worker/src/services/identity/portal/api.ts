import { publicBranding } from "./branding.js";
import {
  noticeOrigin,
  syncLicenseLinksAndNotify,
} from "../accounts/libraryNotice.js";
import {
  activePlatformConnections,
  audienceCovers,
} from "../../../core/oidc/connections.js";
import {
  PLATFORM_ENV_CONNECTION_ID,
  platformEnvConnection,
} from "../connections/seed.js";
import {
  RELEASE_PLATFORMS,
  SYSTEM_PRODUCT_SLUG,
  APP_DELIVERABLE_ID,
  platformFromFileName,
} from "@polaris-key/manifest";
import { licenseAccess } from "../../../core/licensing/anchor.js";
import { customerTierId } from "../../../core/licensing/implicitTier.js";
import { constantTimeEqual } from "../../../platform/compare.js";
import type { SettingsRegistry } from "../../../core/settings/registry.js";
import { CHANNEL_STABLE } from "@polaris-key/protocol";
import type { ReleaseAccess } from "@polaris-key/protocol/release";
import { isAllowedDownloadRedirectHost } from "../../../core/hosts.js";
import { isAllowedStorageHost } from "../../../platform/http.js";
import { parseJsonOr } from "../../../platform/json.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type {
  CatalogLocation,
  CatalogSourceArtifact,
  Delivery,
  ReleaseCatalog,
  ServiceHooks,
} from "../../../core/hooks.js";
import {
  loadProductPublic,
  type ProductPublic,
} from "../../../core/products.js";
import { licenseEntitled } from "../../../core/licensing/entitledAccess.js";
import { isBytesHost } from "../../../core/hosts.js";
import { isBrowserNavigation } from "../../../core/http/navigation.js";
import { hasRef, parseKey } from "../../../core/assets/blobs.js";
import {
  DOWNLOAD_TICKET_PARAM,
  downloadTicketsEnabled,
  mintDownloadTicket,
} from "../../../core/downloadTicket.js";
import { ErrorCode } from "../../../core/errors.js";
import { getProduct } from "../../../core/products/store.js";
import { licenseUsable } from "../../../core/devices.js";
import { rateLimitOk } from "../../../core/rateLimit.js";
import {
  mintDownloadToken,
  readDownloadToken,
  spendDownloadToken,
} from "../../../core/assets/downloadTokens.js";
import { registryOrigin } from "../../../core/hosts.js";
import {
  MAX_LIVE_TOKENS_PER_LICENSE,
  REGISTRY_TOKEN_DEFAULT_DAYS,
  REGISTRY_TOKEN_MAX_DAYS,
  REGISTRY_TOKEN_MIN_DAYS,
  REGISTRY_TOKEN_USERNAME,
  REGISTRY_URL_TOKEN_DEFAULT_DAYS,
  listRegistryTokens,
  mintRegistryToken,
  revokeRegistryToken,
} from "../../../core/registry/registryTokens.js";
import { PACKAGE_ECOSYSTEMS, PRODUCT_SLUG_RE } from "@polaris-key/manifest";
import {
  getPortalAccount,
  getPortalLicense,
  getPortalProductSettings,
  listLinkedProducts,
  listPortalLicenses,
  listVisibleDevices,
  listVisibleKeys,
  portalAuthCapabilities,
  portalAudit,
  releaseServiceEnabled,
  type PortalLicenseRow,
} from "./repo.js";
import {
  PORTAL_CSRF_HEADER,
  buildPortalClearCookie,
  portalSessionAuthenticatedAt,
  portalSessionFromRequest,
  type PortalSession,
} from "./session.js";
import {
  accountDeletionSchedule,
  cancelAccountDeletion,
  scheduleAccountDeletion,
} from "../accounts/lifecycle.js";
import { handleMagicStart } from "./auth.js";
import { handlePersonalTokens } from "./personalTokens.js";
import { portalStepUpGate } from "./stepUpGate.js";
import { licenseGrants } from "./entitlements.js";
import {
  checkAccountSession,
  listAccountSessions,
  revokeAccountSession,
  revokeAllAccountSessions,
} from "./accountSessions.js";
import { avatarUrl, handleCardApi, turnstileSiteKey } from "../card/index.js";
import { handleAccountPasskeys } from "../passkeys/routes.js";
import {
  LINK_FLOW_COOKIE,
  clearAccountRealmCookie,
} from "../../../core/accounts/accountCookies.js";
import { handleAccountMethods } from "./methods.js";
import { handleAccountLink } from "./link.js";
import { clearDeviceSubjects } from "../../../core/accounts/subjectHooks.js";
import { erasureVerdict } from "../../../core/accounts/erasureFence.js";
import {
  handleLibraryEntryRemove,
  libraryView,
  productView,
} from "./library.js";
import {
  signInConsentView,
  signInLicensesView,
  signInReplaceView,
  signInRequestView,
} from "../passthrough/routes.js";
import {
  handleSignInCancel,
  handleSignInContinue,
} from "../passthrough/continue.js";
import {
  handleActivatePreview,
  handleClaimKey,
  handleKeyPreview,
  handleDeviceRename,
  handleKeyReissue,
  handleLicenseRemove,
} from "./selfService.js";
import {
  licenseStores,
  notRemovableReason,
  portalLicenseOrigin,
  storeKey,
} from "./origin.js";
import { sendNotice, sendSecurityNotice } from "../../../core/notify/send.js";
import { emailConfigured } from "../../../core/notify/destinations.js";
import {
  accountDeletionCancelledNotice,
  accountDeletionScheduledNotice,
  downloadLinkEmail,
} from "../../../core/notify/templates.js";
import { platformSignInEnded } from "../accounts/platformMigration.js";
import { appSecurityHeaders as portalSecurityHeaders } from "../../../core/securityHeaders.js";
import { handleProductDownloads } from "./downloads.js";
import {
  discoverCount,
  handleDiscover,
  handleDiscoverClaim,
  handleStorefrontPage,
} from "./discover.js";
import {
  DEVICE_LOGIN_APPROVE_LIMIT,
  handleDeviceLoginApprove,
  handleDeviceLoginLookup,
  handleDeviceLoginPoll,
  handleDeviceLoginStart,
} from "./deviceLogin.js";
import { freeAccountDevice, portalActionLimit } from "./freeDevice.js";
import {
  handleAccountExport,
  handleProductDataRemove,
  handleProductExport,
} from "./dataRoutes.js";
import { handleProductSupportCode } from "./supportCode.js";
import { handleProfileApi } from "./profile.js";
import { accountMayOpenConsole } from "../consoleAccount.js";
import { consoleOrigin } from "../../../core/hosts.js";
import { AdminBodyError, readBody } from "../../../core/http/body.js";
import { bestRow } from "../../../core/http/routes.js";
import { handleStorefrontName } from "./storefrontName.js";

export function portalJson(
  body: unknown,
  status = 200,
  extra?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: portalSecurityHeaders(
      new Headers({
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        ...(extra ?? {}),
      }),
    ),
  });
}

export function err(status: number, code: string, message?: string): Response {
  return portalJson({ error: code, ...(message ? { message } : {}) }, status);
}

function unauthorized(): Response {
  return err(401, ErrorCode.Unauthorized);
}

function forbidden(message?: string): Response {
  return err(403, ErrorCode.Forbidden, message);
}

export function notFound(): Response {
  return err(404, ErrorCode.NotFound);
}

function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

export { readBody };

function licenseBase(
  row: PortalLicenseRow,
  tier: string | null,
): Record<string, unknown> {
  return {
    id: row.id,
    product: row.product,
    productName: row.product_name,
    productBranding: publicBranding(row.product_branding_json),
    name: row.name ?? "",
    email: row.email ?? "",
    status: row.status,
    tier,
    activatedAt: row.activated_at,
    expiresAt: row.expires_at,
    maxOfflineDays: row.max_offline_days,
    identityProvider: row.sub ? "oidc" : "manual",
  };
}

/**
 * One licence as the portal lists it. `origin` and `originStore` say how it reached the person
 * (PX-23, `origin.ts`); `store` is the store of an active purchase on it, which the caller reads
 * through License's provenance hook ({@link licenseStores}), `null` when there is none or no hook.
 */
export async function shapeLicenseSummary(
  db: Db,
  row: PortalLicenseRow,
  now: number,
  store: string | null = null,
): Promise<Record<string, unknown>> {
  const keys = await listVisibleKeys(db, row.product, row.id);
  const devices = await listVisibleDevices(db, row.product, row.id);
  // `channels`, `minVersion`, `maxVersion` and `entitlements` come from the licence document's
  // own resolution, not the licence row's columns (LX-04, S-19 G14; see `entitlements.ts`).
  const grants = await licenseGrants(db, row, now);
  const activeKeyCount = keys.filter((k) => k.status === "active").length;
  const settings = await getPortalProductSettings(db, row.product);
  return {
    ...licenseBase(row, await customerTierId(db, row)),
    ...portalLicenseOrigin({
      origin: row.origin ?? null,
      sub: row.sub,
      email: row.email,
      keyCount: keys.length,
      store,
    }),
    channels: grants.channels,
    minVersion: grants.minVersion,
    maxVersion: grants.maxVersion,
    usable: licenseUsable(row, now),
    keyCount: keys.length,
    activeKeyCount,
    deviceCount: devices.filter((d) => d.status === "authorized").length,
    entitlements: grants.entitlements,
    // I-09 (plans/I-04.md §F.6): `account` for a sign-in licence, else `seats`. The fact behind
    // the origin "From signing in" and the mixed rule; never a displayed type.
    access: await licenseAccess(db, row),
    // PX-23: Remove from my library is offered only for a licence its key can bring back.
    removable:
      notRemovableReason(activeKeyCount, settings.portal_enabled === 1) ===
      null,
  };
}

/** {@link shapeLicenseSummary} with the licence's store read through the provenance hook. */
export async function shapeLicenseSummaryWithStore(
  db: Db,
  row: PortalLicenseRow,
  now: number,
  hooksFor: PortalHooksFor | undefined,
): Promise<Record<string, unknown>> {
  const stores = await licenseStores(db, [row], hooksFor, now);
  return shapeLicenseSummary(
    db,
    row,
    now,
    stores.get(storeKey(row.product, row.id)) ?? null,
  );
}

async function shapeLicenseDetail(
  db: Db,
  row: PortalLicenseRow,
  now: number,
  hooksFor: PortalHooksFor | undefined,
): Promise<Record<string, unknown>> {
  const keys = await listVisibleKeys(db, row.product, row.id);
  const devices = await listVisibleDevices(db, row.product, row.id);
  return {
    ...(await shapeLicenseSummaryWithStore(db, row, now, hooksFor)),
    keys: keys.map((key) => ({
      hash: key.key_hash,
      status: key.status,
      label: key.label,
      createdAt: key.created_at,
      lastUsedAt: key.last_used_at,
    })),
    devices: devices.map((device) => ({
      deviceId: device.device_id,
      status: device.status,
      firstSeen: device.first_seen,
      lastSeen: device.last_seen,
      label: device.label,
      platform: device.platform,
      arch: device.arch,
      appVersion: device.app_version,
      sdkName: device.sdk_name,
      sdkVersion: device.sdk_version,
      ua: device.ua,
    })),
  };
}

async function requireSession(
  req: Request,
  env: Env,
  db: Db,
  now: number,
): Promise<{ session: PortalSession; sessionIdHash: string } | Response> {
  const session = await portalSessionFromRequest(env, req, now);
  if (!session) return unauthorized();
  // I-07: the cookie must name a live `account_sessions` row of the account it resolves to. I-05:
  // the id resolves through a merge tombstone (30 days), so a cookie of an absorbed account acts
  // as the survivor (the merge moved its session rows), and every handler below reads the
  // resolved id. I-11: and that account must not be on the erasure ledger, which a D1 restore
  // does not rewind; with the ledger unreadable the answer is 503, not 401, so the browser keeps
  // its cookie and tries again.
  const live = await checkAccountSession(env, db, session, now);
  if (live.status === "unavailable")
    return err(503, "erasure_ledger_unavailable", "try again");
  if (live.status !== "live") return unauthorized();
  return {
    session: { ...session, accountId: live.accountId },
    sessionIdHash: live.idHash,
  };
}

export async function hasLinkedProductLicense(
  db: Db,
  accountId: string,
  product: string,
): Promise<boolean> {
  const rows = await listPortalLicenses(db, accountId);
  return rows.some((row) => row.product === product);
}

// ── Delivery access (P2b-04) ────────────────────────────────────────────────────────────────
//
// Who may download a release is Distribution's delivery access (`dist_access`, per deliverable),
// read through the `delivery` hook — the SAME answer the byte routes and the appcast read, so the
// portal can no longer offer what the download refuses or refuse what it serves. Before P2b-04
// the portal read a per-artifact snapshot of Release's old per-product artifacts mode taken at sync
// time (`release_artifacts.access`), which could not even hold `entitled`.
//
// The portal authenticates a PERSON with linked licences, not a device, so each mode is asked of
// those licences: `public` and `authenticated` need the linked licence every download already
// requires; `licensed` needs one that is usable; `entitled` needs one whose own grant holds the
// release's channel and whose window holds its version (Core's `licenseEntitled`, the device
// decision minus the device layer).

/** Builds one product's descriptor hooks (the composition root does: `dispatch.ts`). */
export type PortalHooksFor = (
  product: ProductPublic,
  now: number,
) => ServiceHooks;

export interface DeliveryGate {
  /** The database the gate was built on (the bytes-host copy check reads the product's refs). */
  db?: Db;
  product: ProductPublic;
  delivery: Delivery;
  /** Release's catalog hook (`null` when Release is off): the files and release facts. */
  catalog: ReleaseCatalog | null;
  /**
   * Is the product's GitHub repository public (Release's `repositoryPublic`, read at most once
   * per gate)? `false` when Release is off or the answer could not be read. Only a public
   * repository's stored download URLs may be handed to a browser.
   */
  repositoryPublic: () => Promise<boolean>;
}

/**
 * The product's delivery hook, or `null` when downloads are not served: no hooks were provided,
 * the product is gone, or Distribution is off for it (byte delivery is Distribution's, and a
 * product with it off serves no downloads anywhere).
 */
export async function deliveryGate(
  db: Db,
  hooksFor: PortalHooksFor | undefined,
  product: string,
  now: number,
): Promise<DeliveryGate | null> {
  const loaded = await portalHooks(db, hooksFor, product, now);
  if (!loaded) return null;
  const delivery = loaded.hooks.delivery();
  if (!delivery) return null;
  const catalog = loaded.hooks.releaseCatalog();
  let visibility: Promise<boolean> | undefined;
  const repositoryPublic = (): Promise<boolean> =>
    (visibility ??= catalog
      ? catalog.repositoryPublic()
      : Promise.resolve(false));
  return { db, product: loaded.product, delivery, catalog, repositoryPublic };
}

/** One product's hooks, or `null` when no hooks were provided or the product is gone. */
export async function portalHooks(
  db: Db,
  hooksFor: PortalHooksFor | undefined,
  product: string,
  now: number,
): Promise<{ product: ProductPublic; hooks: ServiceHooks } | null> {
  if (!hooksFor) return null;
  const loaded = await loadProductPublic(db, product);
  if (!loaded) return null;
  return { product: loaded, hooks: hooksFor(loaded, now) };
}

/** The facts the delivery-access decision needs about one release. */
export interface ReleaseFacts {
  deliverable_id: string;
  version: string;
  /** The channel it was published to; `null` = derived from GitHub (read as stable). */
  channel: string | null;
}

/** One file the portal may hand out, from Release's catalog (never its tables). */
export interface ServedFile {
  releaseId: string;
  artifactId: string;
  name: string;
  sha256: string | null;
  /** GitHub's own download URL for it, when a sync stored one. */
  sourceUrl: string | null;
  /** Where its bytes live (Release's catalog); absent = unknown, so no location check is made. */
  locations?: CatalogLocation[];
}

export function servedFile(a: CatalogSourceArtifact): ServedFile {
  return {
    releaseId: a.releaseId,
    artifactId: a.artifactId,
    name: a.name,
    sha256: a.sha256,
    sourceUrl: a.sourceUrl,
    locations: a.locations,
  };
}

/** One file of a release and the release's facts, or `null` when either is gone (or Release is off). */
export async function servedFileOf(
  gate: DeliveryGate,
  releaseId: string,
  artifactId: string,
): Promise<{ file: ServedFile; facts: ReleaseFacts } | null> {
  if (!gate.catalog) return null;
  const release = await gate.catalog.release(releaseId);
  if (!release) return null;
  const artifact = (await gate.catalog.artifacts(releaseId)).find(
    (a) => a.artifactId === artifactId,
  );
  if (!artifact) return null;
  return {
    file: servedFile(artifact),
    facts: {
      deliverable_id: release.deliverableId,
      version: release.version,
      channel: release.channel,
    },
  };
}

/** Ascending, NULL first (SQLite's order, which the listing used to get from `ORDER BY`). */
function nullsFirst(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

/** One app release as the listing shows it, read through Release's catalog hook. */
interface ListedRelease {
  product: string;
  productName: string;
  releaseId: string;
  deliverableId: string;
  channel: string | null;
  version: string;
  title: string | null;
  notes: string | null;
  sourceUrl: string | null;
  metadataAccess: string;
  publishedAt: number | null;
  artifacts: {
    artifactId: string;
    name: string;
    kind: string | null;
    platform: string | null;
    arch: string | null;
    sizeBytes: number | null;
    sha256: string | null;
    buildId: string | null;
    source: CatalogSourceArtifact;
  }[];
  /** Each build's platform, for the read-time label inference. */
  buildPlatforms: Map<string, string | null>;
}

/**
 * The releases the customer portal lists: the `app` deliverable's only, newest first across the
 * products. A pack release (P4-02) and its content objects are game content a client fetches
 * through its pin, never a download a customer picks from the portal. Read through each
 * product's `releaseCatalog` hook, which answers nothing while Release is off.
 */
async function listPortalReleases(
  db: Db,
  hooksFor: PortalHooksFor | undefined,
  products: string[],
  now: number,
): Promise<ListedRelease[]> {
  const out: ListedRelease[] = [];
  for (const slug of products) {
    const loaded = await portalHooks(db, hooksFor, slug, now);
    const catalog = loaded?.hooks.releaseCatalog();
    if (!loaded || !catalog) continue;
    for (const release of await catalog.releases(APP_DELIVERABLE_ID)) {
      const meta = await catalog.releaseNotes(release.releaseId);
      if (!meta) continue;
      const builds = await catalog.builds(release.releaseId);
      out.push({
        product: slug,
        productName: loaded.product.name,
        releaseId: release.releaseId,
        deliverableId: release.deliverableId,
        channel: release.channel,
        version: release.version,
        title: meta.title,
        notes: meta.notes,
        sourceUrl: meta.sourceUrl,
        metadataAccess: meta.metadataAccess,
        publishedAt: release.publishedAt,
        artifacts: (await catalog.artifacts(release.releaseId))
          // Verification material is not a download.
          .filter(
            (a) =>
              a.role !== "signature" &&
              a.role !== "checksum" &&
              a.kind !== "signature" &&
              a.kind !== "checksum",
          )
          .sort(
            (x, y) =>
              nullsFirst(x.kind, y.kind) ||
              nullsFirst(x.platform, y.platform) ||
              nullsFirst(x.arch, y.arch) ||
              nullsFirst(x.name, y.name),
          )
          .map((a) => ({
            artifactId: a.artifactId,
            name: a.name,
            kind: a.kind,
            platform: a.platform,
            arch: a.arch,
            sizeBytes: a.sizeBytes,
            sha256: a.sha256,
            buildId: a.buildId,
            source: a,
          })),
        buildPlatforms: new Map(builds.map((b) => [b.buildId, b.platform])),
      });
    }
  }
  return out.sort(
    (a, b) =>
      (b.publishedAt ?? 0) - (a.publishedAt ?? 0) ||
      (a.version < b.version ? 1 : a.version > b.version ? -1 : 0),
  );
}

/** May this account download a release under `mode`? (A linked licence is checked by callers.) */
export async function accountMayDownload(
  db: Db,
  accountId: string,
  gate: DeliveryGate,
  mode: ReleaseAccess,
  release: ReleaseFacts,
  now: number,
): Promise<boolean> {
  if (mode === "public" || mode === "authenticated") return true;
  const licenses = (await listPortalLicenses(db, accountId)).filter(
    (row) => row.product === gate.product.slug,
  );
  if (mode === "licensed")
    return licenses.some((row) => licenseUsable(row, now));
  // `entitled`: the release's own channel (stable when GitHub-derived) at its stored version.
  const selector = {
    channel: release.channel ?? CHANNEL_STABLE,
    version: release.version.replace(/^v/, ""),
  };
  for (const license of licenses) {
    if (await licenseEntitled(db, gate.product, license, selector, now))
      return true;
  }
  return false;
}

/**
 * Where a download goes (R6-12, PX-W3, HA-09). One of:
 *
 *   - `{kind: "ticket", base}`: a NON-public deliverable whose file Distribution serves on the
 *     bytes host, with a recorded SHA-256, on a deployment with download tickets configured
 *     (`DOWNLOAD_TICKET_KEY` and `BLOB_ORIGIN`). HA-09: this is tried FIRST for a non-public
 *     deliverable, so a licensed download prefers the mirrored copy (R2, or a private
 *     repository's asset the bytes host streams through the installation token) over any GitHub
 *     URL (plans/PX-W3.md Q7). `base` is the file's canonical bytes-host URL; only
 *     `handlePortalDownload` appends a ticket to it, after every check (plans/PX-W3.md §6.2).
 *     Device trust does not apply to a portal download (the licence-only rule
 *     `entitledAccess.ts` names; Q4 (a)).
 *   - `{kind: "redirect", url}`:
 *       1. For a PUBLIC deliverable, Distribution's bytes-host URL for the file
 *          (`delivery.deliveryUrl`), accepted only when it is `https` on the configured bytes
 *          host.
 *       2. Otherwise (the fallback, after the ticket for a non-public deliverable) the
 *          artifact's own GitHub storage URL, but only when the repository is PUBLIC
 *          (`gate.repositoryPublic`). A private repository answers a browser's anonymous
 *          request with GitHub's 404, so its URL is never handed out.
 *   - `null`: nothing here can hand the bytes to a browser. A non-public deliverable is never
 *     REDIRECTED to the bytes host (the browser holds no device token), so without tickets
 *     configured or without a SHA-256 it falls to the public-repository URL, else stays `null`.
 *
 * The listing and the token mint only test for non-null, so they offer exactly what redemption
 * serves.
 */
export type DownloadTarget =
  | { kind: "redirect"; url: string }
  | { kind: "ticket"; base: string };

export async function downloadTarget(
  env: Env,
  artifact: ServedFile,
  gate: DeliveryGate,
  mode: ReleaseAccess,
): Promise<DownloadTarget | null> {
  if (mode === "public") {
    const hosted = await bytesHostTarget(env, artifact, gate);
    if (hosted !== null) return { kind: "redirect", url: hosted.toString() };
  }
  if (mode !== "public") {
    // HA-09: a licensed file the bytes host serves (its mirrored R2 copy, or a private
    // repository's asset streamed there) goes by ticket BEFORE any GitHub URL, so the licensed
    // download never depends on, or hands out, a GitHub address.
    const ticketed = await ticketTarget(env, artifact, gate);
    if (ticketed !== null) return ticketed;
  }
  const source = redirectableSourceUrl(artifact);
  if (source !== null && (await gate.repositoryPublic()))
    return { kind: "redirect", url: source };
  return null;
}

/** The ticketed target for a non-public deliverable's file, or `null` (no tickets configured,
 *  no recorded SHA-256, or no bytes-host URL for it). */
async function ticketTarget(
  env: Env,
  artifact: ServedFile,
  gate: DeliveryGate,
): Promise<DownloadTarget | null> {
  if (!artifact.sha256 || !downloadTicketsEnabled(env)) return null;
  // HA-09F: a ticket is handed out only for a file the bytes host can serve, so the person is
  // never sent to a 404; a file it cannot serve falls back as a missing mirror always has.
  if (!(await bytesHostCanServe(env, artifact, gate))) return null;
  const hosted = await bytesHostTarget(env, artifact, gate);
  // A ticket is honoured on the bytes host alone (origin isolation, THREAT-MODEL §3), so the
  // URL must sit on it and carry no query of its own for the ticket to join.
  return hosted !== null && isBytesHost(hosted, env) && hosted.search === ""
    ? { kind: "ticket", base: hosted.toString() }
    : null;
}

/**
 * Can the bytes host serve this file from a stored copy it holds? Mirrors the order its `files`
 * route walks (`distribution/bytes.ts` `serveArtifact`): a GitHub location streams through the
 * installation token and an `https` external one redirects, so either serves; an R2 location
 * serves only when its key is the content address of THIS file's SHA-256, the product holds a
 * ref to it and the object is there. A location list that names none of these (a location
 * recorded with its object missing) is the one case this refuses. Unknown locations (an older
 * caller that did not pass them) are not second-guessed.
 */
async function bytesHostCanServe(
  env: Env,
  artifact: ServedFile,
  gate: DeliveryGate,
): Promise<boolean> {
  const locations = artifact.locations;
  if (locations === undefined) return true;
  for (const loc of locations) {
    if (loc.provider === "github") return true;
    if (loc.provider === "external" && loc.url?.startsWith("https://"))
      return true;
    if (loc.provider !== "r2" || !loc.key || !env.BLOBS || !artifact.sha256)
      continue;
    const parsed = parseKey(loc.key);
    if (
      !parsed ||
      parsed.area !== "locked" ||
      parsed.kind !== "blob" ||
      parsed.gated ||
      parsed.sha256 !== artifact.sha256
    )
      continue;
    if (gate.db && !(await hasRef(gate.db, gate.product.slug, loc.key)))
      continue;
    if ((await env.BLOBS.head(loc.key)) !== null) return true;
  }
  return false;
}

/** Distribution's bytes-host URL for a file, when it is `https` on the configured bytes host. */
async function bytesHostTarget(
  env: Env,
  artifact: ServedFile,
  gate: DeliveryGate,
): Promise<URL | null> {
  const minted = await gate.delivery.deliveryUrl({
    releaseId: artifact.releaseId,
    name: artifact.name,
  });
  if (!minted) return null;
  let url: URL;
  try {
    url = new URL(minted);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  return isAllowedDownloadRedirectHost(url.hostname, env) ? url : null;
}

/**
 * R6-12 — may this artifact's `source_url` be handed to a browser as a redirect target?
 *
 * ── WHY THIS EXISTS NOW ─────────────────────────────────────────────────────────────────────
 *
 * The finding was rated **dormant**, on one ground: `release_artifacts.source_url` had no writer
 * anywhere in `src/`, so the value could not be attacker-controlled and the missing allowlist
 * could not be reached. P2.T2 gives it a writer (`services/release/store.ts`). The redirect is
 * hardened in the same change, as a blocking requirement of arming the store.
 *
 * ── WHY ALLOWLIST RATHER THAN PROXY ─────────────────────────────────────────────────────────
 *
 * The finding offers "or proxy the bytes". Proxying an ARBITRARY stored URL would be strictly
 * worse: it converts a redirect the user's browser makes into a fetch this worker makes, from
 * inside Cloudflare's network, with the worker's own egress — i.e. it trades an open redirect
 * for an SSRF. `streamAsset` is safe because it addresses an asset by ID through the GitHub API
 * and guards the redirect it gets back with THIS predicate; it is not a general URL proxy. So
 * the answer is the same predicate, applied one layer earlier, and a refusal when it fails.
 *
 * Two layers, deliberately: the writer only ever stores GitHub's own `browser_download_url`, and
 * the reader refuses anything else. Either alone would be enough today; together they mean a
 * future writer (an R2 mirror, an operator import) cannot silently re-open this by forgetting.
 */
function redirectableSourceUrl(artifact: ServedFile): string | null {
  if (!artifact.sourceUrl) return null;
  let url: URL;
  try {
    url = new URL(artifact.sourceUrl);
  } catch {
    return null;
  }
  // `https` only. A stored `http://` target would strip transport security from a download the
  // user believes this origin vouched for, and no GitHub storage host serves plaintext.
  if (url.protocol !== "https:") return null;
  if (!isAllowedStorageHost(url.hostname)) return null;
  return url.toString();
}

/**
 * Charge a portal action against its rate-limit budget.
 *
 * R5-05: this used to key every action `${accountId}:${ip}` inside the single global
 * `_portal` Durable Object. One portal account routinely holds licenses for several products,
 * so a budget spent managing tenant A's devices 429'd the same person on tenants B, C and D —
 * and because every product on the platform shared one DO, one noisy account was contention
 * for everyone. `product` is therefore BOTH a dimension of the counter id and the DO shard, so
 * a tenant's traffic can only exhaust that tenant's budget in that tenant's shard.
 *
 * `product` must already have been proven to exist (it names a Durable Object; an
 * unvalidated, caller-supplied slug would let anyone spawn unbounded DO instances). Callers
 * that have no validated product — `portalClaimKey`, which derives one from the submitted key
 * — pass `undefined` and keep the account-wide budget, which for a brute-force guard on the
 * caller's OWN account is strictly the stronger choice.
 */
export async function requireActionRateLimit(
  req: Request,
  env: Env,
  session: PortalSession,
  bucket: string,
  now: number,
  limit: number,
  product?: string,
  windowSec = 60,
): Promise<Response | null> {
  const { shard, rl } = portalActionLimit(
    req,
    session.accountId,
    bucket,
    limit,
    product,
    windowSec,
  );
  const ok = await rateLimitOk(env, shard, rl, now);
  return ok ? null : err(429, "rate_limited", "too many attempts");
}

/** The console's front door as the person's browser should address it, or null when unknown. */
function consoleEntry(env: Env, req: Request): string | null {
  const origin = consoleOrigin(env, req);
  return origin === null ? null : `${origin}/manage/`;
}

async function handleMe(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  now: number,
): Promise<Response> {
  const account = await getPortalAccount(db, session.accountId);
  if (!account) return unauthorized();
  await syncLicenseLinksAndNotify(
    env,
    db,
    session.accountId,
    now,
    noticeOrigin(env, req),
  );
  return portalJson({
    account: {
      id: account.id,
      name: account.display_name ?? session.name,
      email: account.primary_email ?? session.email,
      // I-07, PX-W16: the picture in use, re-encoded and served same-origin (256 px; `-96` for
      // the small one); null shows initials. `GET /api/me/profile` has the rest.
      avatarUrl: avatarUrl(account.avatar_key ?? null),
      deletion: await accountDeletionSchedule(db, session.accountId),
      // ST-30: where the account menu's "Open console" goes, for an operator's account only (else
      // null: no entry). A pointer, not a grant: the console decides on arrival.
      console: (await accountMayOpenConsole(env, db, session.accountId, now))
        ? consoleEntry(env, req)
        : null,
    },
    csrf: session.csrf,
  });
}

/**
 * `DELETE /api/me` schedules the holder's own account for hard erasure after the grace period.
 * The request has no account parameter: authentication, CSRF and the fresh-sign-in gate bind it
 * to this session's account only. Repeating it preserves the original deadline.
 */
async function handleMeDelete(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  now: number,
): Promise<Response> {
  const account = await getPortalAccount(db, session.accountId);
  if (!account) return unauthorized();
  const stale = portalStepUpGate(session, now);
  if (stale) return stale;
  const limited = await requireActionRateLimit(
    req,
    env,
    session,
    "portalAccountDelete",
    now,
    5,
  );
  if (limited) return limited;
  const { schedule, created } = await scheduleAccountDeletion(
    db,
    session.accountId,
    now,
  );
  if (created) {
    await portalAudit(db, {
      accountId: session.accountId,
      action: "portal.account.deletion.schedule",
      targetKind: "account",
      targetId: session.accountId,
      summary: "Scheduled account deletion",
      now,
    });
    await sendSecurityNotice(
      env,
      db,
      session.accountId,
      account.primary_email ?? session.email,
      accountDeletionScheduledNotice({
        origin: new URL(req.url).origin,
        dueAt: schedule.dueAt,
      }),
      now,
    );
  }
  return portalJson({
    ok: true,
    scheduled: true,
    deletionDueAt: schedule.dueAt,
  });
}

/** Cancel a pending erasure before its deadline. A claim or deadline makes it irreversible. */
async function handleMeDeletionCancel(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  now: number,
): Promise<Response> {
  const account = await getPortalAccount(db, session.accountId);
  if (!account) return unauthorized();
  const stale = portalStepUpGate(session, now);
  if (stale) return stale;
  const limited = await requireActionRateLimit(
    req,
    env,
    session,
    "portalAccountDelete",
    now,
    5,
  );
  if (limited) return limited;
  const outcome = await cancelAccountDeletion(db, session.accountId, now);
  if (outcome === "in_progress")
    return err(
      409,
      "deletion_in_progress",
      "account deletion has already begun",
    );
  if (outcome === "cancelled") {
    await portalAudit(db, {
      accountId: session.accountId,
      action: "portal.account.deletion.cancel",
      targetKind: "account",
      targetId: session.accountId,
      summary: "Cancelled account deletion",
      now,
    });
    await sendSecurityNotice(
      env,
      db,
      session.accountId,
      account.primary_email ?? session.email,
      accountDeletionCancelledNotice({ origin: new URL(req.url).origin }),
      now,
    );
  }
  return portalJson({ ok: true });
}

/**
 * R5-06 — `/api/capabilities?product=<slug>` answers for THAT product; without `product` it
 * answers for the platform as a whole (the root login page, which has no product context).
 * The unscoped answer used to be the only one available, so one tenant's settings decided
 * every other tenant's — and leaked, pre-auth, whether any tenant had each feature on.
 */
async function handleCapabilities(
  env: Env,
  db: Db,
  product: string | null | undefined,
  now: number,
): Promise<Response> {
  const caps = await portalAuthCapabilities(db, product);
  // I-30: the seeded platform connection is the single sign-on button's only source, and every
  // other active platform connection for customers is a "Continue with <label>" entry.
  const sso = caps.portalEnabled;
  const seeded = sso ? await platformEnvConnection(env, db, now) : null;
  const connections = sso
    ? (await activePlatformConnections(db, "customers"))
        .filter((c) => c.id !== PLATFORM_ENV_CONNECTION_ID)
        .map((c) => ({ id: c.id, label: c.label }))
    : [];
  return portalJson({
    auth: {
      // I-17: past the platform IdP's sunset the card stops offering single sign-on.
      oidc:
        sso &&
        seeded !== null &&
        seeded.status === "active" &&
        audienceCovers(seeded.audience, "customers") &&
        !platformSignInEnded(env, now),
      connections,
      magic: caps.portalEnabled && emailConfigured(env),
      // I-16: passkeys are an account sign-in method, platform-level (no product toggle).
      passkey: caps.portalEnabled,
    },
    // I-07: the login card renders Cloudflare Turnstile on the email start with this public
    // site key; null when the deploy has Turnstile off (no token is asked for).
    turnstileSiteKey: turnstileSiteKey(env),
    modules: {
      licensing: caps.portalEnabled,
      claim: caps.portalEnabled,
      releases: caps.portalEnabled && caps.releasesEnabled,
    },
  });
}

async function handleLicenses(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  rest: string[],
  now: number,
  hooksFor: PortalHooksFor | undefined,
): Promise<Response> {
  await syncLicenseLinksAndNotify(
    env,
    db,
    session.accountId,
    now,
    noticeOrigin(env, req),
  );
  const [product, licenseId] = rest;
  if (!product) {
    const rows = await listPortalLicenses(db, session.accountId);
    const shown: PortalLicenseRow[] = [];
    for (const row of rows) {
      const settings = await getPortalProductSettings(db, row.product);
      if (settings.portal_enabled !== 1) continue;
      shown.push(row);
    }
    // One provenance read per product for the origins' store (PX-23).
    const stores = await licenseStores(db, shown, hooksFor, now);
    const filtered = [];
    for (const row of shown)
      filtered.push(
        await shapeLicenseSummary(
          db,
          row,
          now,
          stores.get(storeKey(row.product, row.id)) ?? null,
        ),
      );
    return portalJson({ licenses: filtered });
  }
  if (!licenseId) return notFound();
  const row = await getPortalLicense(db, session.accountId, product, licenseId);
  if (!row) return notFound();
  const settings = await getPortalProductSettings(db, product);
  if (settings.portal_enabled !== 1) return notFound();
  return portalJson({
    ...(await shapeLicenseDetail(db, row, now, hooksFor)),
    // PX-W5 (G7): whether "Get a new key" is offered for this licence — the product's opt-in.
    canGetNewKey: settings.key_reissue_enabled === 1 && row.status === "active",
  });
}

/** One non-public feed a licensee may mint a token for (Q3). */
interface PackageAccessFeed {
  ecosystem: string;
  accessMode: string;
  baseUrl: string | null;
  /** The feed's namespace settings (npm's `scope`), which the setup snippets name. */
  namespace: Record<string, unknown>;
}

/**
 * The product's enabled feeds that are not public, through Distribution's delivery hook (rule 6:
 * the settings are Distribution's): what the portal's Package access card lists, and the
 * condition for a licensee to mint at all (Q3: no extra opt-in).
 */
async function nonPublicFeeds(
  db: Db,
  hooksFor: PortalHooksFor | undefined,
  product: string,
  now: number,
): Promise<PackageAccessFeed[]> {
  const gate = await deliveryGate(db, hooksFor, product, now);
  if (!gate) return [];
  const out: PackageAccessFeed[] = [];
  for (const eco of PACKAGE_ECOSYSTEMS) {
    const feed = await gate.delivery.packageFeed(eco);
    if (
      !feed ||
      !feed.enabled ||
      !feed.ownerEnabled ||
      !feed.policyEnabled ||
      (feed.accessMode ?? "public") === "public"
    )
      continue;
    out.push({
      ecosystem: eco,
      accessMode: feed.accessMode!,
      baseUrl: feed.baseUrl ?? null,
      namespace: feed.namespace ?? {},
    });
  }
  return out;
}

/** One private feed the account may read, with its product: Account → Packages' setup list. */
export interface ReadableFeed extends PackageAccessFeed {
  product: string;
  productName: string;
  /** A usable licence of the account in this product: the Godot URL token is bound to it. */
  licenseId: string;
}

/**
 * The private feeds a person's usable licences reach, one entry per product and ecosystem
 * (F-33). The system product never appears: a customer's licence there grants nothing
 * (`personMayRead`). A product whose licences are all unusable is left out.
 */
export async function readableFeeds(
  db: Db,
  hooksFor: PortalHooksFor | undefined,
  accountId: string,
  now: number,
): Promise<ReadableFeed[]> {
  const rows = await listPortalLicenses(db, accountId);
  const seen = new Set<string>();
  const out: ReadableFeed[] = [];
  for (const row of rows) {
    if (seen.has(row.product) || row.product === SYSTEM_PRODUCT_SLUG) continue;
    if (!licenseUsable(row, now)) continue;
    seen.add(row.product);
    const settings = await getPortalProductSettings(db, row.product);
    if (settings.portal_enabled !== 1) continue;
    for (const feed of await nonPublicFeeds(db, hooksFor, row.product, now))
      out.push({
        ...feed,
        product: row.product,
        productName: row.product_name,
        licenseId: row.id,
      });
  }
  return out;
}

/** One licence-bound registry token of the account, for Account → Packages' per-app group. */
export interface LegacyRegistryToken {
  product: string;
  productName: string;
  licenseId: string;
  tokenId: string;
  label: string;
  hint: string;
  ecosystems: string[] | null;
  presentation: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  status: string;
}

/**
 * The licence-bound `pkeyr_` tokens this account minted (the ones made before F-33, and the Godot
 * editor URL tokens), across its licences, so their owner can see and revoke them in one place.
 */
export async function accountRegistryTokens(
  db: Db,
  accountId: string,
  now: number,
): Promise<LegacyRegistryToken[]> {
  const out: LegacyRegistryToken[] = [];
  for (const row of await listPortalLicenses(db, accountId)) {
    for (const t of await listRegistryTokens(db, row.product, now, {
      licenseId: row.id,
      portalAccountId: accountId,
    }))
      out.push({
        product: row.product,
        productName: row.product_name,
        licenseId: row.id,
        tokenId: t.tokenId,
        label: t.label,
        hint: t.hint,
        ecosystems: t.ecosystems ? [...t.ecosystems] : null,
        presentation: t.presentation,
        createdAt: t.createdAt,
        expiresAt: t.expiresAt,
        lastUsedAt: t.lastUsedAt,
        revokedAt: t.revokedAt,
        status: t.status,
      });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Package access (F-21, plans/F-20.md §6.5, PORTAL.md's "Package access" card): a licensee's own
 * registry tokens for one linked licence.
 *
 *   GET    /portal/api/licenses/:product/:licenseId/registry-tokens           the card's state:
 *          `available` (an enabled non-public feed exists), those feeds with their base URLs,
 *          the tokens this account minted for this licence, the username and the limits
 *   POST   …/registry-tokens  {label, ecosystem: "godot", expiresInDays?}   mint the licence-bound
 *          Godot editor URL token (the only per-app mint since F-33; every other feed is read with
 *          the person's `pkeyp_` token, Account → Packages); the plaintext is in this answer only
 *   DELETE …/registry-tokens/:tokenId                                         revoke one
 *
 * Tokens minted here before F-33 stay listed, honoured and revocable until they expire.
 * Audited `portal.registry_token.create` and `.revoke`.
 */
async function handleRegistryTokens(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  product: string,
  licenseId: string,
  tokenId: string | undefined,
  now: number,
  hooksFor: PortalHooksFor | undefined,
): Promise<Response> {
  const settings = await getPortalProductSettings(db, product);
  if (settings.portal_enabled !== 1) return notFound();
  const license = await getPortalLicense(
    db,
    session.accountId,
    product,
    licenseId,
  );
  if (!license) return notFound();
  const filter = { licenseId, portalAccountId: session.accountId };
  const by = `portal:${session.accountId}`;
  if (tokenId !== undefined) {
    if (req.method !== "DELETE") return err(405, "method_not_allowed");
    const view = await revokeRegistryToken(
      db,
      product,
      tokenId,
      by,
      "manual",
      now,
      filter,
    );
    if (!view) return notFound();
    await portalAudit(db, {
      accountId: session.accountId,
      action: "portal.registry_token.revoke",
      product,
      targetKind: "registry_token",
      targetId: tokenId,
      summary: `Revoked registry token “${view.label}” (…${view.hint})`,
      now,
    });
    return portalJson({ ok: true, view });
  }
  const feeds = await nonPublicFeeds(db, hooksFor, product, now);
  if (req.method === "GET")
    return portalJson({
      available: feeds.length > 0,
      licenseUsable: licenseUsable(license, now),
      registryOrigin: registryOrigin(env),
      username: REGISTRY_TOKEN_USERNAME,
      feeds,
      tokens: await listRegistryTokens(db, product, now, filter),
      limits: {
        minDays: REGISTRY_TOKEN_MIN_DAYS,
        maxDays: REGISTRY_TOKEN_MAX_DAYS,
        defaultDays: REGISTRY_TOKEN_DEFAULT_DAYS,
        urlDefaultDays: REGISTRY_URL_TOKEN_DEFAULT_DAYS,
        perLicense: MAX_LIVE_TOKENS_PER_LICENSE,
      },
    });
  if (req.method !== "POST") return err(405, "method_not_allowed");
  // F-33: the portal mints no licence-bound token except the Godot editor's URL token. One
  // `pkeyp_` token per computer (Account → Packages, `/api/me/tokens`) reads every other feed. The
  // Godot editor sends no credentials, so its feed is reached through a URL holding a token, and
  // a `pkeyp_` token (a year, every product) must never be put in a URL: this one is bound to the
  // licence, read-only, narrowed to Godot and short-lived. Tokens minted here earlier stay listed,
  // honoured and revocable until they expire.
  const stale = portalStepUpGate(session, now);
  if (stale) return stale;
  const limited = await requireActionRateLimit(
    req,
    env,
    session,
    "portalRegistryToken",
    now,
    20,
    product,
    3600,
  );
  if (limited) return limited;
  if (!licenseUsable(license, now))
    return err(403, ErrorCode.Forbidden, "this licence is not active");
  const body = await readBody(req);
  if (body.ecosystem !== "godot" || !feeds.some((f) => f.ecosystem === "godot"))
    return err(
      422,
      ErrorCode.BadRequest,
      "only the Godot editor URL is made per app: create a personal token in Account → Packages",
    );
  const res = await mintRegistryToken(
    env,
    db,
    {
      product,
      label: typeof body.label === "string" ? body.label : "",
      ecosystems: ["godot"],
      ...(typeof body.expiresInDays === "number"
        ? { expiresInDays: body.expiresInDays }
        : {}),
      binding: "license",
      licenseId,
      presentation: "url",
      createdBy: by,
      portalAccountId: session.accountId,
    },
    now,
  );
  if (!res.ok)
    return portalJson(
      {
        error: res.status === 404 ? ErrorCode.NotFound : ErrorCode.BadRequest,
        message: res.message,
        reason: res.reason,
        ...(res.fields ? { fields: res.fields } : {}),
      },
      res.status,
    );
  await portalAudit(db, {
    accountId: session.accountId,
    action: "portal.registry_token.create",
    product,
    targetKind: "registry_token",
    targetId: res.view.tokenId,
    summary: `Created Godot editor URL token “${res.view.label}” (…${res.view.hint}) for licence ${licenseId}`,
    now,
  });
  return portalJson({ ok: true, token: res.token, view: res.view }, 201);
}

async function handleDeviceDelete(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  product: string,
  licenseId: string,
  deviceId: string,
  now: number,
): Promise<Response> {
  if (req.method !== "DELETE") return err(405, "method_not_allowed");
  // The shared operation (`freeAccountDevice`): the sign-in chooser's Replace runs the same
  // checks, audit, email and rate-limit budget (plans/I-04.md, owner decision 2026-10-05 §B).
  const freed = await freeAccountDevice(
    req,
    env,
    db,
    { accountId: session.accountId, email: session.email },
    product,
    licenseId,
    deviceId,
    now,
  );
  if (!freed.ok) {
    if (freed.reason === "rate_limited")
      return err(429, "rate_limited", "too many attempts");
    return notFound();
  }
  return portalJson({ ok: true, deviceId });
}

/**
 * The token mint's refusal codes once the caller is known to own the product (a stranger only
 * ever gets `not_found`). The last three are the downloads listing's `PortalFileReason`s, so a
 * file the listing marks unavailable and a click the mint refuses say the same thing.
 */
export const MINT_REFUSAL = {
  fileNotFound: "file_not_found",
  notHosted: "not_hosted",
  licenseInactive: "license_inactive",
  notEntitled: "not_entitled",
} as const;

async function handleReleases(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  rest: string[],
  now: number,
  hooksFor: PortalHooksFor | undefined,
): Promise<Response> {
  const [product, releaseId, artifactsSegment, artifactId, tokenSegment] = rest;
  if (!product) {
    const products = await listLinkedProducts(db, session.accountId);
    const enabledProducts: string[] = [];
    for (const row of products) {
      const settings = await getPortalProductSettings(db, row.slug);
      // Task 7.2: the same conjunction `portalAuthCapabilities` folds for `modules.releases`,
      // applied to the rows rather than to the tab. Gating only the capability would hide the
      // Downloads nav item while leaving this endpoint enumerating a non-Release product's
      // truth store to anyone who deep-links `#/downloads` — the nav is a courtesy, the listing
      // is the actual disclosure, and `services_json` has to bind both or it binds neither.
      if (
        settings.portal_enabled === 1 &&
        releaseServiceEnabled(row.services_json)
      ) {
        enabledProducts.push(row.slug);
      }
    }
    const releases = await listPortalReleases(
      db,
      hooksFor,
      enabledProducts,
      now,
    );
    const gates = new Map<string, DeliveryGate | null>();
    // Whether the account holds a USABLE licence for each product: read once for the whole
    // listing, and only when some release's metadata is gated on one.
    let linked: PortalLicenseRow[] | undefined;
    const usableByProduct = new Map<string, boolean>();
    const out = [];
    for (const release of releases) {
      // `metadataAccess` is the product's METADATA mode as of the last sync (`storeAccess`:
      // `entitled` is stored as `licensed`, the strictest thing an account with no device can be
      // asked for). The whole entry IS the metadata (version, title, notes and the upstream
      // URL), so a `licensed` gate the account does not satisfy withholds the ROW: blanking the
      // fields would still disclose that the release exists and which version it is.
      // `authenticated` and `public` need nothing more than the session already proves.
      if (release.metadataAccess === "licensed") {
        let usable = usableByProduct.get(release.product);
        if (usable === undefined) {
          linked ??= await listPortalLicenses(db, session.accountId);
          usable = linked.some(
            (row) => row.product === release.product && licenseUsable(row, now),
          );
          usableByProduct.set(release.product, usable);
        }
        if (!usable) continue;
      }
      let gate = gates.get(release.product);
      if (gate === undefined) {
        gate = await deliveryGate(db, hooksFor, release.product, now);
        gates.set(release.product, gate);
      }
      // Distribution off: nothing is downloadable, and the listing says so.
      const mode: ReleaseAccess | null = gate
        ? await gate.delivery.accessMode(release.deliverableId)
        : null;
      const allowed =
        gate !== null &&
        mode !== null &&
        (await accountMayDownload(
          db,
          session.accountId,
          gate,
          mode,
          {
            deliverable_id: release.deliverableId,
            version: release.version,
            channel: release.channel,
          },
          now,
        ));
      const rows = [];
      for (const artifact of release.artifacts) {
        rows.push({
          artifactId: artifact.artifactId,
          name: artifact.name,
          kind: artifact.kind,
          // Read-time inference, display only: a file with no platform of its own takes its
          // build's, and a file tied to no build the one its name declares.
          platform:
            artifact.platform ??
            (artifact.buildId
              ? (release.buildPlatforms.get(artifact.buildId) ?? null)
              : platformFromFileName(artifact.name)),
          arch: artifact.arch,
          sizeBytes: artifact.sizeBytes,
          sha256: artifact.sha256,
          access: mode ?? "public",
          // Same predicates the mint and the redirect apply (R6-12, P2b-04), so the portal
          // never offers a download it is going to refuse — an artifact stored with an
          // unservable URL, or one the account's licences do not reach, reads as unavailable
          // here rather than as a button that 404s.
          canDownload:
            allowed &&
            gate !== null &&
            mode !== null &&
            (await downloadTarget(
              env,
              servedFile(artifact.source),
              gate,
              mode,
            )) !== null,
        });
      }
      out.push({
        product: release.product,
        productName: release.productName,
        releaseId: release.releaseId,
        version: release.version,
        title: release.title,
        notes: release.notes,
        publishedAt: release.publishedAt,
        sourceUrl: release.sourceUrl,
        artifacts: rows,
      });
    }
    return portalJson({ releases: out });
  }

  if (
    artifactsSegment !== "artifacts" ||
    !releaseId ||
    !artifactId ||
    tokenSegment !== "token"
  ) {
    return notFound();
  }
  if (req.method !== "POST") return err(405, "method_not_allowed");
  const productRow = await getProduct(db, product);
  if (!productRow) return notFound();
  const settings = await getPortalProductSettings(db, product);
  // The third term is `services_json`, and it is the one that makes Task 7.2's claim true rather
  // than merely visible: the capability hides the tab and the listing hides the rows, but the
  // MINT is the only one of the three an attacker reaches without either. Turning Release off
  // does not delete `release_artifacts`, so a caller holding an artifact id from before the
  // switch was flipped could still have obtained a signed download URL for a product that no
  // longer runs the service at all.
  if (
    settings.portal_enabled !== 1 ||
    !releaseServiceEnabled(productRow.services_json)
  ) {
    return notFound();
  }
  // Ownership first: a caller with no linked licence for the product learns nothing, not even
  // whether the release or the file exists. Every refusal before this line is the same 404.
  if (!(await hasLinkedProductLicense(db, session.accountId, product))) {
    return notFound();
  }
  // R5-05: same as the disconnect path — the charge lands after the linked-license check, in
  // this product's own shard, so it can neither be spent by a non-owner nor 429 a sibling
  // tenant of the same portal account.
  const limited = await requireActionRateLimit(
    req,
    env,
    session,
    "portalDownloadToken",
    now,
    60,
    product,
  );
  if (limited) return limited;
  // From here the caller owns the product, so a refusal says why, with the downloads listing's
  // own reason codes (`downloads.ts`), and the portal turns the code into words. Refused at MINT
  // time as well as at redemption: a token that could only ever be rejected is a row written
  // and a URL handed to the user for nothing.
  // Byte delivery is Distribution's: with it off (or no hooks to ask), nothing is minted.
  const gate = await deliveryGate(db, hooksFor, product, now);
  if (!gate)
    return err(
      409,
      MINT_REFUSAL.notHosted,
      "downloads are not served for this product",
    );
  const found = await servedFileOf(gate, releaseId, artifactId);
  if (!found)
    return err(
      404,
      MINT_REFUSAL.fileNotFound,
      "this release or file is no longer offered",
    );
  const { file: artifact, facts } = found;
  const mode = await gate.delivery.accessMode(facts.deliverable_id);
  if (!mode)
    return err(
      409,
      MINT_REFUSAL.notHosted,
      "downloads are not served for this product",
    );
  // The delivery access every download surface reads (P2b-04): `licensed` needs a usable
  // licence, `entitled` one whose grant holds this release's channel and version.
  if (
    !(await accountMayDownload(db, session.accountId, gate, mode, facts, now))
  )
    return err(
      403,
      mode === "entitled"
        ? MINT_REFUSAL.notEntitled
        : MINT_REFUSAL.licenseInactive,
      `${mode} release access required`,
    );
  if ((await downloadTarget(env, artifact, gate, mode)) === null)
    return err(
      409,
      MINT_REFUSAL.notHosted,
      "this file cannot be downloaded from the portal yet",
    );
  const token = await mintDownloadToken(env, db, {
    product,
    releaseId,
    artifactId,
    scope: { portalAccountId: session.accountId },
    now,
  });
  return portalJson({ url: `/download/${encodeURIComponent(token)}` }, 201);
}

/**
 * `POST /api/products/<product>/email-download` `{ platform }` — G23, "Email me the download".
 *
 * Someone browsing on a phone asks for the desktop build; the Worker mails the account's own
 * address a deep link to `#/p/<product>/download?platform=<platform>`. The link is the app
 * route, not a download token: it carries no credential, works only for whoever signs in, and
 * so cannot be replayed from a forwarded or leaked email.
 *
 * Gated like the downloads it points at — portal on, release downloads on, the product running
 * Release, a license for it linked to the account — and every refusal before the send is the
 * same 404, so the route says nothing about products the caller has no license for. The rate
 * limit lands after ownership is proven (R5-05), in the product's shard, and is small and
 * hourly: it is a mail-sending surface, so its bucket fails closed (`core/rateLimit.ts`).
 */
async function handleEmailDownload(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  product: string,
  now: number,
): Promise<Response> {
  if (req.method !== "POST") return err(405, "method_not_allowed");
  const body = await readBody(req);
  const platform = typeof body.platform === "string" ? body.platform : "";
  if (!(RELEASE_PLATFORMS as readonly string[]).includes(platform)) {
    return err(422, ErrorCode.BadRequest, "unknown platform");
  }
  const productRow = await getProduct(db, product);
  if (!productRow) return notFound();
  const settings = await getPortalProductSettings(db, product);
  if (
    settings.portal_enabled !== 1 ||
    !releaseServiceEnabled(productRow.services_json)
  ) {
    return notFound();
  }
  if (!(await hasLinkedProductLicense(db, session.accountId, product))) {
    return notFound();
  }
  if (!emailConfigured(env)) {
    return err(503, "email_unavailable", "email is not configured");
  }
  const limited = await requireActionRateLimit(
    req,
    env,
    session,
    "portalEmailDownload",
    now,
    EMAIL_DOWNLOAD_PER_HOUR,
    product,
    3600,
  );
  if (limited) return limited;
  const account = await getPortalAccount(db, session.accountId);
  await sendNotice(
    env,
    db,
    account?.primary_email ?? session.email,
    downloadLinkEmail({
      productName: productRow.name,
      productSlug: product,
      platform,
      origin: new URL(req.url).origin,
    }),
    now,
  );
  return portalJson({ ok: true }, 202);
}

/**
 * I-07 account sessions (S-16 §5.4 item 7): `GET /api/sessions` lists the account's live
 * sessions (the current one marked); `DELETE /api/sessions/<id>` ends one; `POST
 * /api/sessions/sign-out-everywhere` ends every one, this browser's included, and clears its
 * cookie. Mutations carry the CSRF header (checked by the dispatcher above). I-11 builds the
 * settings page on these.
 */
async function handleSessions(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  currentIdHash: string,
  rest: string[],
  now: number,
): Promise<Response> {
  if (rest.length === 0) {
    if (req.method !== "GET") return err(405, "method_not_allowed");
    return portalJson({
      sessions: await listAccountSessions(
        db,
        session.accountId,
        currentIdHash,
        now,
      ),
    });
  }
  if (rest.length === 1 && rest[0] === "sign-out-everywhere") {
    if (req.method !== "POST") return err(405, "method_not_allowed");
    const ended = await revokeAllAccountSessions(db, session.accountId, now);
    // The apps too (S-17 §5.8 item 2): Core's one clearing hook drops every device's binding to
    // this account, releasing a seat only where the sign-in itself bound it.
    const devices = await clearDeviceSubjects(
      db,
      env,
      { kind: "account", accountId: session.accountId },
      "signout_everywhere",
    );
    await portalAudit(db, {
      accountId: session.accountId,
      action: "portal.sessions.revoke_all",
      summary: `Signed out everywhere (${ended} sessions, ${devices.cleared} devices)`,
      now,
    });
    const out = portalJson({ ok: true, ended, devices: devices.cleared }, 200, {
      "set-cookie": buildPortalClearCookie(),
    });
    // PX-W12: a Link an existing account flow in this browser ends with the session.
    out.headers.append("set-cookie", clearAccountRealmCookie(LINK_FLOW_COOKIE));
    return out;
  }
  if (rest.length === 1 && rest[0]) {
    if (req.method !== "DELETE") return err(405, "method_not_allowed");
    const id = rest[0];
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(id)) return notFound();
    const ended = await revokeAccountSession(db, session.accountId, id, now);
    if (!ended) return notFound();
    await portalAudit(db, {
      accountId: session.accountId,
      action: "portal.sessions.revoke",
      summary: "Ended a session",
      now,
    });
    const current = id === currentIdHash;
    const out = portalJson(
      { ok: true, current },
      200,
      current ? { "set-cookie": buildPortalClearCookie() } : undefined,
    );
    if (current)
      out.headers.append(
        "set-cookie",
        clearAccountRealmCookie(LINK_FLOW_COOKIE),
      );
    return out;
  }
  return notFound();
}

/** "Email me the download" sends per account, per product, per hour. */
export const EMAIL_DOWNLOAD_PER_HOUR = 5;

/** A path's non-empty segments, each percent-decoded once; `null` when one is malformed. */
export function decodeSegments(path: string): string[] | null {
  const out: string[] = [];
  for (const raw of path.split("/")) {
    if (!raw) continue;
    try {
      out.push(decodeURIComponent(raw));
    } catch {
      return null;
    }
  }
  return out;
}

export async function handlePortalApi(
  ...args: Parameters<typeof dispatchPortalApi>
): Promise<Response> {
  try {
    return await dispatchPortalApi(...args);
  } catch (e) {
    // A refused body (413 oversize, 400 malformed) is the caller's error, never an empty `{}`.
    if (e instanceof AdminBodyError) return err(e.status, e.code, e.message);
    throw e;
  }
}

/** What a portal API handler is given beside the request. */
interface PortalApiCtx {
  req: Request;
  env: Env;
  db: Db;
  now: number;
  /** One product's descriptor hooks (`dispatch.ts`); without them no download is offered. */
  hooksFor: PortalHooksFor | undefined;
  /** The settings registry (ST-04): what the app-consent view resolves product settings from. */
  settings: SettingsRegistry | undefined;
}

/** The proven session a `session` row's handler is given. */
interface PortalApiSession {
  session: PortalSession;
  sessionIdHash: string;
}

interface PortalApiMatch {
  /** The `:name` segments, percent-decoded. */
  params: Readonly<Record<string, string>>;
  /** The segments a trailing `**` covered, percent-decoded. */
  rest: readonly string[];
}

/**
 * Whether the per-request licence-link sweep (`syncLicenseLinksAndNotify`) runs before the handler:
 * `true` always, `false` never, `{ except }` for every method but one. Scheduling and cancelling
 * an account deletion, the passkey / sign-in-method / token routes and the device-login approval
 * skip it: re-deriving links cannot make them safer and must not block them.
 */
type LinkSweep = boolean | { except: string };

/**
 * A row of the portal API table. The path is a pattern over the `/api` tail's percent-decoded
 * segments (`core/http/pathMatch.ts`: a literal beats `:name` beats `**`; `x/**` also matches
 * `x`). Order is irrelevant. Every gate is on the row:
 *
 *   - `auth: "none"` is a route that proves no account session (the sign-in card, the binder
 *     cookie of a sign-in request, a device-login code); the handler owns whatever it checks.
 *     `auth: "session"` is proven by `requireSession` (401, or 503 with the erasure ledger
 *     unreadable) before the CSRF check and the handler.
 *   - `csrf` (session rows): `"change"` demands the `X-PKey-Portal-CSRF` header on every method
 *     but GET and HEAD; `"always"` demands it on GET too (the two GETs that hand over personal
 *     data, I-11, so a link or a cross-site navigation cannot start one). An absent or wrong
 *     header is `403 csrf`, before the sweep and before any handler.
 *   - `sweep` (session rows): see `LinkSweep`.
 *
 * Rows carry no method list: each handler keeps its own method policy, as the walk this table
 * replaced left them. A path no row names is the `**` row: the session, the CSRF check and the
 * sweep, then the not-found.
 */
type PortalApiRoute = {
  path: string;
  /** A path the row matches but this check refuses, as if the row were absent. */
  accept?: (segments: readonly string[]) => boolean;
} & (
  | {
      auth: "none";
      handler: (c: PortalApiCtx, m: PortalApiMatch) => Promise<Response>;
    }
  | {
      auth: "session";
      csrf: "change" | "always";
      sweep: LinkSweep;
      handler: (
        c: PortalApiCtx,
        m: PortalApiMatch,
        s: PortalApiSession,
      ) => Promise<Response>;
    }
);

const methodNotAllowedUnless = (
  req: Request,
  method: string,
): Response | null =>
  req.method === method ? null : err(405, "method_not_allowed");

/** A caller the account-method routes act for. */
const callerOf = (s: PortalApiSession) => ({
  accountId: s.session.accountId,
  authenticatedAt: portalSessionAuthenticatedAt(s.session),
  sessionIdHash: s.sessionIdHash,
});

export const PORTAL_API_ROUTES: readonly PortalApiRoute[] = [
  // ── No session ────────────────────────────────────────────────────────────────────────────
  {
    path: "capabilities/**",
    auth: "none",
    handler: (c) =>
      handleCapabilities(
        c.env,
        c.db,
        new URL(c.req.url).searchParams.get("product"),
        c.now,
      ),
  },
  // LK-12d: the signed-out card's product name and icon, only for a product Discover offers a
  // new account (`storefrontName.ts`).
  {
    path: "storefront/:product",
    auth: "none",
    handler: (c, m) =>
      handleStorefrontName(
        c.req,
        c.env,
        c.db,
        m.params.product!,
        c.now,
        c.hooksFor,
      ),
  },
  {
    path: "magic/start/**",
    auth: "none",
    handler: (c) => handleMagicStart(c.req, c.env, c.db, c.now),
  },
  // PX-W13 (WIRE-CONTRACT-V4 §12.7.2): the sign-in request the card renders. The binder cookie,
  // not a session: the card shows it before anyone signs in (`passthrough/routes.ts`).
  {
    path: "signin/requests/:request",
    auth: "none",
    handler: async (c, m) => {
      if (c.req.method !== "GET") return err(405, "method_not_allowed");
      const view = await signInRequestView(
        c.env,
        c.db,
        c.req,
        m.params.request!,
        c.now,
        c.hooksFor,
      );
      return view.status === 200 ? portalJson(view.body) : notFound();
    },
  },
  // I-07: the login card's pre-authentication routes (email code and link, the email gate).
  // `signin/requests/*` is PX-W13's: the request view above, and its app-consent, licence and
  // continue views below, which need the session. `signin/requests` itself and anything deeper
  // that no row names are the `**` row's.
  {
    path: "signin/**",
    auth: "none",
    accept: (s) => s[1] !== "requests",
    handler: (c, m) =>
      handleCardApi(c.req, c.env, c.db, ["signin", ...m.rest], c.now),
  },
  // PX-W9 (WIRE-CONTRACT-V4 §12.2 rule 8): the login card's signed-out key preview. Read-only and
  // never counted; it charges its own per-network bucket (`selfService.ts`).
  {
    path: "key/preview",
    auth: "none",
    handler: (c) => handleKeyPreview(c.req, c.env, c.db, c.now, c.settings),
  },
  // PX-W14 (G29): the new device's half of "Sign in with another device" is pre-auth: it has no
  // session yet. The signed-in half (`lookup`, `approve`) is below.
  {
    path: "device-login/start",
    auth: "none",
    // ST-34.5: the body is read on POST only, as the hand dispatch did.
    handler: async (c) =>
      handleDeviceLoginStart(
        c.req,
        c.env,
        c.db,
        c.now,
        c.req.method === "POST" ? await readBody(c.req) : {},
      ),
  },
  {
    path: "device-login/:code",
    auth: "none",
    handler: (c, m) =>
      handleDeviceLoginPoll(
        c.req,
        c.env,
        c.db,
        m.params.code!,
        c.now,
        (accountId) => readableFeeds(c.db, c.hooksFor, accountId, c.now),
      ),
  },

  // ── Session, no licence-link sweep ────────────────────────────────────────────────────────
  // PX-W14: the approver's half. Rate-limited per ACCOUNT alone (not account and client IP, as
  // `requireActionRateLimit` keys it) before any code is looked up, so the budget is the bound on
  // guessing someone else's code however many addresses the guesser rotates through.
  ...(["lookup", "approve"] as const).map(
    (step): PortalApiRoute => ({
      path: `device-login/${step}`,
      auth: "session",
      csrf: "change",
      sweep: false,
      handler: async (c, _m, s) => {
        if (c.req.method !== "POST") return err(405, "method_not_allowed");
        const allowed = await rateLimitOk(
          c.env,
          "_portal",
          {
            bucket: "portalDeviceApprove",
            id: s.session.accountId,
            limit: DEVICE_LOGIN_APPROVE_LIMIT,
            windowSec: 60,
          },
          c.now,
        );
        if (!allowed) return err(429, "rate_limited", "too many attempts");
        const body = await readBody(c.req);
        return step === "lookup"
          ? handleDeviceLoginLookup(c.req, c.env, s.session, body, c.now)
          : handleDeviceLoginApprove(
              c.req,
              c.env,
              c.db,
              s.session,
              body,
              c.now,
            );
      },
    }),
  ),
  // Scheduling and cancellation come before the per-request link sweep (see `LinkSweep`).
  // `me` is a GET for everyone but the DELETE that schedules the deletion.
  {
    path: "me",
    auth: "session",
    csrf: "change",
    sweep: { except: "DELETE" },
    handler: async (c, _m, s) => {
      if (c.req.method === "DELETE")
        return handleMeDelete(c.req, c.env, c.db, s.session, c.now);
      return (
        methodNotAllowedUnless(c.req, "GET") ??
        handleMe(c.req, c.env, c.db, s.session, c.now)
      );
    },
  },
  {
    path: "me/deletion/cancel",
    auth: "session",
    csrf: "change",
    sweep: { except: "POST" },
    handler: async (c, _m, s) =>
      c.req.method === "POST"
        ? handleMeDeletionCancel(c.req, c.env, c.db, s.session, c.now)
        : notFound(),
  },
  // I-16: the account's passkeys (list, add, remove). Adding and removing check step-up and the
  // email rule themselves.
  {
    path: "me/passkeys/**",
    auth: "session",
    csrf: "change",
    sweep: false,
    handler: (c, m, s) =>
      handleAccountPasskeys(
        c.req,
        c.env,
        c.db,
        callerOf(s),
        [...m.rest],
        c.now,
      ),
  },
  // PX-W12 (G27): sign-in methods (list, connect, disconnect) and Link an existing account (join,
  // undo). Each change checks step-up, the never-orphan guard and its own rate limit.
  {
    path: "me/methods/**",
    auth: "session",
    csrf: "change",
    sweep: false,
    handler: (c, m, s) =>
      handleAccountMethods(c.req, c.env, c.db, callerOf(s), [...m.rest], c.now),
  },
  {
    path: "me/link/**",
    auth: "session",
    csrf: "change",
    sweep: false,
    handler: (c, m, s) =>
      handleAccountLink(c.req, c.env, c.db, callerOf(s), [...m.rest], c.now),
  },
  // F-33: Account → Packages, the person's own `pkeyp_` tokens (`personalTokens.ts`).
  {
    path: "me/tokens/**",
    auth: "session",
    csrf: "change",
    sweep: false,
    handler: (c, m, s) =>
      handlePersonalTokens(
        c.req,
        c.env,
        c.db,
        s.session,
        [...m.rest],
        c.now,
        () => readableFeeds(c.db, c.hooksFor, s.session.accountId, c.now),
        () => accountRegistryTokens(c.db, s.session.accountId, c.now),
      ),
  },

  // ── Session, with the licence-link sweep ──────────────────────────────────────────────────
  // PX-W16 (G32, G33): Account → Profile, and picture uploads (`profile.ts`).
  {
    path: "me/profile/**",
    auth: "session",
    csrf: "change",
    sweep: true,
    handler: (c, m, s) =>
      handleProfileApi(
        c.req,
        c.env,
        c.db,
        s.session,
        ["profile", ...m.rest],
        c.now,
      ),
  },
  // I-11: the full export (`dataRoutes.ts`). Only `/api/me` itself answers the summary: any other
  // path below it that no row names is a 404, never the summary in its place (that is how a
  // missing export once saved the summary as the person's "account data").
  {
    path: "me/export",
    auth: "session",
    csrf: "always",
    sweep: true,
    handler: (c, _m, s) =>
      handleAccountExport(
        c.req,
        c.env,
        c.db,
        s.session,
        s.sessionIdHash,
        c.now,
        c.hooksFor,
      ),
  },
  {
    path: "sessions/**",
    auth: "session",
    csrf: "change",
    sweep: true,
    handler: (c, m, s) =>
      handleSessions(
        c.req,
        c.env,
        c.db,
        s.session,
        s.sessionIdHash,
        [...m.rest],
        c.now,
      ),
  },
  // PX-W13 (§12.7.3): app consent for a sign-in request, for the signed-in account.
  {
    path: "signin/requests/:request/consent",
    auth: "session",
    csrf: "change",
    sweep: true,
    handler: async (c, m, s) => {
      if (c.req.method !== "GET") return err(405, "method_not_allowed");
      const view = await signInConsentView(
        c.env,
        c.db,
        c.req,
        m.params.request!,
        s.session.accountId,
        c.now,
        c.settings,
      );
      return view.status === 200 ? portalJson(view.body) : notFound();
    },
  },
  // I-08b (§12.4.1): the licence choice and a full licence's devices, for the signed-in account.
  {
    path: "signin/requests/:request/licenses",
    auth: "session",
    csrf: "change",
    sweep: true,
    handler: async (c, m, s) => {
      if (c.req.method !== "GET") return err(405, "method_not_allowed");
      const view = await signInLicensesView(
        c.env,
        c.db,
        c.req,
        m.params.request!,
        s.session.accountId,
        c.now,
      );
      return view.status === 200 ? portalJson(view.body) : notFound();
    },
  },
  {
    path: "signin/requests/:request/licenses/:license/devices",
    auth: "session",
    csrf: "change",
    sweep: true,
    handler: async (c, m, s) => {
      if (c.req.method !== "GET") return err(405, "method_not_allowed");
      const view = await signInReplaceView(
        c.env,
        c.db,
        c.req,
        m.params.request!,
        m.params.license!,
        s.session.accountId,
        c.now,
      );
      return view.status === 200 ? portalJson(view.body) : notFound();
    },
  },
  // I-08 (§12.4): Continue and Cancel. The row's CSRF check has run; the handlers check the
  // binder, the product and the account.
  ...(["continue", "cancel"] as const).map(
    (step): PortalApiRoute => ({
      path: `signin/requests/:request/${step}`,
      auth: "session",
      csrf: "change",
      sweep: true,
      handler: async (c, m, s) => {
        if (c.req.method !== "POST") return err(405, "method_not_allowed");
        const caller = { accountId: s.session.accountId };
        return step === "continue"
          ? handleSignInContinue(
              c.req,
              c.env,
              c.db,
              caller,
              m.params.request!,
              c.now,
              c.settings,
            )
          : handleSignInCancel(
              c.req,
              c.env,
              c.db,
              caller,
              m.params.request!,
              c.now,
            );
      },
    }),
  ),
  {
    path: "licenses/:product/:license/devices/:device/**",
    auth: "session",
    csrf: "change",
    sweep: true,
    handler: (c, m, s) =>
      c.req.method === "PATCH" && m.rest.length === 0
        ? handleDeviceRename(
            c.req,
            c.env,
            c.db,
            s.session,
            m.params.product!,
            m.params.license!,
            m.params.device!,
            c.now,
          )
        : handleDeviceDelete(
            c.req,
            c.env,
            c.db,
            s.session,
            m.params.product!,
            m.params.license!,
            m.params.device!,
            c.now,
          ),
  },
  {
    path: "licenses/:product/:license/keys",
    auth: "session",
    csrf: "change",
    sweep: true,
    handler: (c, m, s) =>
      handleKeyReissue(
        c.req,
        c.env,
        c.db,
        s.session,
        m.params.product!,
        m.params.license!,
        c.now,
      ),
  },
  ...(["registry-tokens", "registry-tokens/:token"] as const).map(
    (tail): PortalApiRoute => ({
      path: `licenses/:product/:license/${tail}`,
      auth: "session",
      csrf: "change",
      sweep: true,
      handler: (c, m, s) =>
        handleRegistryTokens(
          c.req,
          c.env,
          c.db,
          s.session,
          m.params.product!,
          m.params.license!,
          m.params.token,
          c.now,
          c.hooksFor,
        ),
    }),
  ),
  // PX-23 (S-24 D19): Remove from my library. The licence leaves the account and stays out.
  {
    path: "licenses/:product/:license",
    auth: "session",
    csrf: "change",
    sweep: true,
    handler: (c, m, s) =>
      c.req.method === "DELETE"
        ? handleLicenseRemove(
            c.req,
            c.env,
            c.db,
            s.session,
            m.params.product!,
            m.params.license!,
            c.now,
          )
        : handleLicenses(
            c.req,
            c.env,
            c.db,
            s.session,
            [m.params.product!, m.params.license!],
            c.now,
            c.hooksFor,
          ),
  },
  {
    path: "licenses/**",
    auth: "session",
    csrf: "change",
    sweep: true,
    handler: (c, m, s) =>
      handleLicenses(
        c.req,
        c.env,
        c.db,
        s.session,
        [...m.rest],
        c.now,
        c.hooksFor,
      ),
  },
  {
    path: "claim/license-key/**",
    auth: "session",
    csrf: "change",
    sweep: true,
    handler: (c, _m, s) =>
      handleClaimKey(
        c.req,
        c.env,
        c.db,
        s.session,
        c.now,
        c.hooksFor,
        c.settings,
      ),
  },
  {
    path: "activate/preview",
    auth: "session",
    csrf: "change",
    sweep: true,
    handler: (c, _m, s) =>
      handleActivatePreview(
        c.req,
        c.env,
        c.db,
        s.session,
        c.now,
        c.hooksFor,
        c.settings,
      ),
  },
  {
    path: "releases/**",
    auth: "session",
    csrf: "change",
    sweep: true,
    handler: (c, m, s) =>
      handleReleases(
        c.req,
        c.env,
        c.db,
        s.session,
        [...m.rest],
        c.now,
        c.hooksFor,
      ),
  },
  // PX-W1: the library and the product page (`library.ts`). Reads only.
  {
    path: "library",
    auth: "session",
    csrf: "change",
    sweep: true,
    handler: async (c, _m, s) => {
      if (c.req.method !== "GET") return err(405, "method_not_allowed");
      const view = await libraryView(
        c.env,
        c.db,
        s.session.accountId,
        c.now,
        c.hooksFor,
      );
      return portalJson({
        ...view,
        // PX-W10: the Discover count in the nav (§4.16); the offers themselves are
        // `GET /api/discover`. Never a product this same answer lists in the library.
        discoverCount: await discoverCount(
          c.env,
          c.db,
          s.session.accountId,
          c.now,
          new Set(view.products.map((p) => String(p.product))),
          c.hooksFor,
        ),
      });
    },
  },
  // PS-04: remove a library ENTRY (an open product added from the storefront); never a licence.
  {
    path: "library/:product",
    auth: "session",
    csrf: "change",
    sweep: true,
    handler: (c, m, s) =>
      handleLibraryEntryRemove(
        c.req,
        c.db,
        s.session.accountId,
        m.params.product!,
        c.now,
      ),
  },
  // PX-W10 (G24, G25), PS-04: Discover's offers, the storefront product page and "Add to
  // library" (`discover.ts`).
  {
    path: "discover",
    auth: "session",
    csrf: "change",
    sweep: true,
    handler: (c, _m, s) =>
      handleDiscover(c.req, c.env, c.db, s.session, c.now, c.hooksFor),
  },
  {
    path: "discover/:product",
    auth: "session",
    csrf: "change",
    sweep: true,
    handler: (c, m, s) =>
      handleStorefrontPage(
        c.req,
        c.env,
        c.db,
        s.session,
        m.params.product!,
        c.now,
        c.hooksFor,
      ),
  },
  {
    path: "discover/:product/claim",
    auth: "session",
    csrf: "change",
    sweep: true,
    handler: (c, m, s) =>
      handleDiscoverClaim(
        c.req,
        c.env,
        c.db,
        s.session,
        m.params.product!,
        c.now,
        c.hooksFor,
      ),
  },
  {
    path: "products/:product",
    auth: "session",
    csrf: "change",
    sweep: true,
    handler: async (c, m, s) => {
      if (c.req.method !== "GET") return err(405, "method_not_allowed");
      const view = await productView(
        c.env,
        c.db,
        s.session.accountId,
        m.params.product!,
        c.now,
        c.hooksFor,
      );
      return view ? portalJson(view) : notFound();
    },
  },
  // PX-W2 (G2, G4): one product's downloads and store links, per platform (`downloads.ts`).
  {
    path: "products/:product/downloads",
    auth: "session",
    csrf: "change",
    sweep: true,
    handler: (c, m, s) =>
      handleProductDownloads(
        c.req,
        c.env,
        c.db,
        s.session,
        m.params.product!,
        c.now,
        c.hooksFor,
      ),
  },
  {
    path: "products/:product/email-download",
    auth: "session",
    csrf: "change",
    sweep: true,
    handler: (c, m, s) =>
      handleEmailDownload(
        c.req,
        c.env,
        c.db,
        s.session,
        m.params.product!,
        c.now,
      ),
  },
  // I-11 (S-16 §5.5): this product's export, and "Remove my data from <Product>"
  // (`dataRoutes.ts`).
  {
    path: "products/:product/export",
    auth: "session",
    csrf: "always",
    sweep: true,
    handler: (c, m, s) =>
      handleProductExport(
        c.req,
        c.env,
        c.db,
        s.session,
        m.params.product!,
        c.now,
        c.hooksFor,
      ),
  },
  {
    path: "products/:product/data",
    auth: "session",
    csrf: "change",
    sweep: true,
    handler: (c, m, s) =>
      handleProductDataRemove(
        c.req,
        c.env,
        c.db,
        s.session,
        m.params.product!,
        c.now,
      ),
  },
  // I-11 (S-16 §5.2): "Get a support code" on the product page (`supportCode.ts`).
  {
    path: "products/:product/support-code",
    auth: "session",
    csrf: "change",
    sweep: true,
    handler: (c, m, s) =>
      handleProductSupportCode(
        c.req,
        c.env,
        c.db,
        s.session,
        m.params.product!,
        c.now,
      ),
  },
  // Every other path: the session and the CSRF check still come first (a signed-out caller is
  // told 401 whatever it asked for), then the not-found.
  {
    path: "**",
    auth: "session",
    csrf: "change",
    sweep: true,
    handler: async () => notFound(),
  },
];

async function dispatchPortalApi(
  req: Request,
  env: Env,
  db: Db,
  path: string,
  now: number,
  /** One product's descriptor hooks (`dispatch.ts`); without them no download is offered. */
  hooksFor?: PortalHooksFor,
  /** The settings registry (ST-04): what the app-consent view resolves product settings from. */
  settings?: SettingsRegistry,
): Promise<Response> {
  let p = path.startsWith("/api") ? path.slice(4) : path;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  // The composition root hands over `url.pathname`, which is still percent-encoded, while the
  // SPA encodes every segment it sends (`encodeURIComponent`). Ids are compared to stored values
  // byte for byte, so each segment is decoded once here, after the split (an encoded `/` stays
  // inside its segment). Without this an artifact id like `file:App-1.0.dmg` arrived as
  // `file%3AApp-1.0.dmg` and the token mint 404'd a file the downloads listing had offered.
  const segments = decodeSegments(p);
  if (segments === null) return notFound();
  // The `**` row takes every path no other row does, so there is always a best row.
  const best = bestRow(PORTAL_API_ROUTES, segments, (row) =>
    row.accept ? row.accept(segments) : true,
  )!;
  const { row, matched } = best;
  const ctx: PortalApiCtx = { req, env, db, now, hooksFor, settings };
  if (row.auth === "none") return row.handler(ctx, matched);

  const proven = await requireSession(req, env, db, now);
  if (proven instanceof Response) return proven;
  const { session, sessionIdHash } = proven;
  if (row.csrf === "always" || isMutation(req.method)) {
    const presented = req.headers.get(PORTAL_CSRF_HEADER);
    if (!presented || !constantTimeEqual(presented, session.csrf))
      return forbidden("csrf");
  }
  const sweep =
    typeof row.sweep === "boolean"
      ? row.sweep
      : req.method !== row.sweep.except;
  if (sweep)
    await syncLicenseLinksAndNotify(
      env,
      db,
      session.accountId,
      now,
      noticeOrigin(env, req),
    );
  return row.handler(ctx, matched, { session, sessionIdHash });
}

/**
 * HA-09F: a browser navigation whose redemption was refused lands back in Polaris Locker, on the
 * product's page (`?p=<slug>`, which the Locker adds when it follows the link; the Library without it), where the
 * "download didn't start" message shows with Download again. Never raw JSON in a person's
 * window. API callers (no `text/html` in `Accept`) keep the plain 404.
 */
function redemptionRefusedPage(req: Request): Response {
  const slug = new URL(req.url).searchParams.get("p") ?? "";
  const page = PRODUCT_SLUG_RE.test(slug)
    ? `p/${encodeURIComponent(slug)}`
    : "";
  return new Response(null, {
    status: 303,
    headers: portalSecurityHeaders(
      new Headers({
        location: `/#/${page}?download=failed`,
        "cache-control": "no-store",
      }),
    ),
  });
}

export async function handlePortalDownload(
  req: Request,
  env: Env,
  db: Db,
  token: string,
  now: number,
  /** One product's descriptor hooks (`dispatch.ts`); without them nothing is redeemed. */
  hooksFor?: PortalHooksFor,
): Promise<Response> {
  const res = await redeemPortalDownload(req, env, db, token, now, hooksFor);
  return res.status === 404 && isBrowserNavigation(req)
    ? redemptionRefusedPage(req)
    : res;
}

async function redeemPortalDownload(
  req: Request,
  env: Env,
  db: Db,
  token: string,
  now: number,
  /** One product's descriptor hooks (`dispatch.ts`); without them nothing is redeemed. */
  hooksFor?: PortalHooksFor,
): Promise<Response> {
  if (req.method !== "GET") return err(405, "method_not_allowed");
  // No retention work here. This route has no session, no rate limit and a path anyone can
  // type, so a delete issued before the presented token is even looked up would be a
  // stranger-triggered write across every tenant's expired rows. Retention is the nightly
  // sweep's job (`purgeDownloadTokens`, per product); this route only
  // reads.
  // Expiry and single-use are now SQL predicates (R9-05b), so an unusable token never returns.
  const row = await readDownloadToken(env, db, token, now);
  if (!row) return notFound();
  const gate = await deliveryGate(db, hooksFor, row.product, now);
  const found =
    gate && row.artifact_id
      ? await servedFileOf(gate, row.release_id, row.artifact_id)
      : null;
  const artifact = found?.file ?? null;
  const facts = found?.facts ?? null;
  const mode =
    gate && facts ? await gate.delivery.accessMode(facts.deliverable_id) : null;
  // R6-12: the ONLY value that may become a `Location` header. `null` here means the stored URL
  // is absent, unparseable, not https, not a GitHub storage host or in a private repository —
  // and that Distribution has no bytes-host URL for it either: for a public deliverable, or
  // (PX-W3) a ticketable one for a non-public deliverable (`downloadTarget`) — all of which are
  // refusals, never redirects.
  const target =
    artifact && gate && mode
      ? await downloadTarget(env, artifact, gate, mode)
      : null;
  if (!artifact || !facts || !gate || !mode || target === null)
    return notFound();
  const settings = await getPortalProductSettings(db, row.product);
  if (settings.portal_enabled !== 1) {
    return notFound();
  }
  const scope = parseJsonOr<{ portalAccountId?: string }>(row.scope_json, {});
  if (!scope.portalAccountId) return notFound();
  // I-11: a token minted for an account the erasure ledger holds is dead whatever D1 says (a
  // restore brings the account back as `active`). Asked before `getPortalAccount` and again for
  // the survivor of a merge; an unreadable ledger answers 503 and spends nothing.
  const named = await erasureVerdict(env, now, scope.portalAccountId);
  if (named === "unavailable")
    return err(503, "erasure_ledger_unavailable", "try again");
  if (named === "erased") return notFound();
  const account = await getPortalAccount(db, scope.portalAccountId, now);
  if (!account || account.status !== "active") return notFound();
  if (account.id !== scope.portalAccountId) {
    const survivor = await erasureVerdict(env, now, account.id);
    if (survivor === "unavailable")
      return err(503, "erasure_ledger_unavailable", "try again");
    if (survivor === "erased") return notFound();
  }
  if (!(await hasLinkedProductLicense(db, account.id, row.product))) {
    return notFound();
  }
  if (!(await accountMayDownload(db, account.id, gate, mode, facts, now))) {
    return notFound();
  }
  // PX-W3: a licensed file held on R2 goes to its canonical bytes-host URL with a download
  // ticket, minted only now that every check above has passed (plans/PX-W3.md §6.2). Minted
  // BEFORE the token is spent, so a failure leaves the user's click usable once the cause is
  // fixed. The ticket carries no account id; it binds this one file by content.
  let location: string;
  if (target.kind === "redirect") location = target.url;
  else {
    const ticket = artifact.sha256
      ? await mintDownloadTicket(
          env,
          {
            product: row.product,
            releaseId: artifact.releaseId,
            name: artifact.name,
            sha256: artifact.sha256,
          },
          now,
        )
      : null;
    if (ticket === null) return notFound();
    const url = new URL(target.base);
    url.searchParams.set(DOWNLOAD_TICKET_PARAM, ticket);
    location = url.toString();
  }
  // R9-05b: the conditional UPDATE IS the single-use gate. A concurrent redemption of the same
  // token loses here (changes === 0) and gets a 404 instead of a second redirect.
  if (!(await spendDownloadToken(db, row.product, row.token_hash, now))) {
    return notFound();
  }
  return new Response(null, {
    status: 302,
    headers: portalSecurityHeaders(
      new Headers({
        location,
        "cache-control": "no-store",
      }),
    ),
  });
}
