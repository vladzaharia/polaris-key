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
//   2. an `edge_mint_approvals` row APPLIES to the recipe as the product stands now
//      (`approvalMismatch` is empty): it equals the current recipe column for column; while the
//      mint is PUBLIC (`mintIsPublic`: open registration, anonymous enrolment, or an OIDC
//      default tier) it records the operator's open-registration acknowledgement; if it was
//      given with License on, License is still on (the licence check below runs only then); and
//      while Identity is on it recorded the same identity provider, issuer, client id and group
//      map the product trusts now. A push can change every one of those product settings
//      without touching the recipe, so all of them are re-checked on every request — and the
//      manifest ingest DELETES an approval a push widened, so reverting the push cannot revive
//      it (`invalidateWidenedEdgeMintApprovals`, core/edgeMintApproval.ts). No approval, or one
//      that no longer applies, answers exactly like an unknown recipe (404).

import type { Env, Db } from "../../core/platform.js";
import { bearer, staticHtmlSecurityHeaders } from "../../core/platform.js";
import { type Product, openProductSecret } from "../../core/products.js";
import {
  approvalMismatch,
  mintApprovalBasis,
  type MintApprovalRow,
  type MintPolicyProduct,
} from "../../core/edgeMintApproval.js";
import { errorResponse } from "../../core/errors.js";
import { clientIp, rateLimitOk } from "../../core/rateLimit.js";
import { signJws, StrictJsonError } from "@polaris-key/jws";
import { licenseUsable, validateDeviceToken } from "../../core/devices.js";
import { signJwtEs256, signJwtRs256 } from "../../core/jwt.js";

export interface EdgeMintRow {
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

// The approval rule itself lives in Core (`core/edgeMintApproval.ts`) because the manifest
// ingest must run it on the state it writes (a service may not import another service). It is
// re-exported here so Config's callers keep one import site.
export {
  approvalMismatch,
  differingRecipeFields,
  MINT_RECIPE_FIELDS,
  mintApprovalBasis,
  mintIsPublic,
  productWidening,
  type MintApprovalBasis,
  type MintApprovalRow,
  type MintMismatch,
  type MintPolicyProduct,
  type MintRecipeFields,
  type MintRecipeWireField,
  type MintWidening,
} from "../../core/edgeMintApproval.js";

/** The recipe row, but ONLY when an operator's approval applies to it as the product stands now
 *  (`approvalMismatch` is empty). */
export async function getApprovedEdgeMintConfig(
  db: Db,
  product: MintPolicyProduct,
  id: string,
): Promise<EdgeMintRow | null> {
  const cfg = await getEdgeMintConfig(db, product.slug, id);
  if (!cfg) return null;
  const approval = await db.first<MintApprovalRow>(
    "SELECT * FROM edge_mint_approvals WHERE product = ? AND id = ?",
    product.slug,
    id,
  );
  if (!approval) return null;
  const basis = await mintApprovalBasis(db, product);
  return approvalMismatch(cfg, approval, basis).length === 0 ? cfg : null;
}

/** Every recipe of the product with its approval (or null), in id order. */
export async function listEdgeMintRecipesWithApprovals(
  db: Db,
  slug: string,
): Promise<Array<{ recipe: EdgeMintRow; approval: MintApprovalRow | null }>> {
  const recipes = await db.all<EdgeMintRow>(
    "SELECT * FROM edge_mint_config WHERE product = ? ORDER BY id",
    slug,
  );
  const approvals = await db.all<MintApprovalRow>(
    "SELECT * FROM edge_mint_approvals WHERE product = ?",
    slug,
  );
  const byId = new Map(approvals.map((a) => [a.id, a]));
  return recipes.map((recipe) => ({
    recipe,
    approval: byId.get(recipe.id) ?? null,
  }));
}

/** Whether this product has ANY approved edge-mint recipe — the capability bit the discovery
 *  fragment publishes. A product whose every recipe is pending or changed says `false`: there
 *  is nothing a client could mint. Deliberately not the id list: see
 *  `configService.discoveryFragment`. */
export async function hasApprovedEdgeMintRecipes(
  db: Db,
  product: MintPolicyProduct,
): Promise<boolean> {
  const rows = await listEdgeMintRecipesWithApprovals(db, product.slug);
  if (!rows.some((r) => r.approval !== null)) return false;
  const basis = await mintApprovalBasis(db, product);
  return rows.some(
    ({ recipe, approval }) =>
      approval !== null &&
      approvalMismatch(recipe, approval, basis).length === 0,
  );
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
  // distinguishable from a missing one. "Changed" includes the product changing under the
  // approval — the mint becoming public without the acknowledgement, License being turned off,
  // or sign-in trusting a different identity provider or group map — re-checked here on every
  // request, because a push can do any of them without touching the recipe.
  const cfg = await getApprovedEdgeMintConfig(db, product, mintId);
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
      minted = await signJwtEs256(claims, pem, kid);
      break;
    case "RS256":
      minted = await signJwtRs256(claims, pem, kid);
      break;
    case "EdDSA":
      // @polaris-key/jws emits a compact JWS with header {alg:"EdDSA", kid}. Its signer guard
      // refuses claims a strict verifier would refuse (plans/P3-01.md §2.2); the manifest
      // validator refuses such a claims template at sync, so only a template stored before it
      // reaches here, and it answers in this route's flat body, never as a throw.
      try {
        minted = await signJws(claims, pem, kid ?? "");
      } catch (e) {
        if (!(e instanceof StrictJsonError)) throw e;
        return errorResponse(
          500,
          "document_not_representable",
          "the mint's claims break the wire contract's strict JSON rules",
        );
      }
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
