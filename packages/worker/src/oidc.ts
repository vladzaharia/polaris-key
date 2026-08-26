/// <reference types="@cloudflare/workers-types" />

// OIDC activation. Each product has one server-selected OIDC provider (platform default
// or custom) plus product-scoped group mapping/provisioning. A browser sign-in
// mints/locates a license for the identity; generic provisioning hooks turn verified
// claims into entitlements + secrets. The CLI/loopback flow polls for a per-device token.
// ID tokens are verified against the issuer JWKS via jose (asymmetric algs only).

import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  HEADER_DEVICE,
  type ManagedEntry,
  type ManagedPayload,
} from "@polaris-key/protocol";
import type { Env } from "./env.js";
import type { Db } from "./db/types.js";
import { openProductSecret, type Product } from "./product.js";
import { errorResponse, json, methodNotAllowed } from "./http.js";
import { randomId } from "./crypto.js";
import {
  appendAudit,
  claimEnrolledLicense,
  getDevice,
  getLicense,
  getLicenseBySub,
  getTier,
  insertLicense,
  moveDevices,
} from "./repo.js";
import { allowsOidcDefault } from "./fingerprint.js";
import { authorizeDevice, licenseUsable } from "./licenseCore.js";
import { createBrowserSession } from "./browserSession.js";
import { platformOidcConfig } from "./platformOidc.js";

const FLOW_TTL_SECONDS = 600;
const ALLOWED_ID_TOKEN_ALGS = ["RS256", "ES256", "EdDSA"];

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
}

interface DeviceFlowRecord {
  state: string;
  deviceId: string;
  userCode: string;
  authorizeUrl: string;
  deviceName?: string;
  confirmedAt?: number;
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
    if (claimVal === undefined || claimVal === null || claimVal === false)
      continue;
    if (h.entitlement_key) {
      const value = h.entitlement_value_json
        ? (JSON.parse(h.entitlement_value_json) as ManagedEntry["value"])
        : true;
      payload.entitlements[h.entitlement_key] = {
        state: "enforced",
        value,
        updatedAt: now,
      };
    }
    if (h.secret_key && h.secret_url_template) {
      const url = h.secret_url_template.replace(
        "{claim}",
        encodeURIComponent(String(claimVal)),
      );
      // Host allowlist (defense against templated-secret injection).
      const allowed = h.allowed_hosts_json
        ? (JSON.parse(h.allowed_hosts_json) as string[])
        : null;
      if (allowed) {
        try {
          if (!allowed.includes(new URL(url).host)) continue;
        } catch {
          continue;
        }
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
  const map = oidc?.group_role_map_json
    ? (JSON.parse(oidc.group_role_map_json) as Record<
        string,
        { role: string; tier?: string }
      >)
    : {};

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
    const tier = await getTier(db, product.slug, tierId);
    if (tier?.policy_expiry_days)
      expiresAt = now + tier.policy_expiry_days * 86400;
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
    await db.run(
      `UPDATE licenses SET status = 'disabled', enroll_hwid = NULL, modified_by = 'oidc',
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
  const redirectUri = `${new URL(req.url).origin}/${product.slug}/auth/callback`;
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

/** GET /<product>/auth/start — begin PKCE, redirect to the IdP authorize endpoint. */
export async function handleAuthStart(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
): Promise<Response> {
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

/** POST /<product>/auth/device/start — begin desktop/CLI sign-in and return a poll handle. */
export async function handleAuthDeviceStart(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed();
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
  const verificationUri = `${new URL(req.url).origin}/${product.slug}/auth/device/verify?device_code=${encodeURIComponent(deviceCode)}`;
  return json({
    status: "pending",
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: verificationUri,
    expiresIn: FLOW_TTL_SECONDS,
    interval: 2,
    pollUrl: `${new URL(req.url).origin}/${product.slug}/auth/device/poll`,
  });
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** GET /<product>/auth/device/verify — user-visible device confirmation. */
export async function handleAuthDeviceVerify(
  req: Request,
  env: Env,
  product: Product,
): Promise<Response> {
  if (req.method !== "GET") return methodNotAllowed();
  const url = new URL(req.url);
  const deviceCode = url.searchParams.get("device_code");
  if (!deviceCode) return errorResponse(400, "bad_request", "missing code");
  const raw = await env.HOT.get(deviceFlowKey(product.slug, deviceCode));
  if (!raw) return errorResponse(404, "not_found", "device code expired");
  const record = JSON.parse(raw) as DeviceFlowRecord;

  if (url.searchParams.get("confirm") === "1") {
    record.confirmedAt = Math.floor(Date.now() / 1000);
    await env.HOT.put(
      deviceFlowKey(product.slug, deviceCode),
      JSON.stringify(record),
      { expirationTtl: FLOW_TTL_SECONDS },
    );
    return new Response(null, {
      status: 302,
      headers: { location: record.authorizeUrl },
    });
  }

  const confirmUrl = new URL(url);
  confirmUrl.searchParams.set("confirm", "1");
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
    <a href="${escapeHtml(confirmUrl.toString())}" style="display:inline-flex; align-items:center; justify-content:center; min-height:42px; padding:0 18px; border-radius:8px; background:#5b7cfa; color:#fff; text-decoration:none; font-weight:650;">Continue to sign in</a>
  </main>
</body>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function mapClaims(payload: Record<string, unknown>): OidcIdentity {
  const groups = Array.isArray(payload.groups)
    ? (payload.groups.filter((g) => typeof g === "string") as string[])
    : [];
  const name =
    (typeof payload.name === "string" && payload.name) ||
    [payload.given_name, payload.family_name]
      .filter((s) => typeof s === "string")
      .join(" ")
      .trim() ||
    (typeof payload.email === "string" ? payload.email : "");
  return {
    sub: String(payload.sub ?? ""),
    email: typeof payload.email === "string" ? payload.email : undefined,
    name: name || undefined,
    groups,
    claims: payload,
  };
}

/** GET /<product>/auth/callback — exchange the code, verify the ID token, mint a license. */
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
  const raw = await env.HOT.get(flowKey(product.slug, state));
  if (!raw) return errorResponse(400, "bad_request", "unknown state");
  const flow = JSON.parse(raw) as FlowRecord;
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

  // A device-code/loopback flow carries the device id that started it. If that device is
  // already running on an auto-issued license, sign-in claims that license in place rather
  // than stranding the user's existing devices and local state on an orphan.
  const enrolledLicenseId = flow.deviceId
    ? ((await getDevice(db, product.slug, flow.deviceId))?.license_id ?? null)
    : null;

  const result = await activateFromIdentity(
    db,
    product,
    mapClaims(claims),
    now,
    { enrolledLicenseId },
  );
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
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
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
  const flow = JSON.parse(raw) as FlowRecord;
  // Generic error only — never echo an IdP failure reason a poller could enumerate (D8).
  if (flow.error) return json({ status: "error" });
  if (!flow.licenseId) return json({ status: "pending" });

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

/** GET /<product>/auth/poll?state=&device= — return a token once the flow completes. */
export async function handleAuthPoll(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  const url = new URL(req.url);
  return pollAuthFlow(
    env,
    db,
    product,
    url.searchParams.get("state"),
    url.searchParams.get("device"),
    now,
  );
}

/** POST /<product>/auth/device/poll — poll a confirmed device sign-in flow. */
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
  const raw = await env.HOT.get(deviceFlowKey(product.slug, state));
  if (!raw) return json({ status: "timeout" });
  const deviceFlow = JSON.parse(raw) as DeviceFlowRecord;
  if (deviceFlow.deviceId !== deviceId)
    return errorResponse(401, "unauthorized", "device mismatch");
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
