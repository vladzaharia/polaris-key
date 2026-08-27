/// <reference types="@cloudflare/workers-types" />

// Product OIDC — the Identity service's sign-in engine (design spec §2.1, D-14).
//
// Each product has one server-selected OIDC provider (platform default or custom) plus
// product-scoped group mapping/provisioning. A browser sign-in mints/locates a license for the
// identity; generic provisioning hooks turn verified claims into entitlements + secrets. The
// CLI/loopback flow polls for a per-device token. ID tokens are verified against the issuer
// JWKS via jose (asymmetric algs only).
//
// ── THE ROUTE MOVE (§R1) ────────────────────────────────────────────────────────────────────
//
// Every surface here now answers under `/<p>/identity/auth/…`; `routes.ts` is the sub-router.
// The old top-level spellings are GONE — not aliased. Nothing external ships them: an SDK reads
// its URLs out of `/.well-known/polaris.json`, and the one place a path was ever pinned is an
// operator's IdP redirect-URI registration, which is per-product configuration an operator
// re-registers (`oidc_config.redirect_uris_json` moves with it — see `beginAuthFlow`).
//
// The redundant `/<p>/auth/login` spelling of `/auth/start` is deleted outright rather than
// carried over: a compatibility alias for a path nobody can still be calling is a second code
// path for free.

import { createRemoteJWKSet, jwtVerify } from "jose";
import type { ManagedEntry } from "@polaris-key/protocol";
import type { ManagedPayload } from "../../core/payload.js";
import { HEADER_DEVICE } from "@polaris-key/protocol/core";
// R9-01: the manifest validator's issuer rule, applied again at the SINK. Ingest-only
// validation would leave every `oidc_config` row written before it landed (or by any future
// writer that bypasses `parseManifest`) able to steer the token POST that carries this
// product's client secret. Imported from the shared package rather than through Release, whose
// `manifest.ts` merely re-exports it — a service may not import a sibling.
import { isSafeIssuerUrl } from "@polaris-key/manifest";
import {
  platformOidcConfig,
  secret,
  staticHtmlSecurityHeaders,
  randomId,
  type Db,
  type Env,
} from "../../core/platform.js";
import { openProductSecret, type Product } from "../../core/products.js";
import { errorResponse, json, methodNotAllowed } from "../../core/errors.js";
import { clientIp, rateLimitOk, type RateLimit } from "../../core/rateLimit.js";
import {
  appendAudit,
  claimEnrolledLicense,
  getDevice,
  getLicense,
  getLicenseBySub,
  getTier,
  insertLicense,
  moveDevices,
} from "../../core/data.js";
import { allowsOidcDefault } from "../../core/fingerprint.js";
import { authorizeDevice, tierExpiresAt } from "../../core/authz.js";
import { licenseUsable } from "../../core/devices.js";
import { createBrowserSession } from "./browserSession.js";

const FLOW_TTL_SECONDS = 600;
const ALLOWED_ID_TOKEN_ALGS = ["RS256", "ES256", "EdDSA"];
/** The poll cadence advertised by `/identity/auth/device/start`, enforced server-side (R8-02). */
const DEVICE_POLL_INTERVAL_SECONDS = 2;
/** Freshness ceiling on the ID token's `iat`. `exp` alone is entirely the IdP's choice, so a
 *  token minted long before this exchange must not be replayable into a sign-in (R8-05d). */
const ID_TOKEN_MAX_AGE = "5m";
const ID_TOKEN_CLOCK_TOLERANCE = 300;

interface OidcConfigRow {
  product: string;
  provider: string | null;
  issuer: string | null;
  client_id: string | null;
  client_secret_secret: string | null;
  redirect_uris_json: string | null;
  group_role_map_json: string | null;
}

interface ResolvedOidcConfig {
  row: OidcConfigRow;
  issuer: string;
  clientId: string;
  clientSecret?: string;
}

interface ProvisioningRow {
  product: string;
  claim: string;
  entitlement_key: string | null;
  entitlement_value_json: string | null;
  secret_key: string | null;
  secret_url_template: string | null;
  allowed_hosts_json: string | null;
}

export interface OidcIdentity {
  sub: string;
  email?: string;
  name?: string;
  groups: string[];
  claims: Record<string, unknown>;
}

interface FlowRecord {
  verifier: string;
  nonce: string;
  redirectUri: string;
  returnTo?: string;
  /** The device that started a device-code/loopback flow. Carried so sign-in can see which
   *  license that device is already running on and claim it if it's an auto-issued one. */
  deviceId?: string;
  licenseId?: string;
  error?: string;
  /** Stamped when the human confirms the device-code flow. A device flow may only mint after
   *  this is set — the poll surfaces must not be able to skip the confirmation (R8-01). */
  confirmedAt?: number;
  /** Stamped by the first callback that claims this state. A state is single-use: a second
   *  callback must never be able to rebind `licenseId` under a waiting poller (R8-04). */
  consumedAt?: number;
}

interface DeviceFlowRecord {
  state: string;
  deviceId: string;
  userCode: string;
  authorizeUrl: string;
  deviceName?: string;
  confirmedAt?: number;
  /** Minted on the GET render and required by the POST confirmation, so the state-mutating
   *  half of device verification cannot be driven cross-site (R8-02). */
  csrf?: string;
  /** Last poll, for the advertised `interval` throttle (R8-02). */
  lastPollAt?: number;
}

// ── helpers ──────────────────────────────────────────────────────────────────
function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function toAB(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(
    b.byteOffset,
    b.byteOffset + b.byteLength,
  ) as ArrayBuffer;
}
function randomBytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}
async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(randomBytes(32));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    toAB(new TextEncoder().encode(verifier)),
  );
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

async function getOidcConfig(
  db: Db,
  product: string,
): Promise<OidcConfigRow | null> {
  return db.first<OidcConfigRow>(
    "SELECT * FROM oidc_config WHERE product = ?",
    product,
  );
}

/**
 * Operator allowlist of hosts a **repo-owned** (`provider: custom`) OIDC issuer may name, read
 * from the `OIDC_ISSUER_ALLOWLIST` var as a comma/whitespace-separated host list.
 *
 * This is the control that closes the *rest* of R9-01. `isSafeIssuerUrl` stops a manifest from
 * naming a private/loopback/link-local address or plain http, but it cannot stop
 * `https://exfil.attacker.example` — a public https host is indistinguishable from a real IdP
 * at the character level, and that host still receives a POST containing the product's OIDC
 * `client_secret`. Only an operator-curated host list distinguishes them.
 *
 * **Unset means not enforced.** That is a deliberate, documented fail-open: enforcing an empty
 * allowlist would take every already-configured custom-OIDC product offline on the deploy that
 * ships this code, with no operator action and no warning. The follow-up that makes it fail
 * closed *for new configs only* has to live at the ingest paths (`release/linkRepo.ts`,
 * `release/resync.ts`), which can tell a first write from a re-sync; see
 * `docs/security/findings/R9-injection.md`. The platform issuer is exempt: it is a Worker
 * secret, not a repo-supplied value.
 */
function issuerHostAllowed(env: Env, issuer: string): boolean {
  const raw = secret(env, "OIDC_ISSUER_ALLOWLIST");
  if (!raw) return true;
  const hosts = raw
    .split(/[\s,]+/)
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (!hosts.length) return true;
  try {
    return hosts.includes(new URL(issuer).host.toLowerCase());
  } catch {
    return false;
  }
}

async function resolveOidcConfig(
  env: Env,
  db: Db,
  product: Product,
): Promise<ResolvedOidcConfig | Response> {
  const row = await getOidcConfig(db, product.slug);
  if (!row) return errorResponse(404, "disabled", "oidc is disabled");
  if ((row.provider ?? "platform") === "custom") {
    if (!row.issuer || !row.client_id) {
      return errorResponse(500, "misconfigured", "custom oidc config missing");
    }
    // R9-01/R9-02, at the sink. `oidc_config.issuer` is written from a linked repo's
    // `.pkey/product` manifest, and it is the base of the token POST that carries this
    // product's client secret, of the JWKS fetch that decides which keys may sign an ID
    // token, and of the anonymous 302 out of `/<product>/identity/auth/start`. The manifest validator
    // now refuses a non-https or private/loopback/link-local/reserved issuer — this repeats
    // that check against what is actually in D1, so a row written before the validator gained
    // it (or by any writer that skips `parseManifest`) still cannot aim those requests.
    // Deliberately BEFORE `openProductSecret`: an unusable config must not unseal the secret.
    if (!isSafeIssuerUrl(row.issuer)) {
      return errorResponse(
        500,
        "misconfigured",
        "custom oidc issuer is not permitted",
      );
    }
    if (!issuerHostAllowed(env, row.issuer)) {
      return errorResponse(
        500,
        "misconfigured",
        "custom oidc issuer is not permitted",
      );
    }
    let clientSecret: string | undefined;
    if (row.client_secret_secret) {
      clientSecret = await openProductSecret(
        db,
        env,
        product.slug,
        row.client_secret_secret,
      );
      if (!clientSecret) {
        return errorResponse(
          500,
          "misconfigured",
          "oidc client secret unavailable",
        );
      }
    }
    return {
      row,
      issuer: row.issuer,
      clientId: row.client_id,
      clientSecret,
    };
  }

  const platform = platformOidcConfig(env);
  if (!platform) {
    return errorResponse(
      500,
      "misconfigured",
      "platform oidc is not configured",
    );
  }
  // The platform issuer is operator-owned (a Worker secret), not repo-owned, so this is not
  // the R9-01 boundary — but the same request shapes hang off it, so it gets the same rule.
  if (!isSafeIssuerUrl(platform.issuer)) {
    return errorResponse(
      500,
      "misconfigured",
      "platform oidc issuer is not permitted",
    );
  }
  return {
    row,
    issuer: platform.issuer,
    clientId: platform.clientId,
    clientSecret: platform.clientSecret,
  };
}
async function getProvisioning(
  db: Db,
  product: string,
): Promise<ProvisioningRow[]> {
  return db.all<ProvisioningRow>(
    "SELECT * FROM provisioning_config WHERE product = ?",
    product,
  );
}

function flowKey(product: string, state: string): string {
  return `p:${product}:flow:${state}`;
}

function deviceFlowKey(product: string, code: string): string {
  return `p:${product}:device-flow:${code}`;
}

function deviceUserCode(state: string): string {
  return state
    .slice(0, 8)
    .toUpperCase()
    .replace(/(.{4})/, "$1-");
}

function safeReturnTo(req: Request, raw: string | null): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    const here = new URL(req.url);
    if (parsed.origin !== here.origin) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/**
 * Whether the computed `redirectUri` is permitted by the product's `redirect_uris_json`
 * allowlist. When the column is unset we cannot enforce, so we allow (the IdP still
 * enforces its own registered-redirect check); when it IS set, the computed URI MUST be a
 * member — otherwise an attacker-chosen host/path could exfiltrate the authorization code.
 */
function redirectUriAllowed(oidc: OidcConfigRow, redirectUri: string): boolean {
  if (!oidc.redirect_uris_json) return true;
  let allowed: unknown;
  try {
    allowed = JSON.parse(oidc.redirect_uris_json);
  } catch {
    return false;
  }
  return Array.isArray(allowed) && allowed.includes(redirectUri);
}

/** Parse a JSON config column, failing CLOSED (undefined) instead of throwing. A malformed
 *  column is an operator mistake, not a reason to take the whole sign-in path down with an
 *  uncaught SyntaxError (R8-06). */
function parseJsonColumn<T>(raw: string | null | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/**
 * Parse a stored flow record, treating a corrupt value exactly like a missing one (R11-06).
 *
 * Every caller already has a well-defined answer for "this flow does not exist" — `expired`,
 * `unknown state`, `timeout`. A truncated or garbled KV value is indistinguishable from that
 * for every purpose the handler has, so it should take the same branch rather than escape as
 * an uncaught `SyntaxError` and 500 a sign-in path.
 */
function parseFlowRecord<T>(raw: string): T | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as T) : null;
  } catch {
    return null;
  }
}

/** Whether a verified claim genuinely enables a provisioning hook. Truthiness is NOT enough:
 *  an IdP that emits `"false"`, `"0"`, `"null"`, `0`, `[]` or `{}` must not grant an
 *  entitlement, so we require a real boolean `true` or a meaningful string (R8-05c). */
function claimEnables(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  const s = value.trim().toLowerCase();
  return s !== "" && s !== "false" && s !== "0" && s !== "null";
}

/** Apply one or more abuse ceilings to an unauthenticated OIDC surface. Returns a 429 to
 *  return, or null when the call is within every limit. Poll/callback surfaces pass a second
 *  bucket keyed on the flow so a single state cannot be hammered from a botnet (R8-10). */
async function rateLimited(
  env: Env,
  product: Product,
  now: number,
  ...limits: RateLimit[]
): Promise<Response | null> {
  for (const rl of limits) {
    if (!(await rateLimitOk(env, product.slug, rl, now))) {
      return errorResponse(429, "rate_limited", "too many requests");
    }
  }
  return null;
}

// ── identity mapping + provisioning ──────────────────────────────────────────
/** Apply provisioning hooks (verified claim -> entitlement + secret) into a payload.
 *  `now` (epoch seconds) is stamped as `updatedAt` on every entry written. */
export async function applyProvisioning(
  db: Db,
  product: string,
  identity: OidcIdentity,
  payload: ManagedPayload,
  now: number,
): Promise<void> {
  const hooks = await getProvisioning(db, product);
  for (const h of hooks) {
    const claimVal = identity.claims[h.claim];
    if (!claimEnables(claimVal)) continue;
    if (h.entitlement_key) {
      let value: ManagedEntry["value"] = true;
      if (h.entitlement_value_json) {
        const parsed = parseJsonColumn<ManagedEntry["value"]>(
          h.entitlement_value_json,
        );
        // A hook row we cannot parse is a hook we do not trust: skip it entirely.
        if (parsed === undefined) continue;
        value = parsed;
      }
      payload.entitlements[h.entitlement_key] = {
        state: "enforced",
        value,
        updatedAt: now,
      };
    }
    if (h.secret_key && h.secret_url_template) {
      // Global replace: a template may reference {claim} more than once, and leaving a
      // literal placeholder in a "secret" ships a broken URL to the client (R8-06).
      const url = h.secret_url_template.replaceAll(
        "{claim}",
        encodeURIComponent(String(claimVal)),
      );
      // Host allowlist (defense against templated-secret injection). Fails CLOSED: a missing
      // or malformed allowlist drops the secret rather than emitting any host (R8-06).
      const allowed = parseJsonColumn<string[]>(h.allowed_hosts_json);
      if (!Array.isArray(allowed)) continue;
      try {
        if (!allowed.includes(new URL(url).host)) continue;
      } catch {
        continue;
      }
      payload.secrets[h.secret_key] = {
        state: "hidden",
        value: url,
        updatedAt: now,
      };
    }
  }
}

/** Find or mint a license for an identity. Returns the licenseId, or an error if the
 *  identity's groups don't grant entitlement. Idempotent on the OIDC subject. */
export async function activateFromIdentity(
  db: Db,
  product: Product,
  identity: OidcIdentity,
  now: number,
  /** The license the caller's device is already using, when it presented one. An anonymous
   *  enrolled license found here is merged into the identity rather than abandoned. */
  opts: { enrolledLicenseId?: string | null } = {},
): Promise<
  { licenseId: string; merged?: "claimed" | "migrated" } | { error: string }
> {
  const oidc = await getOidcConfig(db, product.slug);
  // A malformed map grants nothing (fail closed) instead of throwing out of sign-in (R8-06).
  const map =
    parseJsonColumn<Record<string, { role: string; tier?: string }>>(
      oidc?.group_role_map_json,
    ) ?? {};

  let entitled = false;
  let tierId: string | null = null;
  for (const g of identity.groups) {
    const m = map[g];
    if (m) {
      entitled = true;
      if (m.tier && !tierId) tierId = m.tier;
    }
  }
  if (!entitled) {
    // No mapped group. If the product opts into an OIDC default tier, any authenticated user
    // lands on the free tier instead of a hard 403; with the policy unset this is byte-for-byte
    // the previous behaviour.
    if (allowsOidcDefault(product.autoIssue) && product.autoIssue.tierId) {
      entitled = true;
      tierId = product.autoIssue.tierId;
    } else {
      return { error: "not-entitled" };
    }
  }

  let expiresAt: number | null = null;
  if (tierId) {
    expiresAt = tierExpiresAt(await getTier(db, product.slug, tierId), now);
  }

  const overrides: ManagedPayload = {
    config: {},
    secrets: {},
    entitlements: {},
  };
  await applyProvisioning(db, product.slug, identity, overrides, now);

  // The enrolled license this device is currently on, if it is genuinely a claimable
  // anonymous one. Anything else (an admin or OIDC license) is left alone.
  const enrolled = opts.enrolledLicenseId
    ? await getLicense(db, product.slug, opts.enrolledLicenseId)
    : null;
  const claimable =
    enrolled && enrolled.origin === "enroll" && enrolled.sub === null
      ? enrolled
      : null;

  const existing = await getLicenseBySub(db, product.slug, identity.sub);

  // Case 1 — a claimable enrolled license and no identity license yet: attach the identity to
  // the SAME row. Devices, overrides, and the client's local state all survive; the user
  // simply becomes known.
  if (claimable && !existing) {
    await claimEnrolledLicense(
      db,
      product.slug,
      claimable.id,
      {
        sub: identity.sub,
        name: identity.name ?? null,
        email: identity.email ?? null,
        groupsJson: JSON.stringify(identity.groups),
        tierId,
        expiresAt,
      },
      now,
    );
    await db.run(
      "UPDATE licenses SET overrides_json = ? WHERE product = ? AND id = ?",
      JSON.stringify(overrides),
      product.slug,
      claimable.id,
    );
    await appendAudit(db, {
      product: product.slug,
      id: randomId("aud"),
      at: now,
      actor_sub: identity.sub,
      actor_name: identity.name ?? null,
      actor_email: identity.email ?? null,
      action: "license.merge",
      target_kind: "license",
      target_id: claimable.id,
      parent_id: null,
      summary: `Claimed the auto-issued license for ${identity.email ?? identity.sub}`,
    });
    return { licenseId: claimable.id, merged: "claimed" };
  }

  // Case 2 — a claimable enrolled license AND an existing identity license: migrate the
  // devices onto the identity's license and retire the enrolled row, so the user keeps their
  // machines but ends up on the license that already holds their entitlements.
  if (claimable && existing && licenseUsable(existing, now)) {
    await moveDevices(db, product.slug, claimable.id, existing.id);
    // R3-05: `enroll_hwid` is deliberately NOT cleared. The retired row keeps occupying
    // `idx_licenses_enroll_hwid`, which is the only guard on "one free license per machine";
    // clearing it let the same machine enrol again immediately and repeat the merge with a
    // second identity, without limit.
    await db.run(
      `UPDATE licenses SET status = 'disabled', modified_by = 'oidc',
         modified_at = ? WHERE product = ? AND id = ?`,
      now,
      product.slug,
      claimable.id,
    );
    await appendAudit(db, {
      product: product.slug,
      id: randomId("aud"),
      at: now,
      actor_sub: identity.sub,
      actor_name: identity.name ?? null,
      actor_email: identity.email ?? null,
      action: "license.merge",
      target_kind: "license",
      target_id: existing.id,
      parent_id: claimable.id,
      summary: `Migrated devices from auto-issued license ${claimable.id}`,
    });
  }

  if (existing) {
    if (!licenseUsable(existing, now)) return { error: "license-unusable" };
    await db.run(
      `UPDATE licenses SET name = ?, email = ?, groups_json = ?, tier_id = ?,
         expires_at = ?, overrides_json = ?, modified_by = ?, modified_at = ?
       WHERE product = ? AND id = ?`,
      identity.name ?? null,
      identity.email ?? null,
      JSON.stringify(identity.groups),
      tierId,
      expiresAt,
      JSON.stringify(overrides),
      "oidc",
      now,
      product.slug,
      existing.id,
    );
    return {
      licenseId: existing.id,
      ...(claimable ? { merged: "migrated" as const } : {}),
    };
  }

  const licenseId = randomId("lic");
  await insertLicense(db, {
    product: product.slug,
    id: licenseId,
    status: "active",
    sub: identity.sub,
    name: identity.name ?? null,
    email: identity.email ?? null,
    groups_json: JSON.stringify(identity.groups),
    tier_id: tierId,
    activated_at: now,
    expires_at: expiresAt,
    max_offline_days: null,
    overrides_json: JSON.stringify(overrides),
    channels_json: null,
    min_version: null,
    max_version: null,
    modified_by: "oidc",
    modified_at: now,
  });
  return { licenseId };
}

/** Authorize a device for a license and mint a per-device token. */
export async function authorizeAndMint(
  env: Env,
  db: Db,
  product: Product,
  licenseId: string,
  deviceId: string,
  now: number,
): Promise<string> {
  const row = await getLicense(db, product.slug, licenseId);
  if (!row) throw new Error("license not found");
  const result = await authorizeDevice(env, db, product, row, deviceId, now);
  if ("error" in result) throw new Error(result.error);
  return result.token;
}

// ── HTTP handlers ────────────────────────────────────────────────────────────
async function beginAuthFlow(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  returnTo?: string,
  deviceId?: string,
): Promise<
  | {
      ok: true;
      state: string;
      authorizeUrl: string;
      redirectUri: string;
    }
  | Response
> {
  const oidc = await resolveOidcConfig(env, db, product);
  if (oidc instanceof Response) return oidc;
  const state = b64url(randomBytes(16));
  const nonce = b64url(randomBytes(16));
  const { verifier, challenge } = await pkce();
  // §R1: the callback moved under the service namespace with the rest of Identity. This is the
  // value the IdP must have REGISTERED — `redirectUriAllowed` below refuses anything else the
  // moment `redirect_uris_json` is set — so an operator upgrading a product with a custom (or
  // strictly-configured platform) IdP re-registers `…/<p>/identity/auth/callback` and updates
  // the `oidc.redirectUris` block in its `.pkey/product` manifest. Pre-launch, so there is
  // no dual-registration window to keep: one spelling, computed in exactly one place.
  const redirectUri = `${new URL(req.url).origin}/${product.slug}/identity/auth/callback`;
  if (!redirectUriAllowed(oidc.row, redirectUri)) {
    return errorResponse(400, "bad_request", "redirect_uri not allow-listed");
  }
  const flow: FlowRecord = { verifier, nonce, redirectUri, returnTo, deviceId };
  await env.HOT.put(flowKey(product.slug, state), JSON.stringify(flow), {
    expirationTtl: FLOW_TTL_SECONDS,
  });

  const authorize = new URL(`${oidc.issuer.replace(/\/$/, "")}/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", oidc.clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", "openid email profile groups");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("nonce", nonce);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  return {
    ok: true,
    state,
    authorizeUrl: authorize.toString(),
    redirectUri,
  };
}

/** GET /<product>/identity/auth/start — begin PKCE, redirect to the IdP authorize endpoint. */
export async function handleAuthStart(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
): Promise<Response> {
  const limited = await rateLimited(
    env,
    product,
    Math.floor(Date.now() / 1000),
    { bucket: "authStart", id: clientIp(req), limit: 60, windowSec: 60 },
  );
  if (limited) return limited;
  const rawReturnTo = new URL(req.url).searchParams.get("return_to");
  const returnTo = safeReturnTo(req, rawReturnTo);
  if (rawReturnTo && !returnTo)
    return errorResponse(400, "bad_request", "return_to not allowed");
  const flow = await beginAuthFlow(req, env, db, product, returnTo);
  if (flow instanceof Response) return flow;
  return new Response(null, {
    status: 302,
    headers: { location: flow.authorizeUrl },
  });
}

/** POST /<product>/identity/auth/device/start — begin desktop/CLI sign-in, return a poll handle. */
export async function handleAuthDeviceStart(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed();
  const limited = await rateLimited(
    env,
    product,
    Math.floor(Date.now() / 1000),
    { bucket: "authDeviceStart", id: clientIp(req), limit: 60, windowSec: 60 },
  );
  if (limited) return limited;
  let body: Record<string, unknown> = {};
  try {
    const text = await req.text();
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return errorResponse(400, "bad_request", "invalid json");
  }
  const url = new URL(req.url);
  const deviceId =
    (typeof body.deviceId === "string" && body.deviceId) ||
    req.headers.get(HEADER_DEVICE) ||
    url.searchParams.get("device");
  if (!deviceId) return errorResponse(400, "bad_request", "missing device id");
  const deviceName =
    typeof body.deviceName === "string" && body.deviceName.trim()
      ? body.deviceName.trim().slice(0, 120)
      : undefined;
  const flow = await beginAuthFlow(req, env, db, product, undefined, deviceId);
  if (flow instanceof Response) return flow;
  const deviceCode = b64url(randomBytes(16));
  const userCode = deviceUserCode(deviceCode);
  const deviceRecord: DeviceFlowRecord = {
    state: flow.state,
    deviceId,
    userCode,
    authorizeUrl: flow.authorizeUrl,
    deviceName,
  };
  await env.HOT.put(
    deviceFlowKey(product.slug, deviceCode),
    JSON.stringify(deviceRecord),
    { expirationTtl: FLOW_TTL_SECONDS },
  );
  const verificationUri = `${new URL(req.url).origin}/${product.slug}/identity/auth/device/verify?device_code=${encodeURIComponent(deviceCode)}`;
  return json({
    status: "pending",
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: verificationUri,
    expiresIn: FLOW_TTL_SECONDS,
    interval: DEVICE_POLL_INTERVAL_SECONDS,
    pollUrl: `${new URL(req.url).origin}/${product.slug}/identity/auth/device/poll`,
  });
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The CSRF token the confirmation form posts back, from either an HTML form body or JSON. */
async function readConfirmToken(req: Request): Promise<string | null> {
  const text = await req.text().catch(() => "");
  if (!text) return null;
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    const body = parseJsonColumn<Record<string, unknown>>(text);
    return typeof body?.csrf === "string" ? body.csrf : null;
  }
  return new URLSearchParams(text).get("csrf") || null;
}

/** POST half of device verification: mark the flow user-confirmed and hand the browser on to
 *  the IdP. Requires the CSRF token minted on the GET render, so neither a prefetch nor a
 *  cross-site form can confirm a flow (or read `state`/`nonce`) on the visitor's behalf. */
async function confirmDeviceFlow(
  req: Request,
  env: Env,
  product: Product,
  deviceCode: string,
  record: DeviceFlowRecord,
  url: URL,
  now: number,
): Promise<Response> {
  // Browsers always send Origin on a form POST; a cross-site submission is refused outright.
  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin)
    return errorResponse(403, "forbidden", "confirmation failed");
  const token = await readConfirmToken(req);
  if (!record.csrf || !token || token !== record.csrf)
    return errorResponse(403, "forbidden", "confirmation failed");

  // The confirmation is an authorization input for the poll surfaces, so it is recorded on
  // the flow the pollers actually read, not only on the device record (R8-01).
  const flowRaw = await env.HOT.get(flowKey(product.slug, record.state));
  if (!flowRaw) return errorResponse(404, "not_found", "device code expired");
  const flow = parseFlowRecord<FlowRecord>(flowRaw);
  if (!flow) return errorResponse(404, "not_found", "device code expired");
  flow.confirmedAt = now;
  await env.HOT.put(flowKey(product.slug, record.state), JSON.stringify(flow), {
    expirationTtl: FLOW_TTL_SECONDS,
  });
  record.confirmedAt = now;
  delete record.csrf; // single-use
  await env.HOT.put(
    deviceFlowKey(product.slug, deviceCode),
    JSON.stringify(record),
    { expirationTtl: FLOW_TTL_SECONDS },
  );
  return new Response(null, {
    status: 303,
    headers: {
      location: record.authorizeUrl,
      // The authorize URL carries `state` and `nonce`: keep it out of the Referer chain and
      // out of every cache (R8-02).
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
}

/** GET /<product>/identity/auth/device/verify — render the confirmation page.
 *  POST /<product>/identity/auth/device/verify — confirm it. The GET is deliberately side-effect free:
 *  it used to accept `?confirm=1`, which made an `<img src>` enough to confirm a flow AND
 *  handed the caller `state` + `nonce` in the 302 (R8-02). */
export async function handleAuthDeviceVerify(
  req: Request,
  env: Env,
  product: Product,
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed();
  const now = Math.floor(Date.now() / 1000);
  const limited = await rateLimited(env, product, now, {
    bucket: "authDeviceVerify",
    id: clientIp(req),
    limit: 60,
    windowSec: 60,
  });
  if (limited) return limited;
  const url = new URL(req.url);
  const deviceCode = url.searchParams.get("device_code");
  if (!deviceCode) return errorResponse(400, "bad_request", "missing code");
  const raw = await env.HOT.get(deviceFlowKey(product.slug, deviceCode));
  if (!raw) return errorResponse(404, "not_found", "device code expired");
  const record = parseFlowRecord<DeviceFlowRecord>(raw);
  if (!record) return errorResponse(404, "not_found", "device code expired");

  if (req.method === "POST")
    return confirmDeviceFlow(req, env, product, deviceCode, record, url, now);

  const csrf = b64url(randomBytes(16));
  record.csrf = csrf;
  await env.HOT.put(
    deviceFlowKey(product.slug, deviceCode),
    JSON.stringify(record),
    { expirationTtl: FLOW_TTL_SECONDS },
  );
  const deviceLabel = record.deviceName || record.deviceId;
  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize ${escapeHtml(product.name)}</title>
<body style="font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; background: #0c0f17; color: #f8fafc;">
  <main style="max-width: 440px; margin: 12vh auto; padding: 32px;">
    <p style="color:#9aa4b2; margin:0 0 8px;">Polaris Key</p>
    <h1 style="font-size: 28px; margin:0 0 16px;">Authorize ${escapeHtml(product.name)}</h1>
    <p style="line-height:1.5; color:#cbd5e1;">A desktop app is asking to activate this device. Confirm the code and device before signing in.</p>
    <dl style="display:grid; grid-template-columns: 110px 1fr; gap:10px; margin:24px 0; color:#cbd5e1;">
      <dt>Code</dt><dd style="margin:0; color:#fff; font-weight:700; letter-spacing:.08em;">${escapeHtml(record.userCode)}</dd>
      <dt>Device</dt><dd style="margin:0;">${escapeHtml(deviceLabel)}</dd>
      <dt>Product</dt><dd style="margin:0;">${escapeHtml(product.slug)}</dd>
    </dl>
    <form method="post" action="${escapeHtml(url.toString())}">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <button type="submit" style="display:inline-flex; align-items:center; justify-content:center; min-height:42px; padding:0 18px; border:0; border-radius:8px; background:#5b7cfa; color:#fff; font:inherit; font-weight:650; cursor:pointer;">Continue to sign in</button>
    </form>
  </main>
</body>`;
  return new Response(html, {
    status: 200,
    // R1-09: `index.ts`'s `secureResponse` backstop would supply this policy anyway, but a
    // handler that emits HTML should not depend on the dispatcher — a direct call (a test, or
    // a future internal caller) must be hardened too. `staticHtmlSecurityHeaders` preserves
    // the `referrer-policy` set here.
    headers: staticHtmlSecurityHeaders(
      new Headers({
        "content-type": "text/html; charset=utf-8",
        // The address bar holds the device code: never let it ride along as a Referer, and
        // never let a shared cache keep the page (R8-02).
        "referrer-policy": "no-referrer",
        "cache-control": "no-store",
      }),
    ),
  });
}

function mapClaims(payload: Record<string, unknown>): OidcIdentity {
  const groups = Array.isArray(payload.groups)
    ? (payload.groups.filter((g) => typeof g === "string") as string[])
    : [];
  // Only a VERIFIED email is trusted: this value is persisted on the license, signed into the
  // config document's identity profile, and is what the portal auto-links accounts on. An
  // unverified claim is attacker-chosen, so we store nothing rather than that (R8-05b).
  const email =
    payload.email_verified === true && typeof payload.email === "string"
      ? payload.email
      : undefined;
  const name =
    (typeof payload.name === "string" && payload.name) ||
    [payload.given_name, payload.family_name]
      .filter((s) => typeof s === "string")
      .join(" ")
      .trim() ||
    (email ?? "");
  return {
    // No String() coercion: a non-string `sub` is a type-confusion hazard (123 vs "123"), and
    // an empty one collapses every such identity onto a single license row (R8-05a). The
    // caller rejects the empty result — see handleAuthCallback.
    sub: typeof payload.sub === "string" ? payload.sub : "",
    email,
    name: name || undefined,
    groups,
    claims: payload,
  };
}

/** GET /<product>/identity/auth/callback — exchange the code, verify the ID token, mint a license. */
export async function handleAuthCallback(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state)
    return errorResponse(400, "bad_request", "missing code/state");
  const limited = await rateLimited(
    env,
    product,
    now,
    { bucket: "authCallback", id: clientIp(req), limit: 60, windowSec: 60 },
    { bucket: "authCallbackState", id: state, limit: 5, windowSec: 60 },
  );
  if (limited) return limited;
  const raw = await env.HOT.get(flowKey(product.slug, state));
  if (!raw) return errorResponse(400, "bad_request", "unknown state");
  const flow = parseFlowRecord<FlowRecord>(raw);
  if (!flow) return errorResponse(400, "bad_request", "unknown state");
  // Single-use state (R8-04). Claim the flow before any outbound call so a second callback
  // can never overwrite the license a poller is already waiting on; a replay gets exactly the
  // same generic answer as an unknown state.
  if (flow.consumedAt)
    return errorResponse(400, "bad_request", "unknown state");
  flow.consumedAt = now;
  await env.HOT.put(flowKey(product.slug, state), JSON.stringify(flow), {
    expirationTtl: FLOW_TTL_SECONDS,
  });
  const oidc = await resolveOidcConfig(env, db, product);
  if (oidc instanceof Response) {
    await env.HOT.delete(flowKey(product.slug, state));
    return oidc;
  }
  // Defense in depth: the stored flow's redirect_uri must still be allow-listed.
  if (!redirectUriAllowed(oidc.row, flow.redirectUri)) {
    await env.HOT.delete(flowKey(product.slug, state));
    return errorResponse(400, "bad_request", "redirect_uri not allow-listed");
  }

  const tokenRes = await fetch(
    `${oidc.issuer.replace(/\/$/, "")}/api/oidc/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: flow.redirectUri,
        client_id: oidc.clientId,
        code_verifier: flow.verifier,
        ...(oidc.clientSecret ? { client_secret: oidc.clientSecret } : {}),
      }),
    },
  );
  if (!tokenRes.ok) {
    // Delete the flow rather than recording a reason — pollers must not be able to
    // enumerate IdP failure modes (D8). The poll surface returns a generic error.
    await env.HOT.delete(flowKey(product.slug, state));
    return errorResponse(502, "oidc_error", "token exchange failed");
  }
  let tokens: { id_token?: string };
  try {
    tokens = (await tokenRes.json()) as { id_token?: string };
  } catch {
    await env.HOT.delete(flowKey(product.slug, state));
    return errorResponse(502, "oidc_error", "token response invalid");
  }
  if (!tokens.id_token) {
    await env.HOT.delete(flowKey(product.slug, state));
    return errorResponse(502, "oidc_error", "no id_token");
  }

  const jwks = createRemoteJWKSet(
    new URL(`${oidc.issuer.replace(/\/$/, "")}/.well-known/jwks.json`),
  );
  let claims: Record<string, unknown>;
  try {
    const verified = await jwtVerify(tokens.id_token, jwks, {
      issuer: oidc.issuer,
      audience: oidc.clientId,
      algorithms: ALLOWED_ID_TOKEN_ALGS,
      // Freshness is ours to enforce: `exp` is entirely the IdP's choice, so a token minted
      // long before this exchange must not be replayable into a sign-in (R8-05d).
      clockTolerance: ID_TOKEN_CLOCK_TOLERANCE,
      maxTokenAge: ID_TOKEN_MAX_AGE,
    });
    claims = verified.payload as Record<string, unknown>;
    // Reject unconditionally on a missing or mismatched nonce — a token with no nonce must
    // never satisfy the binding to this flow (replay / token-injection defense).
    if (typeof claims.nonce !== "string" || claims.nonce !== flow.nonce)
      throw new Error("nonce mismatch");
  } catch {
    await env.HOT.delete(flowKey(product.slug, state));
    return errorResponse(401, "unauthorized", "id token invalid");
  }

  // An identity with no subject is not an identity: `getLicenseBySub(…, "")` would match every
  // other subject-less row, so distinct people would share one license. Admin and portal both
  // reject this already (admin/auth.ts:216, portal/auth.ts:280) — so does the product flow now
  // (R8-05a). Same generic 401 as any other bad ID token.
  const identity = mapClaims(claims);
  if (!identity.sub) {
    await env.HOT.delete(flowKey(product.slug, state));
    return errorResponse(401, "unauthorized", "id token invalid");
  }

  // A device-code/loopback flow carries the device id that started it. If that device is
  // already running on an auto-issued license, sign-in claims that license in place rather
  // than stranding the user's existing devices and local state on an orphan.
  const enrolledLicenseId = flow.deviceId
    ? ((await getDevice(db, product.slug, flow.deviceId))?.license_id ?? null)
    : null;

  const result = await activateFromIdentity(db, product, identity, now, {
    enrolledLicenseId,
  });
  if ("error" in result) {
    // Failed activation: drop the flow so the poller gets a generic error, not the reason.
    await env.HOT.delete(flowKey(product.slug, state));
    return errorResponse(403, "forbidden", "not entitled");
  }
  flow.licenseId = result.licenseId;
  if (flow.returnTo) {
    const license = await getLicense(db, product.slug, result.licenseId);
    if (!license) {
      await env.HOT.delete(flowKey(product.slug, state));
      return errorResponse(401, "unauthorized", "license unavailable");
    }
    const session = await createBrowserSession(
      env,
      db,
      product,
      license,
      now,
      req,
    );
    await env.HOT.delete(flowKey(product.slug, state));
    if (!session.ok) {
      return errorResponse(
        session.status,
        session.code,
        session.message,
        session.extra,
      );
    }
    return new Response(null, {
      status: 302,
      headers: {
        location: flow.returnTo,
        "set-cookie": session.cookie,
      },
    });
  }
  await env.HOT.put(flowKey(product.slug, state), JSON.stringify(flow), {
    expirationTtl: FLOW_TTL_SECONDS,
  });
  return new Response(
    '<!doctype html><meta charset=utf-8><title>Signed in</title><body style="font-family:system-ui;padding:3rem;text-align:center"><h1>You\'re signed in</h1><p>You can close this tab and return to the app.</p>',
    {
      status: 200,
      // R1-09 — see the device-authorization page above: set the policy at the sink as well
      // as in the dispatcher backstop.
      headers: staticHtmlSecurityHeaders(
        new Headers({
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        }),
      ),
    },
  );
}

async function pollAuthFlow(
  env: Env,
  db: Db,
  product: Product,
  state: string | null,
  deviceId: string | null,
  now: number,
): Promise<Response> {
  if (!state || !deviceId)
    return errorResponse(400, "bad_request", "missing state/device");
  const raw = await env.HOT.get(flowKey(product.slug, state));
  if (!raw) return json({ status: "timeout" });
  const flow = parseFlowRecord<FlowRecord>(raw);
  if (!flow) return json({ status: "timeout" });
  // Generic error only — never echo an IdP failure reason a poller could enumerate (D8).
  if (flow.error) return json({ status: "error" });
  if (!flow.licenseId) return json({ status: "pending" });
  // `state` is a non-secret by construction (it rides on the authorize and callback URLs), so
  // it can never be the sole authorization input: the token is minted for the device that
  // STARTED the flow and only after the human confirmed it — the same two guards
  // handleAuthDevicePoll enforces, which this surface used to skip entirely (R8-01). The
  // answers are the existing generic ones, so a prober learns nothing new.
  if (!flow.deviceId || flow.deviceId !== deviceId)
    return json({ status: "error" });
  if (!flow.confirmedAt) return json({ status: "pending" });

  let token: string;
  try {
    token = await authorizeAndMint(
      env,
      db,
      product,
      flow.licenseId,
      deviceId,
      now,
    );
  } catch {
    return json({ status: "error" });
  }
  await env.HOT.delete(flowKey(product.slug, state));
  return json({ status: "ready", token, schemaVersion: product.schemaVersion });
}

/** GET /<product>/identity/auth/poll?state=&device= — return a token once the flow completes. */
export async function handleAuthPoll(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  const url = new URL(req.url);
  const state = url.searchParams.get("state");
  const limited = await rateLimited(
    env,
    product,
    now,
    { bucket: "authPoll", id: clientIp(req), limit: 120, windowSec: 60 },
    { bucket: "authPollState", id: state ?? "-", limit: 40, windowSec: 60 },
  );
  if (limited) return limited;
  return pollAuthFlow(
    env,
    db,
    product,
    state,
    url.searchParams.get("device"),
    now,
  );
}

/** POST /<product>/identity/auth/device/poll — poll a confirmed device sign-in flow. */
export async function handleAuthDevicePoll(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed();
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return errorResponse(400, "bad_request", "invalid json");
  }
  const state =
    typeof body.deviceCode === "string"
      ? body.deviceCode
      : typeof body.state === "string"
        ? body.state
        : null;
  const deviceId = typeof body.deviceId === "string" ? body.deviceId : null;
  if (!state || !deviceId)
    return errorResponse(400, "bad_request", "missing deviceCode/deviceId");
  const limited = await rateLimited(
    env,
    product,
    now,
    { bucket: "authDevicePoll", id: clientIp(req), limit: 120, windowSec: 60 },
    { bucket: "authDevicePollCode", id: state, limit: 40, windowSec: 60 },
  );
  if (limited) return limited;
  const raw = await env.HOT.get(deviceFlowKey(product.slug, state));
  if (!raw) return json({ status: "timeout" });
  const deviceFlow = parseFlowRecord<DeviceFlowRecord>(raw);
  if (!deviceFlow) return json({ status: "timeout" });
  if (deviceFlow.deviceId !== deviceId)
    return errorResponse(401, "unauthorized", "device mismatch");
  // The `interval` we advertise at /identity/auth/device/start is enforced, not decorative: a client
  // polling faster than the contract is told to slow down instead of being served (R8-02).
  if (
    deviceFlow.lastPollAt !== undefined &&
    now - deviceFlow.lastPollAt < DEVICE_POLL_INTERVAL_SECONDS
  ) {
    return json(
      { status: "slow_down", interval: DEVICE_POLL_INTERVAL_SECONDS },
      { status: 429 },
    );
  }
  deviceFlow.lastPollAt = now;
  await env.HOT.put(
    deviceFlowKey(product.slug, state),
    JSON.stringify(deviceFlow),
    { expirationTtl: FLOW_TTL_SECONDS },
  );
  if (!deviceFlow.confirmedAt) return json({ status: "pending" });
  const res = await pollAuthFlow(
    env,
    db,
    product,
    deviceFlow.state,
    deviceFlow.deviceId,
    now,
  );
  const bodyOut = (await res
    .clone()
    .json()
    .catch(() => null)) as { status?: string } | null;
  if (bodyOut?.status === "ready" || bodyOut?.status === "timeout") {
    await env.HOT.delete(deviceFlowKey(product.slug, state));
  }
  return res;
}
