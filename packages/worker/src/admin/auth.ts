/**
 * Interactive admin sign-in (browser, cookie-based) — distinct from the SDK/CLI OIDC
 * activation in `../services/identity/oidc.ts` (which mints license tokens). Here we just prove
 * an operator's identity + groups and drop a signed session cookie.
 *
 * - `GET /manage/login`     -> 302 to the IdP authorize endpoint (PKCE, state in KV).
 * - `GET /manage/callback`  -> exchange the code, verify the ID token, gate on a platform
 *                             OR product admin group, set the session cookie, 302 to /manage/.
 *
 * The token-exchange + ID-token verification is delegated to an injectable `IdTokenVerifier`
 * so tests can drive the flow without a live IdP (production wires the jose-backed verifier).
 * The platform IdP config comes from env vars (ADMIN_OIDC_*), keeping admin auth independent
 * of any single product's OIDC client.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import { hashKey } from "../crypto.js";
import { clientIp, rateLimitOk } from "../core/rateLimit.js";
import { platformOidcConfig } from "../platformOidc.js";
import { brandedHtmlSecurityHeaders } from "../securityHeaders.js";
import { escapeHtml, renderBrandPage } from "../core/brandHtml.js";
import { hasAnyAdminGrant } from "./authz.js";
import {
  buildSessionCookie,
  issueSession,
  type SessionIdentity,
} from "./session.js";

const FLOW_TTL_SECONDS = 600;
const ADMIN_FLOW_PREFIX = "admin:flow:";

/**
 * KV key for an in-flight admin sign-in.
 *
 * R12-04: the `state` used to be the key name verbatim, so anyone who could list the HOT
 * namespace read live OIDC `state` values straight out of the key names — a credential dump
 * from metadata alone, with the PKCE `verifier` sitting in the value next to it. Hashing under
 * `KEY_HASH_PEPPER` makes the listing inert: a key name is no longer a usable `state`, and
 * without the pepper it cannot be reversed into one. Matches what `kv.ts` (device tokens) and
 * identity's browser session (download tokens) already do.
 */
async function adminFlowKey(state: string, env: Env): Promise<string> {
  return `${ADMIN_FLOW_PREFIX}${await hashKey(state, env.KEY_HASH_PEPPER)}`;
}

interface FlowRecord {
  verifier: string;
  nonce: string;
  redirectUri: string;
  /** Validated same-origin path to land on after the callback (see `sanitizeReturnTo`). */
  returnTo?: string;
}

/**
 * Where a sign-in may land after the callback. Default (and the fallback for anything
 * suspicious) is the console itself; the only other destination is the gated docs site,
 * which is what introduced `returnTo` in the first place (docs plan N7 — an unauthenticated
 * `/docs/...` hit redirects through `/manage/login` and should come back to the page it
 * wanted, not the console home).
 *
 * The validator is deliberately an allowlist, not an escape:
 *   - must start with `/docs` or `/manage` as a whole segment (no `/docsevil`),
 *   - conservative path charset only — no `\`, `%`, `?`, `#`, whitespace or control chars,
 *     so the value cannot smuggle a scheme, a query, a fragment, or a header break,
 *   - no `//` anywhere (kills protocol-relative URLs and empty segments),
 *   - no `.`/`..` segments,
 *   - bounded length.
 * The value is carried inside the KV flow record — bound to the OIDC `state`, never
 * round-tripped through the client — and re-validated when read back (defense in depth
 * against a poisoned record).
 */
const RETURN_TO_MAX_LENGTH = 512;
const RETURN_TO_RE = /^\/(?:docs|manage)(?:\/[A-Za-z0-9\-._~/]*)?$/;

export function sanitizeReturnTo(raw: string | null): string | null {
  if (!raw || raw.length > RETURN_TO_MAX_LENGTH) return null;
  if (!RETURN_TO_RE.test(raw)) return null;
  if (raw.includes("//")) return null;
  if (raw.split("/").some((seg) => seg === "." || seg === "..")) return null;
  return raw;
}

/** Resolved verified claims from an ID token. */
export interface IdTokenVerifier {
  /** Exchange `code` + verify the resulting ID token; return mapped claims or null. */
  verify(input: {
    code: string;
    flow: FlowRecord;
    env: Env;
  }): Promise<SessionIdentity | null>;
}

// ── base64url / PKCE ──────────────────────────────────────────────────────────
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

function mapClaims(payload: Record<string, unknown>): SessionIdentity {
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
  };
}

/** The production verifier: token exchange against the IdP + jose JWKS verification. */
const joseIdTokenVerifier: IdTokenVerifier = {
  async verify({ code, flow, env }) {
    const cfg = platformOidcConfig(env);
    if (!cfg) return null;
    const tokenRes = await fetch(
      `${cfg.issuer.replace(/\/$/, "")}/api/oidc/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: flow.redirectUri,
          client_id: cfg.clientId,
          code_verifier: flow.verifier,
          ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}),
        }),
      },
    );
    if (!tokenRes.ok) return null;
    const tokens = (await tokenRes.json()) as { id_token?: string };
    if (!tokens.id_token) return null;
    const jwks = createRemoteJWKSet(
      new URL(`${cfg.issuer.replace(/\/$/, "")}/.well-known/jwks.json`),
    );
    try {
      const verified = await jwtVerify(tokens.id_token, jwks, {
        issuer: cfg.issuer,
        audience: cfg.clientId,
        algorithms: ["RS256", "ES256", "EdDSA"],
      });
      const claims = verified.payload as Record<string, unknown>;
      // Reject unconditionally on a missing or mismatched nonce — a token with no nonce
      // must never satisfy the binding to this flow (replay / token-injection defense).
      if (typeof claims.nonce !== "string" || claims.nonce !== flow.nonce)
        return null;
      return mapClaims(claims);
    } catch {
      return null;
    }
  },
};

// ── handlers ──────────────────────────────────────────────────────────────────
/** A sign-in error page. HTML on the admin origin, so it carries the strict script-free CSP
 *  (R1-09): every message here is a hard-coded literal today, and it is escaped anyway, so this
 *  page can never become a script-execution primitive if that changes. */
function htmlError(status: number, message: string): Response {
  // A retry can help with an expired, unverified or rate-limited attempt; it cannot fix a
  // missing configuration (500) or a missing admin grant (403).
  const retry = status === 400 || status === 401 || status === 429;
  return new Response(
    renderBrandPage({
      title: "Console sign-in",
      eyebrow: "Polaris Key console",
      heading: message,
      body: retry
        ? `<p class="actions"><a class="button" href="${escapeHtml("/manage/login")}">Sign in again</a></p>`
        : "",
    }),
    {
      status,
      headers: brandedHtmlSecurityHeaders(
        new Headers({
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        }),
      ),
    },
  );
}

/** GET /manage/login — start PKCE + redirect to the IdP authorize endpoint. */
export async function handleAdminLogin(
  req: Request,
  env: Env,
): Promise<Response> {
  const ok = await rateLimitOk(
    env,
    "_admin",
    { bucket: "adminLogin", id: clientIp(req), limit: 20, windowSec: 60 },
    Math.floor(Date.now() / 1000),
  );
  if (!ok)
    return htmlError(
      429,
      "Too many sign-in attempts. Please wait and try again.",
    );
  const cfg = platformOidcConfig(env);
  if (!cfg) return htmlError(500, "Admin sign-in is not configured.");
  const state = b64url(randomBytes(16));
  const nonce = b64url(randomBytes(16));
  const { verifier, challenge } = await pkce();
  const url = new URL(req.url);
  const redirectUri = `${url.origin}/manage/callback`;
  const returnTo = sanitizeReturnTo(url.searchParams.get("returnTo"));
  const flow: FlowRecord = {
    verifier,
    nonce,
    redirectUri,
    ...(returnTo ? { returnTo } : {}),
  };
  await env.HOT.put(await adminFlowKey(state, env), JSON.stringify(flow), {
    expirationTtl: FLOW_TTL_SECONDS,
  });

  const authorize = new URL(`${cfg.issuer.replace(/\/$/, "")}/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", cfg.clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", "openid email profile groups");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("nonce", nonce);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  return new Response(null, {
    status: 302,
    headers: { location: authorize.toString() },
  });
}

/** GET /manage/callback — verify, gate on an admin group, set the session cookie. */
export async function handleAdminCallback(
  req: Request,
  env: Env,
  db: Db,
  now: number,
  verifier: IdTokenVerifier = joseIdTokenVerifier,
): Promise<Response> {
  const ok = await rateLimitOk(
    env,
    "_admin",
    { bucket: "adminCallback", id: clientIp(req), limit: 20, windowSec: 60 },
    Math.floor(Date.now() / 1000),
  );
  if (!ok)
    return htmlError(
      429,
      "Too many sign-in attempts. Please wait and try again.",
    );
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return htmlError(400, "Missing authorization code.");
  const flowKey = await adminFlowKey(state, env);
  const raw = await env.HOT.get(flowKey);
  if (!raw) return htmlError(400, "This sign-in link has expired. Try again.");
  let flow: FlowRecord;
  try {
    flow = JSON.parse(raw) as FlowRecord;
  } catch {
    await env.HOT.delete(flowKey);
    return htmlError(400, "This sign-in link has expired. Try again.");
  }
  await env.HOT.delete(flowKey);

  const identity = await verifier.verify({ code, flow, env });
  if (!identity || !identity.sub)
    return htmlError(401, "Sign-in could not be verified.");

  // Admin authority is platform-wide, so the gate needs no product list — the `listProducts`
  // read that used to feed the (ignored) `_products` parameter is gone.
  if (!hasAnyAdminGrant(env, identity.groups)) {
    return htmlError(
      403,
      "Your account is not an administrator of any product.",
    );
  }

  const { token } = await issueSession(env, identity, now);
  // Re-validated on read: the flow record is server-written, but a defense-in-depth re-check
  // costs nothing and keeps "the callback only ever redirects to an allowlisted path" a local
  // property of this function rather than a cross-file invariant.
  const location = sanitizeReturnTo(flow.returnTo ?? null) ?? "/manage/";
  return new Response(null, {
    status: 302,
    headers: { location, "set-cookie": buildSessionCookie(token) },
  });
}
