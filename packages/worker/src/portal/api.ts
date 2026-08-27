import { Catalog } from "@plrs/catalog";
import type { ConfigEntry } from "@plrs/catalog";
import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import { ErrorCode } from "../core/errors.js";
import { hashKey, productFromKey } from "../crypto.js";
import {
  getActiveSchema,
  getDevice,
  getKey,
  getLicense,
  getProduct,
  setDeviceStatus,
} from "../repo.js";
import { deleteTokenRecord } from "../kv.js";
import { resolveEffective } from "../licenseCore.js";
import { licenseUsable } from "../core/devices.js";
import { tighterMax, tighterMin } from "../gate.js";
import { clientIp, rateLimitOk } from "../core/rateLimit.js";
import { isAllowedStorageHost } from "../services/release/github.js";
import {
  getPortalAccount,
  getPortalArtifact,
  getPortalDownloadToken,
  getPortalLicense,
  getPortalProductSettings,
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
  syncAccountLicenseLinks,
  createPortalDownloadToken,
  deletePortalAccount,
  type PortalArtifactRow,
  type PortalLicenseRow,
} from "./repo.js";
import {
  PORTAL_CSRF_HEADER,
  buildPortalClearCookie,
  portalSessionFromRequest,
  type PortalSession,
} from "./session.js";
import { handleMagicStart } from "./auth.js";
import { portalEmailConfigured, sendPortalNotice } from "./email.js";
import { platformOidcConfig } from "../platformOidc.js";
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

async function hasUsableProductLicense(
  db: Db,
  accountId: string,
  product: string,
  now: number,
): Promise<boolean> {
  const rows = await listPortalLicenses(db, accountId);
  return rows.some((row) => row.product === product && licenseUsable(row, now));
}

async function hasLinkedProductLicense(
  db: Db,
  accountId: string,
  product: string,
): Promise<boolean> {
  const rows = await listPortalLicenses(db, accountId);
  return rows.some((row) => row.product === product);
}

function artifactAccess(artifact: PortalArtifactRow): string {
  if (artifact.access === "authenticated" || artifact.access === "licensed") {
    return artifact.access;
  }
  return "public";
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
): Promise<Response> {
  const [product, releaseId, artifactsSegment, artifactId, tokenSegment] = rest;
  if (!product) {
    const products = await listLinkedProducts(db, session.accountId);
    const enabledProducts: string[] = [];
    for (const row of products) {
      const settings = await getPortalProductSettings(db, row.slug);
      if (settings.portal_enabled === 1 && settings.releases_enabled === 1) {
        enabledProducts.push(row.slug);
      }
    }
    const releases = await listPortalReleases(db, enabledProducts);
    const usableByProduct = new Map<string, boolean>();
    const out = [];
    for (const release of releases) {
      let usable = usableByProduct.get(release.product);
      if (usable === undefined) {
        usable = await hasUsableProductLicense(
          db,
          session.accountId,
          release.product,
          now,
        );
        usableByProduct.set(release.product, usable);
      }
      const artifacts = await listPortalArtifacts(
        db,
        release.product,
        release.release_id,
      );
      out.push({
        product: release.product,
        productName: release.product_name,
        releaseId: release.release_id,
        version: release.version,
        title: release.title,
        notes: release.notes,
        publishedAt: release.published_at,
        sourceUrl: release.source_url,
        artifacts: artifacts.map((artifact) => ({
          artifactId: artifact.artifact_id,
          name: artifact.name,
          kind: artifact.kind,
          platform: artifact.platform,
          arch: artifact.arch,
          sizeBytes: artifact.size_bytes,
          sha256: artifact.sha256,
          access: artifactAccess(artifact),
          // Same predicate the redirect applies (R6-12), so the portal never offers a download
          // it is going to refuse — an artifact stored with an unservable URL reads as
          // unavailable here rather than as a button that 404s.
          canDownload:
            redirectableSourceUrl(artifact) !== null &&
            (artifactAccess(artifact) !== "licensed" || usable),
        })),
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
  if (settings.portal_enabled !== 1 || settings.releases_enabled !== 1) {
    return notFound();
  }
  const artifact = await getPortalArtifact(db, product, releaseId, artifactId);
  // Refused at MINT time as well as at redemption: a token that could only ever be rejected is
  // a row written, a rate-limit charge spent and a URL handed to the user for nothing.
  if (!artifact || redirectableSourceUrl(artifact) === null) return notFound();
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
  const access = artifactAccess(artifact);
  if (access === "licensed") {
    const ok = await hasUsableProductLicense(
      db,
      session.accountId,
      product,
      now,
    );
    if (!ok) return forbidden("licensed release access required");
  }
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
    return handleReleases(req, env, db, session, rest, now);
  return notFound();
}

export async function handlePortalDownload(
  req: Request,
  env: Env,
  db: Db,
  token: string,
  now: number,
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
  // R6-12: the ONLY value that may become a `Location` header. `null` here means the stored URL
  // is absent, unparseable, not https, or not a GitHub storage host — all of which are refusals,
  // never redirects.
  const location = artifact ? redirectableSourceUrl(artifact) : null;
  if (!artifact || location === null) return notFound();
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
    artifactAccess(artifact) === "licensed" &&
    !(await hasUsableProductLicense(
      db,
      scope.portalAccountId,
      row.product,
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
