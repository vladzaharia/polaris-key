/// <reference types="@cloudflare/workers-types" />

// Generic edge token minting. A product declares a recipe (alg, key material as a sealed
// product_secrets NAME, a claims template, ttl, optional trusted `audience`, optional auth
// page); the worker stamps iat/exp + the trusted aud from the allowlisted template and
// signs. Apple MusicKit's ES256 developer token is the first instance; RS256 and EdDSA are
// also supported. Reserved claims (iat/exp/nbf/aud) are server/recipe-controlled; the caller
// must present a valid device token, and the recipe's own `requires` / `required_entitlement`
// decide which callers may mint it (confused-deputy guard, `authorizeMint`).
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
//
// A recipe also says WHO may mint it. `requires` (`none` | `registered` | `licensed`, default
// `licensed`) is the caller class it demands, and `required_entitlement` optionally names a
// catalog flag the caller's merged payload must carry, truthy. Both are recipe columns, so the
// approval binds them too: a push that relaxes either leaves the recipe inert until an operator
// approves it again (`MINT_RECIPE_FIELDS`).

import type { Env } from "../../platform/env.js";
import type { Db } from "../../db/types.js";
import { bearer } from "../../platform/http.js";
import { staticHtmlSecurityHeaders } from "../../core/securityHeaders.js";
import { type Product, openProductSecret } from "../../core/products.js";
import {
  approvalMismatch,
  mintApprovalBasis,
  type MintApprovalRow,
  type MintPolicyProduct,
} from "../../core/edgeMintApproval.js";
import { errorResponse } from "../../core/errors.js";
import { clientNetwork, rateLimitOk } from "../../core/rateLimit.js";
import { signJws, StrictJsonError } from "@polaris-key/jws";
import {
  licenseUsable,
  validateDeviceToken,
  type ValidDeviceToken,
} from "../../core/devices.js";
import { trustRefusal } from "../../core/trust/deviceTrust.js";
import { signJwtEs256, signJwtRs256 } from "../../core/jwt.js";
import { resolveMergedPayload } from "../../core/licensing/payload.js";
import {
  injectAdminPolicy,
  tighterMax,
  tighterMin,
} from "../../core/licensing/entitlements.js";

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
  /** Who may mint this recipe: `none`, `registered` or `licensed` (migration 0117; CHECKed). */
  requires: string;
  /** A catalog flag the caller's merged payload must carry, truthy. NULL: no such demand. */
  required_entitlement: string | null;
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

/**
 * Per-recipe authorization: the gate between "who is calling" and "may they mint THIS".
 *
 * The route authenticates a device of the product and, while the product runs License, used to
 * ask one product-wide question, "is its licence usable", on behalf of every recipe at once. A
 * recipe could therefore say nothing about its callers, and two shapes minted what they should
 * not: on a CONFIG-ONLY product registration is derived `open`, so an anonymous caller obtains a
 * device token in one credential-free request and then mints third-party-signed tokens with the
 * operator's key at the operator's cost; on a LICENSED product a free-tier device minted the
 * recipe intended for a paid tier, because "has a usable licence" says nothing about which tier.
 * The operator's approval does not close either: it says the recipe may mint, not for whom.
 *
 * `requires` is checked against what the caller proved, and `required_entitlement` against the
 * SAME merged payload the licence document is built from (`resolveMergedPayload`, then
 * `injectAdminPolicy`, as `entitledAccessCheck` composes it), so a recipe gated on `musicPro` is
 * reachable by exactly the licences whose own document says they hold it.
 *
 * `requires: licensed` on a product that does not run License is a MISCONFIGURATION, not a pass:
 * the demand cannot be evaluated, and a recipe whose stated posture is stricter than the product
 * can enforce must not fall through to the weaker one. It answers `500 misconfigured`, the shape
 * the claims-template and key-material arms use. That is also the upgrade path: a licensed
 * product that turns License off stops minting instead of silently opening every recipe on it.
 * An unrecognised `requires` refuses too. The column is CHECK-constrained, so reaching one is
 * schema drift, and both ways to be permissive about it (read it as `none`, or ignore it) are
 * the finding.
 *
 * `none` and `registered` are both satisfied by the device token the caller already presented:
 * neither is the weaker check, they differ in what the manifest SAYS. Whether the licence of a
 * `licensed` caller is usable is decided by the caller of this function, before the recipe is
 * known to exist (see `handleMintToken`); what is left here is the demand on the product and
 * the entitlement.
 */
async function authorizeMint(
  db: Db,
  product: Product,
  cfg: EdgeMintRow,
  valid: ValidDeviceToken,
  now: number,
): Promise<Response | null> {
  switch (cfg.requires) {
    case "none":
    case "registered":
      break;
    case "licensed":
      if (!product.services.license.enabled)
        return errorResponse(
          500,
          "misconfigured",
          "recipe requires a licence but this product does not run the License service",
        );
      break;
    default:
      return errorResponse(
        500,
        "misconfigured",
        `unsupported mint requires ${cfg.requires}`,
      );
  }

  const flag = cfg.required_entitlement;
  if (!flag) return null;
  const { payload, tier } = await resolveMergedPayload(
    db,
    product.slug,
    valid.license,
    valid.device,
    now,
    { entitlementsOnly: true },
  );
  // The licence-derived policy layer, as the licence document applies it. Skipped without a
  // licence row (the config-only shape): the layer is derived FROM the licence, so there is
  // nothing to stamp, and the catalog defaults and the device's own overrides still decide.
  if (valid.license)
    injectAdminPolicy(payload, tier, valid.license, tighterMin, tighterMax);
  const entry = Object.hasOwn(payload.entitlements, flag)
    ? payload.entitlements[flag]
    : undefined;
  // Present AND truthy: an entitlement stored as `false` (or `0`, or `""`) is a tier that was
  // explicitly denied this capability, not one that merely never mentioned it.
  if (!entry?.value)
    return errorResponse(
      403,
      "forbidden",
      `recipe requires the ${flag} entitlement`,
    );
  return null;
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
  // Confused-deputy guard: the caller must be a device of THIS product. Every mint request
  // needs a device token, including one for a recipe declared `requires: none`: this route
  // spends the product's third-party signing key, so a caller with no credential at all must not
  // reach it.
  //
  // Whether the caller's LICENCE must be usable is the recipe's question (`requires`), asked once
  // the recipe is known, below; Core's pure `licenseUsable` answers it, not an import of License:
  // a service may not import another service. The scope is still "iff the License service is
  // enabled", the same rule Core's own `/devices` and `/devices/report` use: a CONFIG-ONLY
  // product (D-08) has devices that register, hold real `pkeyt_` tokens and have no licence to be
  // licensed by, and a recipe that declares `requires: registered` mints for such a device. Edge
  // minting is how a catalog secret with `delivery: "edgeMint"` reaches a runtime, so a Config
  // service that could not mint there would be Config with a hole in it.
  const token = bearer(req);
  if (!token) return errorResponse(401, "unauthorized");
  const valid = await validateDeviceToken(env, db, product, token, now);
  // The per-network budget is charged on FAILED credentials only (a bad token, or a licence the
  // recipe demands and the caller lacks), so a shared egress address full of legitimate devices
  // is not starved by the pre-auth check; the per-device budget below bounds the authenticated
  // ones.
  const credentialsRefused = async (): Promise<Response> => {
    if (
      !(await rateLimitOk(
        env,
        product.slug,
        { bucket: "mint", id: clientNetwork(req), limit: 60, windowSec: 60 },
        now,
      ))
    ) {
      return errorResponse(429, "rate_limited", "too many mint requests");
    }
    return errorResponse(401, "unauthorized");
  };
  if ("error" in valid) return credentialsRefused();

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

  // P6-02 — the operator's device-trust policy. Log-only unless the policy enforces: a basic
  // device that the policy would refuse is audited and still mints (`core/trust/deviceTrust.ts`).
  const untrusted = await trustRefusal(
    env,
    db,
    product,
    valid.device,
    "mint",
    now,
    "flat",
  );
  if (untrusted) return untrusted;

  // Unknown, never approved, and approved-but-since-changed are ONE answer: the device-facing
  // contract says 404 means "not available", and an unapproved recipe must not be
  // distinguishable from a missing one. "Changed" includes the product changing under the
  // approval — the mint becoming public without the acknowledgement, License being turned off,
  // or sign-in trusting a different identity provider or group map — re-checked here on every
  // request, because a push can do any of them without touching the recipe.
  const cfg = await getApprovedEdgeMintConfig(db, product, mintId);
  // A caller whose licence is not usable, on a product that runs License, may mint only a recipe
  // that says it needs none (`requires: none` or `registered`). The recipe that is not there is
  // held to the default, `licensed`, so for such a caller an unknown id, an unapproved one and a
  // licensed one all answer 401 and none can be told from another: the product-wide check this
  // replaced refused before any lookup too.
  const licensed =
    !product.services.license.enabled || licenseUsable(valid.license, now);
  if (!licensed && (cfg?.requires ?? "licensed") === "licensed")
    return credentialsRefused();
  if (!cfg) return errorResponse(404, "not_found", "no such edge-mint recipe");
  // Authenticate, then decide whether THIS caller may mint THIS recipe, then spend the key:
  // nothing below asks who the caller is again.
  const refused = await authorizeMint(db, product, cfg, valid, now);
  if (refused) return refused;
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
  // Everything below signs with OPERATOR-supplied key material read out of a column: `atob`
  // throws on a PEM body that is not base64, `importKey` on DER that does not parse or does not
  // match the declared alg, and `signJws` on a malformed Ed25519 key. The Worker has no top-level
  // catch, so each surfaced as an unhandled rejection: an opaque 500 with no diagnosis, on a
  // route an authenticated caller reaches at will. Corrupt key material is the same class of
  // fault as a corrupt claims template, so it gets the same answer, and the message never quotes
  // the exception (it is derived from the key).
  try {
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
        // reaches here, and it answers in this route's flat body, never as a throw. Any other
        // throw is the key's, and falls to the catch below.
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
        return errorResponse(
          500,
          "misconfigured",
          `unsupported alg ${cfg.alg}`,
        );
    }
  } catch {
    return errorResponse(
      500,
      "misconfigured",
      "mint signing key is not usable for this algorithm",
    );
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
  // An unapproved recipe is indistinguishable from a missing one.
  const cfg = await getApprovedEdgeMintConfig(db, product, mintId);
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
