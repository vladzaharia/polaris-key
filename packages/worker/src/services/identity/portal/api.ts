import { Catalog } from "@polaris-key/catalog";
import type { ConfigEntry } from "@polaris-key/catalog";
import { platformFromFileName } from "@polaris-key/manifest";
import { CHANNEL_STABLE } from "@polaris-key/protocol";
import type { ReleaseAccess } from "@polaris-key/protocol/release";
import {
  deleteTokenRecord,
  hashKey,
  isAllowedDownloadRedirectHost,
  isAllowedStorageHost,
  productFromKey,
  type Db,
  type Env,
} from "../../../core/platform.js";
import type { Delivery, ServiceHooks } from "../../../core/hooks.js";
import {
  loadProductPublic,
  type ProductPublic,
} from "../../../core/products.js";
import { licenseEntitled } from "../../../core/entitledAccess.js";
import { ErrorCode } from "../../../core/errors.js";
import {
  getActiveSchema,
  getDevice,
  getKey,
  getLicense,
  getProduct,
  setDeviceStatus,
} from "../../../core/data.js";
import { resolveEffective } from "../../../core/authz.js";
import { licenseUsable } from "../../../core/devices.js";
import { tighterMax, tighterMin } from "../../../core/entitlements.js";
import { clientIp, rateLimitOk } from "../../../core/rateLimit.js";
import {
  getPortalAccount,
  getPortalArtifact,
  getPortalDownloadToken,
  getPortalLicense,
  getPortalProductSettings,
  getPortalReleaseFacts,
  linkLicense,
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
  portalSessionFromRequest,
  type PortalSession,
} from "./session.js";
import { handleMagicStart } from "./auth.js";
import { portalEmailConfigured, sendPortalNotice } from "./email.js";
import { platformOidcConfig } from "../../../core/platform.js";
import { portalSecurityHeaders } from "./headers.js";

function portalJson(
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

function err(status: number, code: string, message?: string): Response {
  return portalJson({ error: code, ...(message ? { message } : {}) }, status);
}

function unauthorized(): Response {
  return err(401, ErrorCode.Unauthorized);
}

function forbidden(message?: string): Response {
  return err(403, ErrorCode.Forbidden, message);
}

function notFound(): Response {
  return err(404, ErrorCode.NotFound);
}

function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
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

async function visibleCatalogFlags(
  db: Db,
  product: string,
): Promise<Map<string, ConfigEntry>> {
  const row = await getActiveSchema(db, product);
  if (!row) return new Map();
  try {
    const catalog = new Catalog(JSON.parse(row.catalog_json));
    return new Map(
      catalog.entries
        .filter((entry) => entry.kind === "flag" && entry.userGrant === true)
        .map((entry) => [entry.key, entry]),
    );
  } catch {
    return new Map();
  }
}

async function entitlementView(
  db: Db,
  license: PortalLicenseRow,
  now: number,
): Promise<Array<{ key: string; label: string; value: unknown }>> {
  const payload = await resolveEffective(
    db,
    license.product,
    license,
    null,
    now,
    { tighterMin, tighterMax },
  );
  const flags = await visibleCatalogFlags(db, license.product);
  const out: Array<{ key: string; label: string; value: unknown }> = [];
  for (const [key, entry] of flags) {
    const managed = payload.entitlements[key];
    const value = managed?.value ?? entry.default ?? false;
    if (value === false || value == null) continue;
    out.push({ key, label: entry.grantLabel ?? entry.label ?? key, value });
  }
  const channels = parseJson<string[]>(license.channels_json, []);
  if (channels.length > 0) {
    out.push({ key: "channels", label: "Release channels", value: channels });
  }
  return out;
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
    channels: parseJson<string[]>(row.channels_json, []),
    minVersion: row.min_version,
    maxVersion: row.max_version,
    identityProvider: row.sub ? "oidc" : "manual",
  };
}

async function shapeLicenseSummary(
  db: Db,
  row: PortalLicenseRow,
  now: number,
): Promise<Record<string, unknown>> {
  const keys = await listVisibleKeys(db, row.product, row.id);
  const devices = await listVisibleDevices(db, row.product, row.id);
  return {
    ...licenseBase(row),
    usable: licenseUsable(row, now),
    keyCount: keys.length,
    activeKeyCount: keys.filter((k) => k.status === "active").length,
    deviceCount: devices.filter((d) => d.status === "authorized").length,
    entitlements: await entitlementView(db, row, now),
  };
}

async function shapeLicenseDetail(
  db: Db,
  row: PortalLicenseRow,
  now: number,
): Promise<Record<string, unknown>> {
  const keys = await listVisibleKeys(db, row.product, row.id);
  const devices = await listVisibleDevices(db, row.product, row.id);
  return {
    ...(await shapeLicenseSummary(db, row, now)),
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
): Promise<{ session: PortalSession } | Response> {
  const session = await portalSessionFromRequest(env, req, now);
  if (!session) return unauthorized();
  const account = await getPortalAccount(db, session.accountId);
  if (!account || account.status !== "active") return unauthorized();
  return { session };
}

async function hasLinkedProductLicense(
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

interface DeliveryGate {
  product: ProductPublic;
  delivery: Delivery;
}

/**
 * The product's delivery hook, or `null` when downloads are not served: no hooks were provided,
 * the product is gone, or Distribution is off for it (byte delivery is Distribution's, and a
 * product with it off serves no downloads anywhere).
 */
async function deliveryGate(
  db: Db,
  hooksFor: PortalHooksFor | undefined,
  product: string,
  now: number,
): Promise<DeliveryGate | null> {
  if (!hooksFor) return null;
  const loaded = await loadProductPublic(db, product);
  if (!loaded) return null;
  const delivery = hooksFor(loaded, now).delivery();
  return delivery ? { product: loaded, delivery } : null;
}

type ReleaseFacts = Pick<
  PortalReleaseRow,
  "deliverable_id" | "version" | "channel"
>;

/** May this account download a release under `mode`? (A linked licence is checked by callers.) */
async function accountMayDownload(
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
 * Where a download redirects (R6-12): the artifact's own GitHub storage URL when it is one;
 * otherwise, for a PUBLIC deliverable only, Distribution's bytes-host URL for the file
 * (`delivery.deliveryUrl`), accepted only when it is `https` on the configured bytes host. A
 * non-public deliverable is never redirected to the bytes host: the browser holds no device
 * token, so the redirect could only end in a refusal.
 */
async function downloadTarget(
  env: Env,
  artifact: PortalArtifactRow,
  gate: DeliveryGate,
  mode: ReleaseAccess,
): Promise<string | null> {
  const source = redirectableSourceUrl(artifact);
  if (source !== null) return source;
  if (mode !== "public") return null;
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
  return isAllowedDownloadRedirectHost(url.hostname, env)
    ? url.toString()
    : null;
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
async function requireActionRateLimit(
  req: Request,
  env: Env,
  session: PortalSession,
  bucket: string,
  now: number,
  limit: number,
  product?: string,
  windowSec = 60,
): Promise<Response | null> {
  const ok = await rateLimitOk(
    env,
    product ?? "_portal",
    {
      bucket,
      id: `${product ?? "_"}:${session.accountId}:${clientIp(req)}`,
      limit,
      windowSec,
    },
    now,
  );
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
  await sendPortalNotice(
    env,
    account.primary_email ?? session.email,
    "Your Polaris Key account has been deleted",
    "Your Polaris Key portal account, its email addresses and its license links have been " +
      "erased at your request. Licenses issued to you by a product remain that product's " +
      "records; contact the product's support to have those erased.",
  );
  await deletePortalAccount(db, session.accountId, now);
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
  product?: string | null,
): Promise<Response> {
  const caps = await portalAuthCapabilities(db, product);
  return portalJson({
    auth: {
      oidc:
        caps.portalEnabled &&
        caps.oidcEnabled &&
        Boolean(platformOidcConfig(env)),
      magic:
        caps.portalEnabled && caps.magicEnabled && portalEmailConfigured(env),
    },
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
): Promise<Response> {
  await syncAccountLicenseLinks(db, session.accountId, now);
  const [product, licenseId] = rest;
  if (!product) {
    const rows = await listPortalLicenses(db, session.accountId);
    const filtered = [];
    for (const row of rows) {
      const settings = await getPortalProductSettings(db, row.product);
      if (settings.portal_enabled !== 1) continue;
      filtered.push(await shapeLicenseSummary(db, row, now));
    }
    return portalJson({ licenses: filtered });
  }
  if (!licenseId) return notFound();
  const row = await getPortalLicense(db, session.accountId, product, licenseId);
  if (!row) return notFound();
  const settings = await getPortalProductSettings(db, product);
  if (settings.portal_enabled !== 1) return notFound();
  return portalJson(await shapeLicenseDetail(db, row, now));
}

async function handleClaimKey(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  now: number,
): Promise<Response> {
  if (req.method !== "POST") return err(405, "method_not_allowed");
  const limited = await requireActionRateLimit(
    req,
    env,
    session,
    "portalClaimKey",
    now,
    10,
  );
  if (limited) return limited;
  const body = await readBody(req);
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const product = productFromKey(key);
  if (!product) return err(422, ErrorCode.BadRequest, "invalid license key");
  const settings = await getPortalProductSettings(db, product);
  if (
    settings.portal_enabled !== 1 ||
    settings.license_key_claim_enabled !== 1
  ) {
    return notFound();
  }
  const keyHash = await hashKey(key, env.KEY_HASH_PEPPER);
  const keyRow = await getKey(db, product, keyHash);
  if (!keyRow || keyRow.status !== "active") {
    return err(401, ErrorCode.Unauthorized, "license key not found");
  }
  const license = await getLicense(db, product, keyRow.license_id);
  if (!license) return err(401, ErrorCode.Unauthorized, "license unavailable");
  await linkLicense(
    db,
    session.accountId,
    product,
    license.id,
    "license-key",
    now,
  );
  await portalAudit(db, {
    accountId: session.accountId,
    action: "portal.license.claim",
    product,
    targetKind: "license",
    targetId: license.id,
    summary: "Claimed license with a license key",
    now,
  });
  await sendPortalNotice(
    env,
    session.email,
    "License added to your Polaris Key account",
    `A license for ${product} was added to your Polaris Key account.`,
  );
  const portalRow = await getPortalLicense(
    db,
    session.accountId,
    product,
    license.id,
  );
  return portalJson({
    ok: true,
    license: portalRow ? await shapeLicenseSummary(db, portalRow, now) : null,
  });
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
  const settings = await getPortalProductSettings(db, product);
  if (settings.portal_enabled !== 1) return notFound();
  const license = await getPortalLicense(
    db,
    session.accountId,
    product,
    licenseId,
  );
  if (!license) return notFound();
  // R5-05: charged AFTER ownership is proven, so a caller who owns no license on this product
  // cannot spend a budget at all — and the budget they do spend is scoped to this product.
  const limited = await requireActionRateLimit(
    req,
    env,
    session,
    "portalDeviceDisconnect",
    now,
    20,
    product,
  );
  if (limited) return limited;
  const device = await getDevice(db, product, deviceId);
  if (!device || device.license_id !== licenseId) return notFound();
  await setDeviceStatus(db, product, deviceId, "deauthorized");
  if (device.token_hash)
    await deleteTokenRecord(env, product, device.token_hash);
  await portalAudit(db, {
    accountId: session.accountId,
    action: "portal.device.disconnect",
    product,
    targetKind: "device",
    targetId: deviceId,
    summary: `Disconnected device ${deviceId}`,
    now,
  });
  await sendPortalNotice(
    env,
    session.email,
    "Device disconnected",
    `Device ${deviceId} was disconnected from your ${product} license.`,
  );
  return portalJson({ ok: true, deviceId });
}

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
  const artifact = await getPortalArtifact(db, product, releaseId, artifactId);
  const facts = artifact
    ? await getPortalReleaseFacts(db, product, releaseId)
    : null;
  // Byte delivery is Distribution's: with it off (or no hooks to ask), nothing is minted.
  const gate = facts ? await deliveryGate(db, hooksFor, product, now) : null;
  const mode =
    gate && facts ? await gate.delivery.accessMode(facts.deliverable_id) : null;
  // Refused at MINT time as well as at redemption: a token that could only ever be rejected is
  // a row written, a rate-limit charge spent and a URL handed to the user for nothing.
  if (
    !artifact ||
    !facts ||
    !gate ||
    !mode ||
    (await downloadTarget(env, artifact, gate, mode)) === null
  )
    return notFound();
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
  // The delivery access every download surface reads (P2b-04): `licensed` needs a usable
  // licence, `entitled` one whose grant holds this release's channel and version.
  if (
    !(await accountMayDownload(db, session.accountId, gate, mode, facts, now))
  )
    return forbidden(`${mode} release access required`);
  const token = await createPortalDownloadToken(env, db, {
    accountId: session.accountId,
    product,
    releaseId,
    artifactId,
    now,
  });
  return portalJson({ url: `/download/${encodeURIComponent(token)}` }, 201);
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
  const segments = p.split("/").filter(Boolean);
  if (segments[0] === "capabilities") {
    const requested = new URL(req.url).searchParams.get("product");
    return handleCapabilities(env, db, requested);
  }
  if (segments[0] === "magic" && segments[1] === "start") {
    return handleMagicStart(req, env, db);
  }

  const sessionResult = await requireSession(req, env, db, now);
  if (sessionResult instanceof Response) return sessionResult;
  const { session } = sessionResult;
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
  await syncAccountLicenseLinks(db, session.accountId, now);

  const [head, ...rest] = segments;
  if (head === "me") return handleMe(db, session, now);
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
  if (head === "licenses") return handleLicenses(db, session, rest, now);
  if (head === "claim" && rest[0] === "license-key") {
    return handleClaimKey(req, env, db, session, now);
  }
  if (head === "releases")
    return handleReleases(req, env, db, session, rest, now, hooksFor);
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
  // is absent, unparseable, not https, or not a GitHub storage host — and, for a public
  // deliverable, that Distribution has no bytes-host URL for it either (`downloadTarget`) — all
  // of which are refusals, never redirects.
  const location =
    artifact && gate && mode
      ? await downloadTarget(env, artifact, gate, mode)
      : null;
  if (!artifact || !facts || !gate || !mode || location === null)
    return notFound();
  const settings = await getPortalProductSettings(db, row.product);
  if (settings.portal_enabled !== 1 || settings.releases_enabled !== 1) {
    return notFound();
  }
  const scope = parseJson<{ portalAccountId?: string }>(row.scope_json, {});
  if (!scope.portalAccountId) return notFound();
  const account = await getPortalAccount(db, scope.portalAccountId);
  if (!account || account.status !== "active") return notFound();
  if (
    !(await hasLinkedProductLicense(db, scope.portalAccountId, row.product))
  ) {
    return notFound();
  }
  if (
    !(await accountMayDownload(
      db,
      scope.portalAccountId,
      gate,
      mode,
      facts,
      now,
    ))
  ) {
    return notFound();
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
