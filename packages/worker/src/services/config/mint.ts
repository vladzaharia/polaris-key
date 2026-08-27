/// <reference types="@cloudflare/workers-types" />

// Generic edge token minting. A product declares a recipe (alg, key material as a sealed
// product_secrets NAME, a claims template, ttl, optional trusted `audience`, optional auth
// page); the worker stamps iat/exp + the trusted aud from the allowlisted template and
// signs. Apple MusicKit's ES256 developer token is the first instance; RS256 and EdDSA are
// also supported. Reserved claims (iat/exp/nbf/aud) are server/recipe-controlled; the caller
// must hold a valid licensed token (confused-deputy guard).
//
// Moved from `src/edgeMint.ts` to `/<p>/config/mint/:id/{token,auth}` (D-19): edge minting is
// how a catalog SECRET with `delivery: "edgeMint"` actually reaches a runtime, so it belongs
// with the service that owns the catalog rather than sitting at the product root.

import type { Env, Db } from "../../core/platform.js";
import { bearer, staticHtmlSecurityHeaders } from "../../core/platform.js";
import { type Product, openProductSecret } from "../../core/products.js";
import { errorResponse } from "../../core/errors.js";
import { clientIp, rateLimitOk } from "../../core/rateLimit.js";
import { signJws } from "@plrs/jws";
import { licenseUsable, validateDeviceToken } from "../../core/devices.js";

interface EdgeMintRow {
  product: string;
  id: string;
  alg: string;
  signing_key_secret: string;
  kid: string | null;
  claims_template_json: string | null;
  ttl_seconds: number;
  /** Trusted JWT `aud` — server-controlled, NOT overridable from the free template. */
  audience: string | null;
  auth_page_template: string | null;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const b64urlStr = (s: string): string => b64url(new TextEncoder().encode(s));
function toAB(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(
    b.byteOffset,
    b.byteOffset + b.byteLength,
  ) as ArrayBuffer;
}
/** Strip PEM armor + whitespace and decode the base64 body to raw DER bytes. */
function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Build a DER tag+length prefix (definite form) for a body of `n` bytes. */
function derLen(tag: number, n: number): number[] {
  if (n < 0x80) return [tag, n];
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return [tag, 0x80 | bytes.length, ...bytes];
}

/**
 * RSA private keys may arrive as PKCS#1 (`BEGIN RSA PRIVATE KEY`); WebCrypto only imports
 * PKCS#8, so wrap PKCS#1 DER in the PKCS#8 PrivateKeyInfo envelope (the fixed rsaEncryption
 * AlgorithmIdentifier prefix). Pass an existing PKCS#8 (`BEGIN PRIVATE KEY`) through as-is.
 * Mirrors release/githubApp.ts `toPkcs8`.
 */
function rsaToPkcs8(pem: string): ArrayBuffer {
  const der = pemToDer(pem);
  if (/BEGIN PRIVATE KEY/.test(pem)) return toAB(der);
  // PKCS#8 = SEQUENCE { version 0, AlgorithmIdentifier rsaEncryption NULL, OCTET STRING pkcs1 }
  const rsaOid = [
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00,
  ];
  const version = [0x02, 0x01, 0x00];
  const octetHeader = derLen(0x04, der.length);
  const inner = [...version, ...rsaOid, ...octetHeader, ...der];
  const seq = [...derLen(0x30, inner.length), ...inner];
  return toAB(Uint8Array.from(seq));
}

/** Sign an ES256 (ECDSA P-256) JWT — WebCrypto returns the raw r||s that JWS ES256 wants. */
async function signEs256(
  payload: Record<string, unknown>,
  pem: string,
  kid?: string,
): Promise<string> {
  const header = { alg: "ES256", typ: "JWT", ...(kid ? { kid } : {}) };
  const signingInput =
    b64urlStr(JSON.stringify(header)) +
    "." +
    b64urlStr(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    toAB(pemToDer(pem)),
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

/** Sign an RS256 (RSASSA-PKCS1-v1_5 / SHA-256) JWT. Accepts PKCS#1 or PKCS#8 PEM. */
async function signRs256(
  payload: Record<string, unknown>,
  pem: string,
  kid?: string,
): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", ...(kid ? { kid } : {}) };
  const signingInput =
    b64urlStr(JSON.stringify(header)) +
    "." +
    b64urlStr(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    rsaToPkcs8(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    toAB(new TextEncoder().encode(signingInput)),
  );
  return signingInput + "." + b64url(new Uint8Array(sig));
}

export async function getEdgeMintConfig(
  db: Db,
  product: string,
  id: string,
): Promise<EdgeMintRow | null> {
  return db.first<EdgeMintRow>(
    "SELECT * FROM edge_mint_config WHERE product = ? AND id = ?",
    product,
    id,
  );
}

/**
 * Strip server/recipe-controlled claims from a parsed template so the free-form template can
 * never override them. We drop:
 *   - `iat`/`exp`/`nbf` — server-stamped from `now` + the recipe's `ttl_seconds`.
 *   - `aud` — the trusted `audience` column owns this (a template `aud` is ignored entirely).
 * We deliberately KEEP `iss`: there is no `iss` recipe column, and Apple MusicKit's recipe
 * legitimately sets `iss` (the developer team id) via the template. So the rule is:
 *   template MAY set `iss` (and arbitrary non-reserved claims), but NOT `iat`/`exp`/`nbf`/`aud`.
 */
function sanitizeTemplate(t: Record<string, unknown>): Record<string, unknown> {
  const { iat: _iat, exp: _exp, nbf: _nbf, aud: _aud, ...rest } = t;
  return rest;
}

/** POST/GET /<product>/config/mint/<id>/token — mint an edge token for the recipe. */
export async function handleMintToken(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  mintId: string,
  now: number,
): Promise<Response> {
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { bucket: "mint", id: clientIp(req), limit: 60, windowSec: 60 },
      now,
    ))
  ) {
    return errorResponse(429, "rate_limited", "too many mint requests");
  }
  // Confused-deputy guard: only a LICENSED device may mint. This is the one place inside the
  // config service that still asks a licence question, and it is asked with Core's pure
  // `licenseUsable` predicate rather than by importing License — a service may not import
  // another service, and the boundary is not worth spending on a two-line check.
  //
  // The check is byte-identical to what `validateDeviceToken` used to apply on this handler's
  // behalf before the split (`services/license/auth.ts`). Its consequence for a config-only
  // product (D-08) is honest and known: with no licence there is nothing to be licensed by, so
  // edge minting is unavailable until device registration lands (T1.5) and this guard can be
  // restated as "a registered device of this product".
  const token = bearer(req);
  if (!token) return errorResponse(401, "unauthorized");
  const valid = await validateDeviceToken(env, db, product, token, now);
  if ("error" in valid || !licenseUsable(valid.license, now))
    return errorResponse(401, "unauthorized");

  const cfg = await getEdgeMintConfig(db, product.slug, mintId);
  if (!cfg) return errorResponse(404, "not_found", "no such edge-mint recipe");
  if (cfg.alg !== "ES256" && cfg.alg !== "RS256" && cfg.alg !== "EdDSA") {
    return errorResponse(500, "misconfigured", `unsupported alg ${cfg.alg}`);
  }
  // Key material is KEK-custodied: `signing_key_secret` is now a product_secrets NAME, not a
  // worker secret. Missing/unopenable ⇒ misconfigured (fail closed — never an unsigned token).
  const pem = await openProductSecret(
    db,
    env,
    product.slug,
    cfg.signing_key_secret,
  );
  if (!pem) return errorResponse(500, "misconfigured", "missing mint key");

  // R11-06: an unguarded parse of a DB column turned a corrupt `claims_template_json` into an
  // uncaught SyntaxError — a 500 with no diagnosis. Fail CLOSED with the same `misconfigured`
  // shape the rest of this handler uses: silently minting a token with an EMPTY template
  // would drop operator-set claims (`iss`, scopes, tenant) that the recipient may be relying
  // on, which is worse than refusing.
  let template: Record<string, unknown>;
  try {
    template = cfg.claims_template_json
      ? (JSON.parse(cfg.claims_template_json) as Record<string, unknown>)
      : {};
  } catch {
    return errorResponse(
      500,
      "misconfigured",
      "mint claims template is not valid JSON",
    );
  }
  // Reserved claims are server/recipe-controlled and not overridable from the template:
  // sanitize first (drops iat/exp/nbf/aud) then stamp server iat/exp + the trusted `aud`.
  const claims: Record<string, unknown> = {
    ...sanitizeTemplate(template),
    iat: now,
    exp: now + cfg.ttl_seconds,
    ...(cfg.audience ? { aud: cfg.audience } : {}),
  };
  const kid = cfg.kid ?? undefined;
  let minted: string;
  switch (cfg.alg) {
    case "ES256":
      minted = await signEs256(claims, pem, kid);
      break;
    case "RS256":
      minted = await signRs256(claims, pem, kid);
      break;
    case "EdDSA":
      // @plrs/jws emits a compact JWS with header {alg:"EdDSA", kid}.
      minted = await signJws(claims, pem, kid ?? "");
      break;
    default:
      return errorResponse(500, "misconfigured", `unsupported alg ${cfg.alg}`);
  }
  return new Response(
    JSON.stringify({ token: minted, expiresAt: claims.exp }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    },
  );
}

/**
 * GET /<product>/config/mint/<id>/auth — serve the recipe's HTML auth page (e.g. MusicKit JS).
 *
 * `auth_page_template` is operator-supplied HTML rendered verbatim on the platform origin,
 * i.e. a script-execution primitive pointed at the admin cookie (R1-05 + R1-09). It ships
 * with the strict script-free policy: `default-src 'none'` means an injected `<script>`
 * cannot run and an injected `fetch("/manage/api/me")` cannot connect. If this page is ever
 * genuinely wired up to run MusicKit JS, it needs its OWN explicit allowlist here (and a
 * separate sandbox origin) — do not relax this policy globally.
 */
export async function handleMintAuth(
  db: Db,
  product: Product,
  mintId: string,
): Promise<Response> {
  const cfg = await getEdgeMintConfig(db, product.slug, mintId);
  if (!cfg || !cfg.auth_page_template)
    return errorResponse(404, "not_found", "no auth page");
  return new Response(cfg.auth_page_template, {
    status: 200,
    headers: staticHtmlSecurityHeaders(
      new Headers({
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      }),
    ),
  });
}
