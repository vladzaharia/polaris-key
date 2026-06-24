/// <reference types="@cloudflare/workers-types" />

// Generic edge token minting. A product declares a recipe (alg, key material as a Worker
// secret, a claims template, ttl, optional auth page); the worker stamps iat/exp from the
// allowlisted template and signs. Apple MusicKit's ES256 developer token is the first
// instance. Reserved claims (iat/exp) are server-set; the caller must hold a valid
// licensed token (confused-deputy guard).

import { type Env, secret } from "./env.js";
import type { Db } from "./db/types.js";
import type { Product } from "./product.js";
import { bearer, errorResponse } from "./http.js";
import { hashKey } from "./crypto.js";
import { getTokenRecord } from "./kv.js";
import { clientIp, rateLimitOk } from "./rateLimit.js";

interface EdgeMintRow {
  product: string;
  id: string;
  alg: string;
  signing_key_secret: string;
  kid: string | null;
  claims_template_json: string | null;
  ttl_seconds: number;
  auth_page_template: string | null;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const b64urlStr = (s: string): string => b64url(new TextEncoder().encode(s));
function toAB(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}
function pemToPkcs8(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Sign an ES256 (ECDSA P-256) JWT — WebCrypto returns the raw r||s that JWS ES256 wants. */
async function signEs256(payload: Record<string, unknown>, pem: string, kid?: string): Promise<string> {
  const header = { alg: "ES256", typ: "JWT", ...(kid ? { kid } : {}) };
  const signingInput = b64urlStr(JSON.stringify(header)) + "." + b64urlStr(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    toAB(pemToPkcs8(pem)),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    toAB(new TextEncoder().encode(signingInput)),
  );
  return signingInput + "." + b64url(new Uint8Array(sig));
}

export async function getEdgeMintConfig(db: Db, product: string, id: string): Promise<EdgeMintRow | null> {
  return db.first<EdgeMintRow>("SELECT * FROM edge_mint_config WHERE product = ? AND id = ?", product, id);
}

/**
 * Strip the server-time claims (`iat`/`exp`/`nbf`) from a parsed template so a recipe can
 * never override the values the worker stamps below. We deliberately KEEP `iss`/`aud`:
 * Apple MusicKit's recipe legitimately sets `iss` (the team id) via the template, and the
 * `aud`/`iss` trusted-column design lands in a later phase.
 *
 * TODO(P4.5): move `iss`/`aud` out of the free-form template into trusted recipe columns
 * so they too become server-controlled rather than template-supplied.
 */
function sanitizeTemplate(t: Record<string, unknown>): Record<string, unknown> {
  const { iat: _iat, exp: _exp, nbf: _nbf, ...rest } = t;
  return rest;
}

/** POST/GET /<product>/mint/<id>/token — mint an edge token for the recipe. */
export async function handleMintToken(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  mintId: string,
  now: number,
): Promise<Response> {
  if (!(await rateLimitOk(env, product.slug, { bucket: "mint", id: clientIp(req), limit: 60, windowSec: 60 }, now))) {
    return errorResponse(429, "rate_limited", "too many mint requests");
  }
  // Confused-deputy guard: only a licensed machine may mint.
  const token = bearer(req);
  if (!token) return errorResponse(401, "unauthorized");
  const rec = await getTokenRecord(env, product.slug, await hashKey(token, env.KEY_HASH_PEPPER));
  if (!rec) return errorResponse(401, "unauthorized");

  const cfg = await getEdgeMintConfig(db, product.slug, mintId);
  if (!cfg) return errorResponse(404, "not_found", "no such edge-mint recipe");
  if (cfg.alg !== "ES256") return errorResponse(500, "misconfigured", `unsupported alg ${cfg.alg}`);
  const pem = secret(env, cfg.signing_key_secret);
  if (!pem) return errorResponse(500, "misconfigured", "missing mint key");

  const template = cfg.claims_template_json
    ? (JSON.parse(cfg.claims_template_json) as Record<string, unknown>)
    : {};
  // Reserved claims are server-set and not overridable from the template: sanitize first
  // so any template-supplied iat/exp/nbf is dropped before the server values are stamped.
  const claims: Record<string, unknown> = { ...sanitizeTemplate(template), iat: now, exp: now + cfg.ttl_seconds };
  const minted = await signEs256(claims, pem, cfg.kid ?? undefined);
  return new Response(JSON.stringify({ token: minted, expiresAt: claims.exp }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** GET /<product>/mint/<id>/auth — serve the recipe's HTML auth page (e.g. MusicKit JS). */
export async function handleMintAuth(db: Db, product: Product, mintId: string): Promise<Response> {
  const cfg = await getEdgeMintConfig(db, product.slug, mintId);
  if (!cfg || !cfg.auth_page_template) return errorResponse(404, "not_found", "no auth page");
  return new Response(cfg.auth_page_template, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
