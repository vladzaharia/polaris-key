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
//
// P0-12 — a recipe is repo-authored (`.pkey/` `edgeMint[]`), so on its own it is NOT enough to
// mint. Two operator-held conditions must also hold, and neither can be set from a manifest:
//   1. the recipe's `signing_key_secret` names a product secret whose USAGE is `edge-mint`
//      (`openProductSecret(..., "edge-mint")`; a general secret reads as missing → 500
//      `misconfigured`), and
//   2. an `edge_mint_approvals` row equals the current recipe column for column, and — while
//      the mint is PUBLIC (`mintIsPublic`: effective registration `open`, or anonymous
//      auto-issue enrolment on) — records the operator's open-registration acknowledgement. No
//      approval, an approval of different values, or an approval given while the mint was closed
//      that a later push made public, answers exactly like an unknown recipe (404).

import type { Env, Db } from "../../core/platform.js";
import { bearer, staticHtmlSecurityHeaders } from "../../core/platform.js";
import { type Product, openProductSecret } from "../../core/products.js";
import type { RegistrationPolicy } from "../../core/services.js";
import {
  allowsAnonymousEnroll,
  type AutoIssuePolicy,
} from "../../core/fingerprint.js";
import { errorResponse } from "../../core/errors.js";
import { clientIp, rateLimitOk } from "../../core/rateLimit.js";
import { signJws } from "@polaris-key/jws";
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

/** The recipe row as the manifest last wrote it — approved or not. The `/auth` page and the
 *  console read this; the token route must use `getApprovedEdgeMintConfig`. */
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
 * Whether anyone at all can obtain the device token this route accepts — the condition under
 * which an approval must carry the operator's open-registration acknowledgement.
 *
 * Two product settings, both of which a `.pkey/product` push can change without touching the
 * recipe, make the mint public:
 *   - the EFFECTIVE registration is `open` (declared `devices.registration: open`, or License
 *     off with Identity off so the derived policy is open) — any installation registers; and
 *   - auto-issue allows anonymous enrolment (`mode` `anonymous` or `both`, enabled with a tier):
 *     `POST /<p>/license/enroll` hands any caller a licence and a device token with no key and
 *     no sign-in, while the effective registration still reads `requires-license`.
 * `oidcDefault` alone is not public: the caller must still sign in with the product's IdP.
 * Pass the resolved `Product`, never the declared manifest values.
 */
export function mintIsPublic(product: {
  registration: RegistrationPolicy;
  autoIssue: AutoIssuePolicy;
}): boolean {
  return (
    product.registration === "open" || allowsAnonymousEnroll(product.autoIssue)
  );
}

/**
 * The join condition that makes an approval apply: every security-relevant column of the
 * CURRENT recipe equals the approved value. `IS` rather than `=` so two NULLs (no kid, no
 * audience) compare equal. `auth_page_template` is deliberately absent: it does not change what
 * is signed, and the `/auth` page ships its own script-free policy.
 *
 * Whether the mint is public is the one input that is not a recipe column: it lives on the
 * product, and a push can open it without touching the recipe (see `mintIsPublic`). An approval
 * given while the mint was closed is not the operator's decision that ANYONE may mint, so while
 * `publicMint` holds the approval must also carry the acknowledgement. Pass
 * `mintIsPublic(product)`.
 */
export function approvalMatchesRecipe(publicMint: boolean): string {
  const columns = `a.product = c.product AND a.id = c.id
   AND a.alg IS c.alg
   AND a.signing_key_secret IS c.signing_key_secret
   AND a.kid IS c.kid
   AND a.claims_template_json IS c.claims_template_json
   AND a.ttl_seconds IS c.ttl_seconds
   AND a.audience IS c.audience`;
  return publicMint
    ? `${columns}
   AND a.open_registration_acknowledged = 1`
    : columns;
}

/** The recipe row, but ONLY when an operator approved exactly these values, with the
 *  acknowledgement if the mint is public now (P0-12). `publicMint` is `mintIsPublic(product)`. */
export async function getApprovedEdgeMintConfig(
  db: Db,
  product: string,
  id: string,
  publicMint: boolean,
): Promise<EdgeMintRow | null> {
  return db.first<EdgeMintRow>(
    `SELECT c.* FROM edge_mint_config c
       JOIN edge_mint_approvals a ON ${approvalMatchesRecipe(publicMint)}
      WHERE c.product = ? AND c.id = ?`,
    product,
    id,
  );
}

/** Whether this product has ANY approved edge-mint recipe — the capability bit the discovery
 *  fragment publishes. A product whose every recipe is pending or changed says `false`: there
 *  is nothing a client could mint. Deliberately not the id list: see
 *  `configService.discoveryFragment`. */
export async function hasApprovedEdgeMintRecipes(
  db: Db,
  product: string,
  publicMint: boolean,
): Promise<boolean> {
  const row = await db.first<{ id: string }>(
    `SELECT c.id FROM edge_mint_config c
       JOIN edge_mint_approvals a ON ${approvalMatchesRecipe(publicMint)}
      WHERE c.product = ? LIMIT 1`,
    product,
  );
  return row !== null;
}

/** Per-device mint budget, on top of the per-IP one. */
const MINT_DEVICE_LIMIT = { limit: 30, windowSec: 60 } as const;

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
  // Confused-deputy guard: the caller must be a device of THIS product, and — when the product
  // runs License — one whose licence is usable. Asked with Core's pure `licenseUsable` predicate
  // rather than by importing License: a service may not import another service, and the boundary
  // is not worth spending on a two-line check.
  //
  // For a licensed product this is byte-identical to what `validateDeviceToken` used to apply on
  // this handler's behalf before the split (`services/license/auth.ts`). The scope — "iff the
  // License service is enabled", the same rule Core's own `/devices` and `/devices/report` use —
  // is what makes edge minting reachable at all for a config-only product (D-08): its devices
  // register, hold real `pkeyt_` tokens, and have no licence to be licensed by. Edge minting is
  // how a catalog secret with `delivery: "edgeMint"` reaches a runtime, so a Config service that
  // could not mint would be Config with a hole in it.
  const token = bearer(req);
  if (!token) return errorResponse(401, "unauthorized");
  const valid = await validateDeviceToken(env, db, product, token, now);
  if ("error" in valid) return errorResponse(401, "unauthorized");
  if (product.services.license.enabled && !licenseUsable(valid.license, now))
    return errorResponse(401, "unauthorized");

  // P0-12 — a per-DEVICE budget as well as the per-IP one. Under open registration anyone can
  // hold a device token, and one device behind many IPs would otherwise get a fresh 60/min per
  // address. Counted after authentication (an unauthenticated caller has no device id to key
  // on) and before the recipe lookup, so probing recipe ids spends the same budget as minting.
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      {
        bucket: "mintDevice",
        id: valid.device.device_id,
        ...MINT_DEVICE_LIMIT,
      },
      now,
    ))
  ) {
    return errorResponse(429, "rate_limited", "too many mint requests");
  }

  // Unknown, never approved, and approved-but-since-changed are ONE answer: the device-facing
  // contract says 404 means "not available", and an unapproved recipe must not be
  // distinguishable from a missing one. "Changed" includes the mint becoming public (registration
  // opened, or anonymous enrolment turned on) after an approval that did not acknowledge it —
  // re-checked here on every request, because a push can do either without touching the recipe.
  const cfg = await getApprovedEdgeMintConfig(
    db,
    product.slug,
    mintId,
    mintIsPublic(product),
  );
  if (!cfg) return errorResponse(404, "not_found", "no such edge-mint recipe");
  if (cfg.alg !== "ES256" && cfg.alg !== "RS256" && cfg.alg !== "EdDSA") {
    return errorResponse(500, "misconfigured", `unsupported alg ${cfg.alg}`);
  }
  // Key material is KEK-custodied: `signing_key_secret` is now a product_secrets NAME, not a
  // worker secret. Missing/unopenable ⇒ misconfigured (fail closed — never an unsigned token).
  // P0-12: only a secret an operator marked `edge-mint` opens here; a general secret (the OIDC
  // client secret, anything else a recipe happens to name) reads as missing.
  const pem = await openProductSecret(
    db,
    env,
    product.slug,
    cfg.signing_key_secret,
    "edge-mint",
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
      // @polaris-key/jws emits a compact JWS with header {alg:"EdDSA", kid}.
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
