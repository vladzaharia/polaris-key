import { RELEASE_PLATFORMS, platformFromFileName } from "@polaris-key/manifest";
import { CHANNEL_STABLE } from "@polaris-key/protocol";
import type { ReleaseAccess } from "@polaris-key/protocol/release";
import {
  isAllowedDownloadRedirectHost,
  isAllowedStorageHost,
  type Db,
  type Env,
} from "../../../core/platform.js";
import type { Delivery, ServiceHooks } from "../../../core/hooks.js";
import {
  loadProductPublic,
  type ProductPublic,
} from "../../../core/products.js";
import { licenseEntitled } from "../../../core/entitledAccess.js";
import { isBytesHost } from "../../../core/bytesHostname.js";
import {
  DOWNLOAD_TICKET_PARAM,
  downloadTicketsEnabled,
  mintDownloadTicket,
} from "../../../core/downloadTicket.js";
import { ErrorCode } from "../../../core/errors.js";
import { getProduct } from "../../../core/data.js";
import { licenseUsable } from "../../../core/devices.js";
import { rateLimitOk } from "../../../core/rateLimit.js";
import { registryOrigin } from "../../../core/registryHostname.js";
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
} from "../../../core/registryTokens.js";
import { PACKAGE_ECOSYSTEMS } from "@polaris-key/manifest";
import {
  getPortalAccount,
  getPortalArtifact,
  getPortalDownloadToken,
  getPortalLicense,
  getPortalProductSettings,
  getPortalReleaseFacts,
  listLinkedProducts,
  listPortalArtifacts,
  listPortalLicenses,
  listPortalReleases,
  listVisibleDevices,
  listVisibleKeys,
  markPortalDownloadUsed,
  portalAuthCapabilities,
  portalAudit,
  purgeExpiredDownloadTokens,
  releaseServiceEnabled,
  syncAccountLicenseLinks,
  createPortalDownloadToken,
  deletePortalAccount,
  type PortalArtifactRow,
  type PortalLicenseRow,
  type PortalReleaseRow,
} from "./repo.js";
import {
  PORTAL_CSRF_HEADER,
  buildPortalClearCookie,
  portalSessionAuthenticatedAt,
  portalSessionFromRequest,
  type PortalSession,
} from "./session.js";
import { handleMagicStart } from "./auth.js";
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
} from "../../../core/accountCookies.js";
import { handleAccountMethods } from "./methods.js";
import { handleAccountLink } from "./link.js";
import { clearDeviceSubjects } from "../../../core/subjectHooks.js";
import {
  handleLibraryEntryRemove,
  libraryView,
  productView,
} from "./library.js";
import { signInConsentView, signInRequestView } from "../passthrough/routes.js";
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
import {
  portalEmailConfigured,
  sendNotice,
  sendSecurityNotice,
} from "./email.js";
import { accountDeletedNotice, downloadLinkEmail } from "./notices.js";
import { platformOidcConfig } from "../../../core/platform.js";
import { platformSignInEnded } from "../accounts/platformMigration.js";
import { portalSecurityHeaders } from "./headers.js";
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
import { handleProfileApi } from "./profile.js";

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

export async function readBody(req: Request): Promise<Record<string, unknown>> {
  const raw = await req.text();
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function licenseBase(row: PortalLicenseRow): Record<string, unknown> {
  return {
    id: row.id,
    product: row.product,
    productName: row.product_name,
    productBranding: parseJson(row.product_branding_json, null),
    name: row.name ?? "",
    email: row.email ?? "",
    status: row.status,
    tier: row.tier_id,
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
    ...licenseBase(row),
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
    // PX-23: Remove from my library is offered only for a licence its key can bring back.
    removable:
      notRemovableReason(
        activeKeyCount,
        settings.license_key_claim_enabled === 1,
      ) === null,
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
  // resolved id.
  const live = await checkAccountSession(env, db, session, now);
  if (!live) return unauthorized();
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
// the portal read a per-artifact snapshot of `release_config.artifacts_access` taken at sync
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
  product: ProductPublic;
  delivery: Delivery;
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
  if (!hooksFor) return null;
  const loaded = await loadProductPublic(db, product);
  if (!loaded) return null;
  const hooks = hooksFor(loaded, now);
  const delivery = hooks.delivery();
  if (!delivery) return null;
  let visibility: Promise<boolean> | undefined;
  const repositoryPublic = (): Promise<boolean> =>
    (visibility ??= (async () => {
      const catalog = hooks.releaseCatalog();
      return catalog ? catalog.repositoryPublic() : false;
    })());
  return { product: loaded, delivery, repositoryPublic };
}

export type ReleaseFacts = Pick<
  PortalReleaseRow,
  "deliverable_id" | "version" | "channel"
>;

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
 * Where a download goes (R6-12, PX-W3). One of:
 *
 *   - `{kind: "redirect", url}`, tried in this order:
 *       1. For a PUBLIC deliverable, Distribution's bytes-host URL for the file
 *          (`delivery.deliveryUrl`), accepted only when it is `https` on the configured bytes
 *          host. Distribution serves every location from there (R2, and GitHub through
 *          Release's installation token, so a PRIVATE repository's asset downloads too), which
 *          is why it comes first: a GitHub URL alone only works for a public repository.
 *       2. Otherwise the artifact's own GitHub storage URL, but only when the repository is
 *          PUBLIC (`gate.repositoryPublic`). A private repository answers a browser's anonymous
 *          request with GitHub's 404.
 *   - `{kind: "ticket", base}`: a NON-public deliverable that no redirect above can serve, whose
 *     file Distribution serves on the bytes host, with a recorded SHA-256, on a deployment with
 *     download tickets configured (`DOWNLOAD_TICKET_KEY` and `BLOB_ORIGIN`). That covers files
 *     held on R2 and, because the bytes host streams a private repository's assets through the
 *     installation token, licensed files in a PRIVATE GitHub repository too (plans/PX-W3.md Q7,
 *     reopened at the merge with main's bytes-host-first order; the brief records it). `base`
 *     is the file's canonical bytes-host URL; only `handlePortalDownload` appends a ticket to it,
 *     after every check (plans/PX-W3.md §6.2). Device trust does not apply to a portal download
 *     (the licence-only rule `entitledAccess.ts` names; Q4 (a)), so a product whose trust policy
 *     enforces `gatedDelivery: attested` is served here exactly like the GitHub branch serves it.
 *   - `null`: nothing here can hand the bytes to a browser. A non-public deliverable is never
 *     REDIRECTED to the bytes host (the browser holds no device token), so without tickets
 *     configured, or without a SHA-256, it stays `null`.
 *
 * The listing and the token mint only test for non-null, so they offer exactly what redemption
 * serves.
 */
export type DownloadTarget =
  | { kind: "redirect"; url: string }
  | { kind: "ticket"; base: string };

export async function downloadTarget(
  env: Env,
  artifact: PortalArtifactRow,
  gate: DeliveryGate,
  mode: ReleaseAccess,
): Promise<DownloadTarget | null> {
  if (mode === "public") {
    const hosted = await bytesHostTarget(env, artifact, gate);
    if (hosted !== null) return { kind: "redirect", url: hosted.toString() };
  }
  const source = redirectableSourceUrl(artifact);
  if (source !== null && (await gate.repositoryPublic()))
    return { kind: "redirect", url: source };
  if (mode === "public") return null;
  if (!artifact.sha256 || !downloadTicketsEnabled(env)) return null;
  const hosted = await bytesHostTarget(env, artifact, gate);
  // A ticket is honoured on the bytes host alone (origin isolation, THREAT-MODEL §3), so the
  // URL must sit on it and carry no query of its own for the ticket to join.
  return hosted !== null && isBytesHost(hosted, env) && hosted.search === ""
    ? { kind: "ticket", base: hosted.toString() }
    : null;
}

/** Distribution's bytes-host URL for a file, when it is `https` on the configured bytes host. */
async function bytesHostTarget(
  env: Env,
  artifact: PortalArtifactRow,
  gate: DeliveryGate,
): Promise<URL | null> {
  const minted = await gate.delivery.deliveryUrl({
    releaseId: artifact.release_id,
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
function redirectableSourceUrl(artifact: PortalArtifactRow): string | null {
  if (!artifact.source_url) return null;
  let url: URL;
  try {
    url = new URL(artifact.source_url);
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

async function handleMe(
  db: Db,
  session: PortalSession,
  now: number,
): Promise<Response> {
  const account = await getPortalAccount(db, session.accountId);
  if (!account) return unauthorized();
  await syncAccountLicenseLinks(db, session.accountId, now);
  return portalJson({
    account: {
      id: account.id,
      name: account.display_name ?? session.name,
      email: account.primary_email ?? session.email,
      // I-07, PX-W16: the picture in use, re-encoded and served same-origin (256 px; `-96` for
      // the small one); null shows initials. `GET /api/me/profile` has the rest.
      avatarUrl: avatarUrl(account.avatar_key ?? null),
    },
    csrf: session.csrf,
  });
}

/**
 * `DELETE /api/me` — the account holder erases their own portal account.
 *
 * R11-09: there was no delete endpoint of any kind, so `portal_accounts.primary_email` and
 * `portal_account_emails.email` were unerasable through the API — right-to-erasure existed only
 * as an operator with D1 shell access. The awkward part is structural and is called out in the
 * finding: `portal_account_emails.email` is the row's PRIMARY KEY, so there is no way to record
 * "this address was erased" that does not re-store the address. `deletePortalAccount` therefore
 * deletes the row outright, which is the honest reading of erasure rather than a compromise.
 *
 * Three gates, all already in place upstream, all load-bearing here:
 *
 * - AUTHENTICATED. `handlePortalApi` resolves the session before dispatch and this handler only
 *   ever erases `session.accountId` — there is no id in the path or the body, so there is no
 *   parameter to tamper with and no way to aim it at somebody else's account.
 * - CSRF. `DELETE` is a mutation, so the `X-PKey-Portal-CSRF` check in `handlePortalApi` runs
 *   before this is reached. Without it a cross-site `fetch` with `SameSite=Lax`... would in fact
 *   be blocked by the cookie — but Lax is a defence against a class of navigation, not a
 *   substitute for a token, and account deletion is the one action with no undo.
 * - RATE LIMITED. Charged against this account's own budget, which for a destructive
 *   self-service action is about bounding retries and accidental double-submits.
 *
 * The notice email is sent BEFORE the delete, because afterwards there is no address to send it
 * to — the address is exactly what was erased. The session cookie is cleared on the way out; the
 * signed cookie would in any case stop validating on the next request, since `requireSession`
 * re-reads `portal_accounts` and the row is gone.
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
  const limited = await requireActionRateLimit(
    req,
    env,
    session,
    "portalAccountDelete",
    now,
    5,
  );
  if (limited) return limited;
  // Every verified address hears about it, like any security change (PORTAL.md §6.3): the
  // recipients are read here, while the rows that name them still exist.
  await sendSecurityNotice(
    env,
    db,
    session.accountId,
    account.primary_email ?? session.email,
    accountDeletedNotice({ origin: new URL(req.url).origin }),
    now,
  );
  await deletePortalAccount(
    db,
    session.accountId,
    now,
    env,
    new URL(req.url).origin,
  );
  return portalJson({ ok: true, deleted: session.accountId }, 200, {
    "set-cookie": buildPortalClearCookie(),
  });
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
  return portalJson({
    auth: {
      // I-17: past the platform IdP's sunset the card stops offering single sign-on.
      oidc:
        caps.portalEnabled &&
        caps.oidcEnabled &&
        Boolean(platformOidcConfig(env)) &&
        !platformSignInEnded(env, now),
      magic:
        caps.portalEnabled && caps.magicEnabled && portalEmailConfigured(env),
      // I-16: passkeys are an account sign-in method, platform-level (no product toggle).
      passkey: caps.portalEnabled,
    },
    // I-07: the login card renders Cloudflare Turnstile on the email start with this public
    // site key; null when the deploy has Turnstile off (no token is asked for).
    turnstileSiteKey: turnstileSiteKey(env),
    modules: {
      licensing: caps.portalEnabled,
      claim: caps.portalEnabled && caps.licenseKeyClaimEnabled,
      releases: caps.portalEnabled && caps.releasesEnabled,
    },
  });
}

async function handleLicenses(
  db: Db,
  session: PortalSession,
  rest: string[],
  now: number,
  hooksFor: PortalHooksFor | undefined,
): Promise<Response> {
  await syncAccountLicenseLinks(db, session.accountId, now);
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
    });
  }
  return out;
}

/**
 * Package access (F-21, plans/F-20.md §6.5, PORTAL.md's "Package access" card): a licensee's own
 * registry tokens for one linked licence.
 *
 *   GET    /portal/api/licenses/:product/:licenseId/registry-tokens           the card's state:
 *          `available` (an enabled non-public feed exists), those feeds with their base URLs,
 *          the tokens this account minted for this licence, the username and the limits
 *   POST   …/registry-tokens  {label, ecosystem?, presentation?, expiresInDays?}   mint a
 *          licence-bound read token; the plaintext is in this answer only
 *   DELETE …/registry-tokens/:tokenId                                         revoke one
 *
 * Minting needs the session, the CSRF header (checked for every mutation by the router), a
 * usable linked licence and an available feed; it spends `portalRegistryToken` (per account,
 * fail closed). Audited `portal.registry_token.create` and `.revoke`.
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
  if (feeds.length === 0)
    return err(
      409,
      ErrorCode.BadRequest,
      "this product has no private package feed",
    );
  const body = await readBody(req);
  const presentation = body.presentation === "url" ? "url" : "header";
  const ecosystem =
    body.ecosystem === undefined || body.ecosystem === null
      ? null
      : body.ecosystem;
  const offered = feeds.map((f) => f.ecosystem);
  if (
    (ecosystem !== null &&
      (typeof ecosystem !== "string" || !offered.includes(ecosystem))) ||
    (presentation === "url" && !offered.includes("godot"))
  )
    return err(
      422,
      ErrorCode.BadRequest,
      "choose one of the product's private feeds",
    );
  const res = await mintRegistryToken(
    env,
    db,
    {
      product,
      label: typeof body.label === "string" ? body.label : "",
      ecosystems: ecosystem === null ? null : [ecosystem as string],
      ...(typeof body.expiresInDays === "number"
        ? { expiresInDays: body.expiresInDays }
        : {}),
      binding: "license",
      licenseId,
      presentation,
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
    summary: `Created registry token “${res.view.label}” (…${res.view.hint}) for licence ${licenseId}`,
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
        settings.releases_enabled === 1 &&
        releaseServiceEnabled(row.services_json)
      ) {
        enabledProducts.push(row.slug);
      }
    }
    const releases = await listPortalReleases(db, enabledProducts);
    const gates = new Map<string, DeliveryGate | null>();
    const out = [];
    for (const release of releases) {
      let gate = gates.get(release.product);
      if (gate === undefined) {
        gate = await deliveryGate(db, hooksFor, release.product, now);
        gates.set(release.product, gate);
      }
      // Distribution off: nothing is downloadable, and the listing says so.
      const mode: ReleaseAccess | null = gate
        ? await gate.delivery.accessMode(release.deliverable_id)
        : null;
      const allowed =
        gate !== null &&
        mode !== null &&
        (await accountMayDownload(
          db,
          session.accountId,
          gate,
          mode,
          release,
          now,
        ));
      const artifacts = await listPortalArtifacts(
        db,
        release.product,
        release.release_id,
      );
      const rows = [];
      for (const artifact of artifacts) {
        rows.push({
          artifactId: artifact.artifact_id,
          name: artifact.name,
          kind: artifact.kind,
          // Read-time inference, display only: a file with no platform of its own takes its
          // build's, and a file tied to no build the one its name declares.
          platform:
            artifact.platform ??
            (artifact.build_id
              ? (artifact.build_platform ?? null)
              : platformFromFileName(artifact.name)),
          arch: artifact.arch,
          sizeBytes: artifact.size_bytes,
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
            (await downloadTarget(env, artifact, gate, mode)) !== null,
        });
      }
      out.push({
        product: release.product,
        productName: release.product_name,
        releaseId: release.release_id,
        version: release.version,
        title: release.title,
        notes: release.notes,
        publishedAt: release.published_at,
        sourceUrl: release.source_url,
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
    settings.releases_enabled !== 1 ||
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
  const artifact = await getPortalArtifact(db, product, releaseId, artifactId);
  const facts = artifact
    ? await getPortalReleaseFacts(db, product, releaseId)
    : null;
  if (!artifact || !facts)
    return err(
      404,
      MINT_REFUSAL.fileNotFound,
      "this release or file is no longer offered",
    );
  // Byte delivery is Distribution's: with it off (or no hooks to ask), nothing is minted.
  const gate = await deliveryGate(db, hooksFor, product, now);
  const mode = gate
    ? await gate.delivery.accessMode(facts.deliverable_id)
    : null;
  if (!gate || !mode)
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
  const token = await createPortalDownloadToken(env, db, {
    accountId: session.accountId,
    product,
    releaseId,
    artifactId,
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
    settings.releases_enabled !== 1 ||
    !releaseServiceEnabled(productRow.services_json)
  ) {
    return notFound();
  }
  if (!(await hasLinkedProductLicense(db, session.accountId, product))) {
    return notFound();
  }
  if (!portalEmailConfigured(env)) {
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
  req: Request,
  env: Env,
  db: Db,
  path: string,
  now: number,
  /** One product's descriptor hooks (`dispatch.ts`); without them no download is offered. */
  hooksFor?: PortalHooksFor,
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
  if (segments[0] === "capabilities") {
    const requested = new URL(req.url).searchParams.get("product");
    return handleCapabilities(env, db, requested, now);
  }
  if (segments[0] === "magic" && segments[1] === "start") {
    return handleMagicStart(req, env, db, now);
  }
  // PX-W13 (WIRE-CONTRACT-V4 §12.7.2): the sign-in request the card renders. The binder cookie,
  // not a session: the card shows it before anyone signs in (`passthrough/routes.ts`).
  if (
    segments[0] === "signin" &&
    segments[1] === "requests" &&
    segments[2] &&
    segments.length === 3
  ) {
    if (req.method !== "GET") return err(405, "method_not_allowed");
    const view = await signInRequestView(
      env,
      db,
      req,
      segments[2],
      now,
      hooksFor,
    );
    return view.status === 200 ? portalJson(view.body) : notFound();
  }
  // I-07: the login card's pre-authentication routes (email code and link, the email gate).
  // `signin/requests/*` is PX-W13's: the request view above, and its app-consent view below,
  // which needs the session.
  if (segments[0] === "signin" && segments[1] !== "requests") {
    return handleCardApi(req, env, db, segments, now);
  }
  // PX-W9 (WIRE-CONTRACT-V4 §12.2 rule 8): the login card's signed-out key preview. Read-only and
  // never counted; it charges its own per-network bucket (`selfService.ts`).
  if (
    segments[0] === "key" &&
    segments[1] === "preview" &&
    segments.length === 2
  )
    return handleKeyPreview(req, env, db, now);
  // PX-W14 (G29): the new device's half of "Sign in with another device" is pre-auth: it has no
  // session yet. The signed-in half (`lookup`, `approve`) is dispatched below.
  if (segments[0] === "device-login" && segments.length === 2) {
    if (segments[1] === "start")
      return handleDeviceLoginStart(req, env, db, now);
    if (segments[1] !== "lookup" && segments[1] !== "approve")
      return handleDeviceLoginPoll(req, env, db, segments[1]!, now);
  }

  const sessionResult = await requireSession(req, env, db, now);
  if (sessionResult instanceof Response) return sessionResult;
  const { session, sessionIdHash } = sessionResult;
  if (isMutation(req.method)) {
    const presented = req.headers.get(PORTAL_CSRF_HEADER);
    if (!presented || presented !== session.csrf) return forbidden("csrf");
  }
  // Erasure is dispatched BEFORE the per-request link sweep: re-deriving license links for an
  // account that is about to be deleted is pure waste, and it is the one request where a
  // failure in that sweep must not be able to block the account holder from deleting.
  if (
    segments.length === 1 &&
    segments[0] === "me" &&
    req.method === "DELETE"
  ) {
    return handleMeDelete(req, env, db, session, now);
  }
  // PX-W14: the approver's half. Rate-limited per ACCOUNT alone (not account and client IP, as
  // `requireActionRateLimit` keys it) before any code is looked up, so the budget is the bound on
  // guessing someone else's code however many addresses the guesser rotates through.
  if (
    segments[0] === "device-login" &&
    (segments[1] === "lookup" || segments[1] === "approve") &&
    segments.length === 2
  ) {
    if (req.method !== "POST") return err(405, "method_not_allowed");
    const allowed = await rateLimitOk(
      env,
      "_portal",
      {
        bucket: "portalDeviceApprove",
        id: session.accountId,
        limit: DEVICE_LOGIN_APPROVE_LIMIT,
        windowSec: 60,
      },
      now,
    );
    if (!allowed) return err(429, "rate_limited", "too many attempts");
    const body = await readBody(req);
    return segments[1] === "lookup"
      ? handleDeviceLoginLookup(req, env, session, body, now)
      : handleDeviceLoginApprove(req, env, db, session, body, now);
  }
  // I-16: the account's passkeys (list, add, remove), before the licence-link sweep they never
  // read. Adding and removing check step-up and the email rule themselves.
  if (segments[0] === "me" && segments[1] === "passkeys") {
    return handleAccountPasskeys(
      req,
      env,
      db,
      {
        accountId: session.accountId,
        authenticatedAt: portalSessionAuthenticatedAt(session),
        sessionIdHash,
      },
      segments.slice(2),
      now,
    );
  }
  // PX-W12 (G27): sign-in methods (list, connect, disconnect) and Link an existing account (join,
  // undo). Each change checks step-up, the never-orphan guard and its own rate limit.
  if (
    segments[0] === "me" &&
    (segments[1] === "methods" || segments[1] === "link")
  ) {
    const caller = {
      accountId: session.accountId,
      authenticatedAt: portalSessionAuthenticatedAt(session),
      sessionIdHash,
    };
    return segments[1] === "methods"
      ? handleAccountMethods(req, env, db, caller, segments.slice(2), now)
      : handleAccountLink(req, env, db, caller, segments.slice(2), now);
  }
  await syncAccountLicenseLinks(db, session.accountId, now);

  const [head, ...rest] = segments;
  // PX-W16 (G32, G33): Account → Profile, and picture uploads (`profile.ts`).
  if (head === "me" && rest[0] === "profile")
    return handleProfileApi(req, env, db, session, rest, now);
  if (head === "me") return handleMe(db, session, now);
  if (head === "sessions") {
    return handleSessions(req, env, db, session, sessionIdHash, rest, now);
  }
  // PX-W13 (§12.7.3): app consent for a sign-in request, for the signed-in account.
  if (
    head === "signin" &&
    rest[0] === "requests" &&
    rest[1] &&
    rest[2] === "consent" &&
    rest.length === 3
  ) {
    if (req.method !== "GET") return err(405, "method_not_allowed");
    const view = await signInConsentView(
      env,
      db,
      req,
      rest[1],
      session.accountId,
      now,
    );
    return view.status === 200 ? portalJson(view.body) : notFound();
  }
  if (
    head === "licenses" &&
    rest[2] === "devices" &&
    rest[0] &&
    rest[1] &&
    rest[3] &&
    rest.length === 4 &&
    req.method === "PATCH"
  ) {
    return handleDeviceRename(
      req,
      env,
      db,
      session,
      rest[0],
      rest[1],
      rest[3],
      now,
    );
  }
  if (
    head === "licenses" &&
    rest[2] === "keys" &&
    rest[0] &&
    rest[1] &&
    rest.length === 3
  ) {
    return handleKeyReissue(req, env, db, session, rest[0], rest[1], now);
  }
  if (
    head === "licenses" &&
    rest[2] === "devices" &&
    rest[0] &&
    rest[1] &&
    rest[3]
  ) {
    return handleDeviceDelete(
      req,
      env,
      db,
      session,
      rest[0],
      rest[1],
      rest[3],
      now,
    );
  }
  if (
    head === "licenses" &&
    rest[2] === "registry-tokens" &&
    rest[0] &&
    rest[1] &&
    rest.length <= 4
  )
    return handleRegistryTokens(
      req,
      env,
      db,
      session,
      rest[0],
      rest[1],
      rest[3],
      now,
      hooksFor,
    );
  // PX-23 (S-24 D19): Remove from my library. The licence leaves the account and stays out.
  if (
    head === "licenses" &&
    rest[0] &&
    rest[1] &&
    rest.length === 2 &&
    req.method === "DELETE"
  ) {
    return handleLicenseRemove(req, env, db, session, rest[0], rest[1], now);
  }
  if (head === "licenses")
    return handleLicenses(db, session, rest, now, hooksFor);
  if (head === "claim" && rest[0] === "license-key") {
    return handleClaimKey(req, env, db, session, now, hooksFor);
  }
  if (head === "activate" && rest[0] === "preview" && rest.length === 1) {
    return handleActivatePreview(req, env, db, session, now, hooksFor);
  }
  if (head === "releases")
    return handleReleases(req, env, db, session, rest, now, hooksFor);
  // PX-W1: the library and the product page (`library.ts`). Reads only.
  if (head === "library" && rest.length === 0) {
    if (req.method !== "GET") return err(405, "method_not_allowed");
    const view = await libraryView(env, db, session.accountId, now, hooksFor);
    return portalJson({
      ...view,
      // PX-W10: the Discover count in the nav (§4.16); the offers themselves are `GET /api/discover`.
      // Never a product this same answer lists in the library.
      discoverCount: await discoverCount(
        env,
        db,
        session.accountId,
        now,
        new Set(view.products.map((p) => String(p.product))),
        hooksFor,
      ),
    });
  }
  // PS-04: remove a library ENTRY (an open product added from the storefront); never a licence.
  if (head === "library" && rest.length === 1 && rest[0]) {
    return handleLibraryEntryRemove(req, db, session.accountId, rest[0], now);
  }
  // PX-W10 (G24, G25), PS-04: Discover's offers, the storefront product page and "Add to
  // library" (`discover.ts`).
  if (head === "discover" && rest.length === 0) {
    return handleDiscover(req, env, db, session, now, hooksFor);
  }
  if (head === "discover" && rest.length === 1 && rest[0]) {
    return handleStorefrontPage(req, env, db, session, rest[0], now, hooksFor);
  }
  if (
    head === "discover" &&
    rest.length === 2 &&
    rest[0] &&
    rest[1] === "claim"
  ) {
    return handleDiscoverClaim(req, env, db, session, rest[0], now, hooksFor);
  }
  if (head === "products" && rest.length === 1 && rest[0]) {
    if (req.method !== "GET") return err(405, "method_not_allowed");
    const view = await productView(
      env,
      db,
      session.accountId,
      rest[0],
      now,
      hooksFor,
    );
    return view ? portalJson(view) : notFound();
  }
  // PX-W2 (G2, G4): one product's downloads and store links, per platform (`downloads.ts`).
  if (head === "products" && rest.length === 2 && rest[1] === "downloads")
    return handleProductDownloads(
      req,
      env,
      db,
      session,
      rest[0]!,
      now,
      hooksFor,
    );
  if (
    head === "products" &&
    rest.length === 2 &&
    rest[0] &&
    rest[1] === "email-download"
  ) {
    return handleEmailDownload(req, env, db, session, rest[0], now);
  }
  return notFound();
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
  if (req.method !== "GET") return err(405, "method_not_allowed");
  // R11-05: opportunistic retention. Nothing else ever deletes from this table and the worker
  // has no scheduled() handler, so the read path does a bounded sweep of its own expired rows.
  await purgeExpiredDownloadTokens(db, now);
  // Expiry and single-use are now SQL predicates (R9-05b), so an unusable token never returns.
  const row = await getPortalDownloadToken(env, db, token, now);
  if (!row) return notFound();
  const artifact = row.artifact_id
    ? await getPortalArtifact(db, row.product, row.release_id, row.artifact_id)
    : null;
  const facts = artifact
    ? await getPortalReleaseFacts(db, row.product, row.release_id)
    : null;
  const gate = facts
    ? await deliveryGate(db, hooksFor, row.product, now)
    : null;
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
  if (settings.portal_enabled !== 1 || settings.releases_enabled !== 1) {
    return notFound();
  }
  const scope = parseJson<{ portalAccountId?: string }>(row.scope_json, {});
  if (!scope.portalAccountId) return notFound();
  const account = await getPortalAccount(db, scope.portalAccountId, now);
  if (!account || account.status !== "active") return notFound();
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
            releaseId: artifact.release_id,
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
  if (!(await markPortalDownloadUsed(db, row.product, row.token_hash, now))) {
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
