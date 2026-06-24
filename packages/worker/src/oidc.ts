/// <reference types="@cloudflare/workers-types" />

// OIDC enrollment (shared IdP, per-product client + group mapping). A browser sign-in
// mints/locates a license for the identity; generic provisioning hooks turn verified
// claims into entitlements + secrets (djdl's Remnawave/VPN is the first instance, as
// data). The CLI/loopback flow polls for a per-machine token. ID tokens are verified
// against the issuer JWKS via jose (asymmetric algs only).

import { createRemoteJWKSet, jwtVerify } from "jose";
import type { ManagedEntry, ManagedPayload } from "@polaris-key/protocol";
import { type Env, secret } from "./env.js";
import type { Db } from "./db/types.js";
import type { Product } from "./product.js";
import { errorResponse, json } from "./http.js";
import { hashKey, mintToken, randomId } from "./crypto.js";
import { putTokenRecord } from "./kv.js";
import {
  getLicenseBySub,
  getMachine,
  getTier,
  insertLicense,
  upsertMachine,
} from "./repo.js";

const FLOW_TTL_SECONDS = 600;
const ALLOWED_ID_TOKEN_ALGS = ["RS256", "ES256", "EdDSA"];

interface OidcConfigRow {
  product: string;
  issuer: string | null;
  client_id: string | null;
  client_secret_secret: string | null;
  redirect_uris_json: string | null;
  group_role_map_json: string | null;
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
  licenseId?: string;
  error?: string;
}

// ── helpers ──────────────────────────────────────────────────────────────────
function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function toAB(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}
function randomBytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}
async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(randomBytes(32));
  const digest = await crypto.subtle.digest("SHA-256", toAB(new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

async function getOidcConfig(db: Db, product: string): Promise<OidcConfigRow | null> {
  return db.first<OidcConfigRow>("SELECT * FROM oidc_config WHERE product = ?", product);
}
async function getProvisioning(db: Db, product: string): Promise<ProvisioningRow[]> {
  return db.all<ProvisioningRow>("SELECT * FROM provisioning_config WHERE product = ?", product);
}

function flowKey(product: string, state: string): string {
  return `p:${product}:flow:${state}`;
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
/** Apply provisioning hooks (verified claim -> entitlement + secret) into a payload. */
export async function applyProvisioning(
  db: Db,
  product: string,
  identity: OidcIdentity,
  payload: ManagedPayload,
): Promise<void> {
  const hooks = await getProvisioning(db, product);
  for (const h of hooks) {
    const claimVal = identity.claims[h.claim];
    if (claimVal === undefined || claimVal === null || claimVal === false) continue;
    if (h.entitlement_key) {
      const value = h.entitlement_value_json ? (JSON.parse(h.entitlement_value_json) as ManagedEntry["value"]) : true;
      payload.entitlements[h.entitlement_key] = { state: "managed", value };
    }
    if (h.secret_key && h.secret_url_template) {
      const url = h.secret_url_template.replace("{claim}", encodeURIComponent(String(claimVal)));
      // Host allowlist (defense against templated-secret injection).
      const allowed = h.allowed_hosts_json ? (JSON.parse(h.allowed_hosts_json) as string[]) : null;
      if (allowed) {
        try {
          if (!allowed.includes(new URL(url).host)) continue;
        } catch {
          continue;
        }
      }
      payload.secrets[h.secret_key] = { state: "hidden", value: url };
    }
  }
}

/** Find or mint a license for an identity. Returns the licenseId, or an error if the
 *  identity's groups don't grant entitlement. Idempotent on the OIDC subject. */
export async function enrollFromIdentity(
  db: Db,
  product: Product,
  identity: OidcIdentity,
  now: number,
): Promise<{ licenseId: string } | { error: string }> {
  const existing = await getLicenseBySub(db, product.slug, identity.sub);
  if (existing) return { licenseId: existing.id };

  const oidc = await getOidcConfig(db, product.slug);
  const map = oidc?.group_role_map_json
    ? (JSON.parse(oidc.group_role_map_json) as Record<string, { role: string; tier?: string }>)
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
  if (!entitled) return { error: "not-entitled" };

  let expiresAt: number | null = null;
  if (tierId) {
    const tier = await getTier(db, product.slug, tierId);
    if (tier?.policy_expiry_days) expiresAt = now + tier.policy_expiry_days * 86400;
  }

  const overrides: ManagedPayload = { config: {}, secrets: {}, entitlements: {} };
  await applyProvisioning(db, product.slug, identity, overrides);

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
    profile_id: null,
    enrolled_at: now,
    expires_at: expiresAt,
    max_offline_days: null,
    overrides_json: JSON.stringify(overrides),
    modified_by: "oidc",
    modified_at: now,
  });
  return { licenseId };
}

/** Authorize a device for a license and mint a per-machine token. */
export async function authorizeAndMint(
  env: Env,
  db: Db,
  product: Product,
  licenseId: string,
  deviceId: string,
  now: number,
): Promise<string> {
  const token = mintToken();
  const tokenHash = await hashKey(token, env.KEY_HASH_PEPPER);
  const existing = await getMachine(db, product.slug, deviceId);
  await upsertMachine(db, {
    product: product.slug,
    machine_id: deviceId,
    license_id: licenseId,
    status: "authorized",
    first_seen: existing?.first_seen ?? now,
    last_seen: now,
    ua: null,
    label: existing?.label ?? null,
    overrides_json: existing?.overrides_json ?? null,
    reported_json: existing?.reported_json ?? null,
    token_hash: tokenHash,
  });
  await putTokenRecord(env, product.slug, tokenHash, {
    product: product.slug,
    machineId: deviceId,
    licenseId,
  });
  return token;
}

// ── HTTP handlers ────────────────────────────────────────────────────────────
/** GET /<product>/auth/start — begin PKCE, redirect to the IdP authorize endpoint. */
export async function handleAuthStart(req: Request, env: Env, db: Db, product: Product): Promise<Response> {
  const oidc = await getOidcConfig(db, product.slug);
  if (!oidc?.issuer || !oidc.client_id) return errorResponse(500, "misconfigured", "no oidc config");
  const state = b64url(randomBytes(16));
  const nonce = b64url(randomBytes(16));
  const { verifier, challenge } = await pkce();
  const redirectUri = `${new URL(req.url).origin}/${product.slug}/auth/callback`;
  if (!redirectUriAllowed(oidc, redirectUri)) {
    return errorResponse(400, "bad_request", "redirect_uri not allow-listed");
  }
  const flow: FlowRecord = { verifier, nonce, redirectUri };
  await env.HOT.put(flowKey(product.slug, state), JSON.stringify(flow), { expirationTtl: FLOW_TTL_SECONDS });

  const authorize = new URL(`${oidc.issuer.replace(/\/$/, "")}/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", oidc.client_id);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", "openid email profile groups");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("nonce", nonce);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  return new Response(null, { status: 302, headers: { location: authorize.toString() } });
}

function mapClaims(payload: Record<string, unknown>): OidcIdentity {
  const groups = Array.isArray(payload.groups) ? (payload.groups.filter((g) => typeof g === "string") as string[]) : [];
  const name =
    (typeof payload.name === "string" && payload.name) ||
    [payload.given_name, payload.family_name].filter((s) => typeof s === "string").join(" ").trim() ||
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
export async function handleAuthCallback(req: Request, env: Env, db: Db, product: Product, now: number): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return errorResponse(400, "bad_request", "missing code/state");
  const raw = await env.HOT.get(flowKey(product.slug, state));
  if (!raw) return errorResponse(400, "bad_request", "unknown state");
  const flow = JSON.parse(raw) as FlowRecord;
  const oidc = await getOidcConfig(db, product.slug);
  if (!oidc?.issuer || !oidc.client_id) return errorResponse(500, "misconfigured", "no oidc config");
  // Defense in depth: the stored flow's redirect_uri must still be allow-listed.
  if (!redirectUriAllowed(oidc, flow.redirectUri)) {
    await env.HOT.delete(flowKey(product.slug, state));
    return errorResponse(400, "bad_request", "redirect_uri not allow-listed");
  }
  const clientSecret = oidc.client_secret_secret ? secret(env, oidc.client_secret_secret) : undefined;

  const tokenRes = await fetch(`${oidc.issuer.replace(/\/$/, "")}/api/oidc/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: flow.redirectUri,
      client_id: oidc.client_id,
      code_verifier: flow.verifier,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    }),
  });
  if (!tokenRes.ok) {
    // Delete the flow rather than recording a reason — pollers must not be able to
    // enumerate IdP failure modes (D8). The poll surface returns a generic error.
    await env.HOT.delete(flowKey(product.slug, state));
    return errorResponse(502, "oidc_error", "token exchange failed");
  }
  const tokens = (await tokenRes.json()) as { id_token?: string };
  if (!tokens.id_token) return errorResponse(502, "oidc_error", "no id_token");

  const jwks = createRemoteJWKSet(new URL(`${oidc.issuer.replace(/\/$/, "")}/.well-known/jwks.json`));
  let claims: Record<string, unknown>;
  try {
    const verified = await jwtVerify(tokens.id_token, jwks, {
      issuer: oidc.issuer,
      audience: oidc.client_id,
      algorithms: ALLOWED_ID_TOKEN_ALGS,
    });
    claims = verified.payload as Record<string, unknown>;
    // Reject unconditionally on a missing or mismatched nonce — a token with no nonce must
    // never satisfy the binding to this flow (replay / token-injection defense).
    if (typeof claims.nonce !== "string" || claims.nonce !== flow.nonce) throw new Error("nonce mismatch");
  } catch {
    await env.HOT.delete(flowKey(product.slug, state));
    return errorResponse(401, "unauthorized", "id token invalid");
  }

  const result = await enrollFromIdentity(db, product, mapClaims(claims), now);
  if ("error" in result) {
    // Failed enrollment: drop the flow so the poller gets a generic error, not the reason.
    await env.HOT.delete(flowKey(product.slug, state));
    return errorResponse(403, "forbidden", "not entitled");
  }
  flow.licenseId = result.licenseId;
  await env.HOT.put(flowKey(product.slug, state), JSON.stringify(flow), { expirationTtl: FLOW_TTL_SECONDS });
  return new Response(
    "<!doctype html><meta charset=utf-8><title>Signed in</title><body style=\"font-family:system-ui;padding:3rem;text-align:center\"><h1>You're signed in</h1><p>You can close this tab and return to the app.</p>",
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

/** GET /<product>/auth/poll?state=&machine= — return a token once the flow completes. */
export async function handleAuthPoll(req: Request, env: Env, db: Db, product: Product, now: number): Promise<Response> {
  const url = new URL(req.url);
  const state = url.searchParams.get("state");
  const machine = url.searchParams.get("machine");
  if (!state || !machine) return errorResponse(400, "bad_request", "missing state/machine");
  const raw = await env.HOT.get(flowKey(product.slug, state));
  if (!raw) return json({ status: "timeout" });
  const flow = JSON.parse(raw) as FlowRecord;
  // Generic error only — never echo an IdP failure reason a poller could enumerate (D8).
  if (flow.error) return json({ status: "error" });
  if (!flow.licenseId) return json({ status: "pending" });

  const token = await authorizeAndMint(env, db, product, flow.licenseId, machine, now);
  await env.HOT.delete(flowKey(product.slug, state));
  return json({ status: "ready", token, schemaVersion: product.schemaVersion });
}
