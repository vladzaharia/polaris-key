/**
 * Edge-mint recipe approval — `/manage/api/products/<slug>/config/mint[/<id>/{approve,revoke}]`
 * (P0-12).
 *
 * A recipe (`edge_mint_config`) arrives from a linked repo's `.pkey/` manifest, so on its own it
 * is repo-authored policy: before this existed, a repo writer (or a mistaken recipe) could turn
 * any PEM-shaped product secret into a token mint reachable by every device of the product —
 * which, under open registration or anonymous enrolment, is anyone. The mint route now signs only when an operator
 * approved the recipe in the EXACT form it will run, and this is where that approval is given.
 *
 *   GET  config/mint              every recipe with its status (approved | pending | changed),
 *                                 its signing secret's usage, the product's effective
 *                                 registration policy, whether anonymous enrolment or an OIDC
 *                                 default tier is on, whether the mint is therefore public
 *                                 (`publicMint`), and the sign-in trust (`identity`) an
 *                                 approval given now would cover
 *   POST config/mint/<id>/approve the recipe's fields and `identity` ECHOED back, plus
 *                                 `acknowledgeOpenRegistration: true` when the mint is public
 *   POST config/mint/<id>/revoke  drop the approval; the recipe answers 404 again
 *
 * ── WHY THE FIELDS ARE ECHOED ──────────────────────────────────────────────────────────────
 *
 * A push can land between an operator loading the console and clicking Approve. Approving "the
 * recipe with this id" would then approve something the operator never saw. So the approve body
 * carries the values the operator was shown, the handler refuses (409) unless they still equal
 * the stored recipe column for column, and the approval records THOSE values — if the recipe
 * changes a millisecond later, the approval simply stops matching and the recipe goes inert.
 *
 * ── WHY OPEN REGISTRATION NEEDS AN ACKNOWLEDGEMENT ─────────────────────────────────────────
 *
 * With `registration: "open"` any installation can register and hold a device token; with
 * anonymous auto-issue enrolment on, any caller can get a licence and a device token from
 * `POST /<p>/license/enroll`; with Identity on and an OIDC default tier, every account the
 * identity provider signs in gets a licence. Each way an approved recipe is a public token mint
 * (`mintIsPublic` in `../mint.ts`). That can be right — it is the operator's decision — but it
 * has to be a visible one: the flag is required, and the audit row says it was given.
 *
 * The acknowledgement is stored ON the approval (`open_registration_acknowledged`), not just
 * checked once. All three settings are product state a `.pkey/product` push can change —
 * declare `devices.registration: open`, turn License off so the derived policy is open, enable
 * anonymous `autoIssue`, or turn on `oidcDefault` — without touching the recipe. The mint route
 * re-checks it on every request: while the mint is public an approval without the
 * acknowledgement does not match, the recipe answers 404, and this list reports it `changed`
 * with `registration` among its changed fields.
 *
 * ── WHY THE IDENTITY PROVIDER IS PART OF THE APPROVAL ──────────────────────────────────────
 *
 * On a closed product the device tokens the mint accepts still come from somewhere other than
 * an operator: signing in. `activateFromIdentity` gives a licence to any identity whose groups
 * hit the product's `groupRoleMap`, and the issuer, client id and that map are all written
 * from the manifest. So a push that points `oidc.issuer` at a host the pusher runs, or maps a
 * group they are in onto a tier, would hand the pusher a licensed device token — and an
 * approval that ignored it would sign for them. The approval therefore records the identity
 * inputs it was given under (`identity_enabled`, `oidc_provider`, `oidc_issuer`,
 * `oidc_client_id`, `oidc_group_role_map_json`), and while Identity is on any difference makes
 * the recipe `changed` with `identity` among its changed fields. Turning Identity OFF is a
 * narrowing and never invalidates an approval. The approve body echoes the identity it was
 * shown, for the same reason it echoes the recipe.
 *
 * ── WHY LICENSE IS PART OF THE APPROVAL ────────────────────────────────────────────────────
 *
 * The mint checks a device's licence only while the License service is on. A push that turns
 * License off with Identity on leaves the mint closed (registration derives `requires-identity`)
 * but stops that check, so a device whose licence an operator disabled, or that expired, mints
 * again. The approval records `license_enabled`; while License is off an approval given with it
 * on is `changed` with `license` among its changed fields.
 *
 * ── WHY A WIDENING DELETES THE APPROVAL AT INGEST ──────────────────────────────────────────
 *
 * The three product-side conditions above are re-checked on every request, but that alone
 * compares the approval with the product as it stands: push a widening, collect a licence or a
 * device token, push the revert, and the approval would apply again with the credential still
 * working. So link and resync delete every approval the product has widened
 * (`invalidateWidenedEdgeMintApprovals`, `core/edgeMintApproval.ts`) and audit it as
 * `config.mint.invalidate`; after a revert the recipe is `pending`, not `approved`. What was
 * issued while it was widened survives a re-approval — the audit summary tells the operator to
 * review it. Recipe-field changes are not swept: a changed recipe signs nothing meanwhile.
 */

import { ErrorCode } from "../../../core/errors.js";
import {
  adminJson,
  notFound as adminNotFound,
  err,
  readBody,
} from "../../../admin/lib/respond.js";
import { audit } from "../../../admin/audit.js";
import { getProductSecretUsage } from "../../../core/products.js";
import { parseJsonColumn } from "../../../platform/json.js";
import {
  allowsAnonymousEnroll,
  allowsOidcDefault,
} from "../../../fingerprint.js";
import type { IdentityIssuance } from "../../../core/identityTrust.js";
import {
  approvalMismatch,
  differingRecipeFields,
  getEdgeMintConfig,
  listEdgeMintRecipesWithApprovals,
  mintApprovalBasis,
  type MintApprovalBasis,
  type MintApprovalRow,
  type MintRecipeFields,
} from "../mint.js";
import type { ConfigAdminContext } from "./index.js";

function wireFields(row: MintRecipeFields) {
  return {
    alg: row.alg,
    signingKeySecret: row.signing_key_secret,
    kid: row.kid,
    claimsTemplateJson: row.claims_template_json,
    ttlSeconds: row.ttl_seconds,
    audience: row.audience,
  };
}

/** The sign-in trust an approval covers, in wire spelling. `null` = Identity off (no sign-in
 *  path), which is also what the approve body echoes when the console showed none. */
interface IdentityWire {
  provider: string | null;
  issuer: string | null;
  clientId: string | null;
  groupRoleMapJson: string | null;
}

function identityWire(current: IdentityIssuance): IdentityWire | null {
  if (!current.enabled) return null;
  return {
    provider: current.provider,
    issuer: current.issuer,
    clientId: current.clientId,
    groupRoleMapJson: current.groupRoleMapJson,
  };
}

function approvedIdentityWire(approval: MintApprovalRow): IdentityWire | null {
  if (approval.identity_enabled !== 1) return null;
  return {
    provider: approval.oidc_provider,
    issuer: approval.oidc_issuer,
    clientId: approval.oidc_client_id,
    groupRoleMapJson: approval.oidc_group_role_map_json,
  };
}

/** The echoed identity equals the one the product trusts now (exact text; null = Identity off). */
function sameIdentityEcho(
  echo: unknown,
  current: IdentityWire | null,
): boolean {
  if (current === null) return echo === null || echo === undefined;
  if (!echo || typeof echo !== "object" || Array.isArray(echo)) return false;
  const e = echo as Record<string, unknown>;
  const text = (v: unknown): string | null | "invalid" =>
    v === undefined || v === null
      ? null
      : typeof v === "string"
        ? v
        : "invalid";
  return (
    text(e.provider) === current.provider &&
    text(e.issuer) === current.issuer &&
    text(e.clientId) === current.clientId &&
    text(e.groupRoleMapJson) === current.groupRoleMapJson
  );
}

function statusOf(
  recipe: MintRecipeFields,
  approval: MintApprovalRow | null,
  basis: MintApprovalBasis,
): "approved" | "pending" | "changed" {
  if (!approval) return "pending";
  return approvalMismatch(recipe, approval, basis).length === 0
    ? "approved"
    : "changed";
}

async function handleList(ctx: ConfigAdminContext): Promise<Response> {
  const basis = await mintApprovalBasis(ctx.db, ctx.product);
  const rows = await listEdgeMintRecipesWithApprovals(ctx.db, ctx.product.slug);
  const recipes = [];
  for (const { recipe, approval } of rows) {
    const usage = await getProductSecretUsage(
      ctx.db,
      ctx.product.slug,
      recipe.signing_key_secret,
    );
    const status = statusOf(recipe, approval, basis);
    recipes.push({
      id: recipe.id,
      ...wireFields(recipe),
      // Parsed for display only. Never used to decide anything; a corrupt column shows as null.
      claimsTemplate: parseJsonColumn(recipe.claims_template_json),
      status,
      /** `edge-mint` | `general` | `missing` (no such secret) | `unrecognised`. */
      secretUsage:
        usage === undefined
          ? "missing"
          : usage === null
            ? "unrecognised"
            : usage,
      approval: approval
        ? {
            ...wireFields(approval),
            openRegistrationAcknowledged:
              approval.open_registration_acknowledged === 1,
            licenseEnabled: approval.license_enabled === 1,
            identity: approvedIdentityWire(approval),
            approvedAt: approval.approved_at,
            approvedBy: approval.approved_by,
          }
        : null,
      changedFields:
        status === "changed" && approval
          ? approvalMismatch(recipe, approval, basis)
          : [],
    });
  }
  return adminJson({
    registration: ctx.product.registration,
    anonymousEnroll: allowsAnonymousEnroll(ctx.product.autoIssue),
    oidcDefault:
      ctx.product.services.identity.enabled &&
      allowsOidcDefault(ctx.product.autoIssue),
    publicMint: basis.publicMint,
    licenseEnabled: basis.licenseEnabled,
    identity: identityWire(basis.identity),
    recipes,
  });
}

/** The echoed value for a nullable text column: absent and `null` both mean NULL. */
function echoedText(v: unknown): string | null | "invalid" {
  if (v === undefined || v === null) return null;
  return typeof v === "string" ? v : "invalid";
}

async function handleApprove(
  ctx: ConfigAdminContext,
  id: string,
): Promise<Response> {
  const { db, product, session, now } = ctx;
  const slug = product.slug;
  const recipe = await getEdgeMintConfig(db, slug, id);
  if (!recipe) return adminNotFound();

  const body = await readBody(ctx.req);
  const kid = echoedText(body.kid);
  const claims = echoedText(body.claimsTemplateJson);
  const audience = echoedText(body.audience);
  const malformed = [
    ...(typeof body.alg === "string" ? [] : ["alg"]),
    ...(typeof body.signingKeySecret === "string" ? [] : ["signingKeySecret"]),
    ...(kid === "invalid" ? ["kid"] : []),
    ...(claims === "invalid" ? ["claimsTemplateJson"] : []),
    ...(typeof body.ttlSeconds === "number" && Number.isInteger(body.ttlSeconds)
      ? []
      : ["ttlSeconds"]),
    ...(audience === "invalid" ? ["audience"] : []),
    ...(typeof body.licenseEnabled === "boolean" ? [] : ["licenseEnabled"]),
  ];
  if (malformed.length > 0) {
    return err(
      422,
      ErrorCode.BadRequest,
      "echo every recipe field you are approving",
      { fields: malformed },
    );
  }
  const echoed: MintRecipeFields = {
    alg: body.alg as string,
    signing_key_secret: body.signingKeySecret as string,
    kid: kid as string | null,
    claims_template_json: claims as string | null,
    ttl_seconds: body.ttlSeconds as number,
    audience: audience as string | null,
  };
  // Sign-in trust is echoed the same way: the console shows which identity provider and group
  // map can hand out device tokens, and a push that changes them between that view and this
  // click must not be approved unseen. `identity: null` (or absent) means "Identity was off".
  // Whether License is on is echoed for the same reason: with it off the mint checks no
  // licence, so a disabled or expired one mints again, and the console warns about exactly
  // that. A push that turns License off after the card loaded must not ride in on this click.
  const basis = await mintApprovalBasis(db, product);
  const identity = identityWire(basis.identity);
  const stale = [
    ...differingRecipeFields(recipe, echoed),
    ...(sameIdentityEcho(body.identity, identity) ? [] : ["identity"]),
    ...(body.licenseEnabled === basis.licenseEnabled ? [] : ["licenseEnabled"]),
  ];
  if (stale.length > 0) {
    return err(
      409,
      ErrorCode.BadRequest,
      "the recipe changed since it was shown; reload and review it",
      { fields: stale },
    );
  }

  const open = basis.publicMint;
  const acknowledged = body.acknowledgeOpenRegistration === true;
  if (open && !acknowledged) {
    return err(
      422,
      ErrorCode.BadRequest,
      "the mint is public (open registration, anonymous enrolment or an OIDC default tier): anyone who installs this product can mint this token; set acknowledgeOpenRegistration to approve",
      { fields: ["acknowledgeOpenRegistration"] },
    );
  }

  // The ECHOED values, which equal the recipe as it was just read. If a push changes the recipe
  // after this point, the approval stops matching — which is exactly the intended failure. The
  // acknowledgement is recorded with it: an approval given without one stops matching if a push
  // later makes the mint public. An operator may acknowledge ahead of time on a closed product
  // (the API accepts the flag either way); the console only offers it while the mint is public.
  await db.run(
    `INSERT INTO edge_mint_approvals
       (product, id, alg, signing_key_secret, kid, claims_template_json, ttl_seconds, audience,
        open_registration_acknowledged, license_enabled, identity_enabled, oidc_provider,
        oidc_issuer, oidc_client_id, oidc_group_role_map_json, approved_at, approved_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product, id) DO UPDATE SET
       alg = excluded.alg, signing_key_secret = excluded.signing_key_secret,
       kid = excluded.kid, claims_template_json = excluded.claims_template_json,
       ttl_seconds = excluded.ttl_seconds, audience = excluded.audience,
       open_registration_acknowledged = excluded.open_registration_acknowledged,
       license_enabled = excluded.license_enabled,
       identity_enabled = excluded.identity_enabled,
       oidc_provider = excluded.oidc_provider, oidc_issuer = excluded.oidc_issuer,
       oidc_client_id = excluded.oidc_client_id,
       oidc_group_role_map_json = excluded.oidc_group_role_map_json,
       approved_at = excluded.approved_at, approved_by = excluded.approved_by`,
    slug,
    id,
    echoed.alg,
    echoed.signing_key_secret,
    echoed.kid,
    echoed.claims_template_json,
    echoed.ttl_seconds,
    echoed.audience,
    acknowledged ? 1 : 0,
    // Whether the mint is checking licences now. Turning License off later is a widening
    // (`license`): a device whose licence was disabled or expired would mint again.
    basis.licenseEnabled ? 1 : 0,
    // The identity inputs exactly as just compared with the echo. Recorded whether or not
    // Identity is on: with it off they are inert, and turning Identity on later is itself a
    // change (`identity_enabled` 0) that makes the approval stop applying.
    basis.identity.enabled ? 1 : 0,
    basis.identity.provider,
    basis.identity.issuer,
    basis.identity.clientId,
    basis.identity.groupRoleMapJson,
    now,
    session.sub,
  );
  await audit(
    db,
    slug,
    session,
    now,
    "config.mint.approve",
    { kind: "edgeMint", id },
    `Approved edge-mint recipe ${id} (${echoed.alg}, signs with ${echoed.signing_key_secret})` +
      (identity
        ? ` — sign-in via ${identity.provider ?? "no provider"} ${identity.issuer ?? ""}`.trimEnd()
        : "") +
      (basis.licenseEnabled ? "" : " — License off: licences not checked") +
      (acknowledged ? " — open registration acknowledged" : ""),
  );
  return adminJson({ ok: true, id, status: "approved" });
}

async function handleRevoke(
  ctx: ConfigAdminContext,
  id: string,
): Promise<Response> {
  const { db, product, session, now } = ctx;
  const slug = product.slug;
  const existing = await db.first<{ id: string }>(
    "SELECT id FROM edge_mint_approvals WHERE product = ? AND id = ?",
    slug,
    id,
  );
  if (!existing) {
    const recipe = await db.first<{ id: string }>(
      "SELECT id FROM edge_mint_config WHERE product = ? AND id = ?",
      slug,
      id,
    );
    if (!recipe) return adminNotFound();
    return adminJson({ ok: true, id, status: "pending" });
  }
  await db.run(
    "DELETE FROM edge_mint_approvals WHERE product = ? AND id = ?",
    slug,
    id,
  );
  await audit(
    db,
    slug,
    session,
    now,
    "config.mint.revoke",
    { kind: "edgeMint", id },
    `Revoked approval of edge-mint recipe ${id}`,
  );
  return adminJson({ ok: true, id, status: "pending" });
}

export async function handleMintAdmin(
  ctx: ConfigAdminContext,
  rest: string[],
): Promise<Response> {
  const method = ctx.req.method;
  if (rest.length === 0) {
    if (method === "GET") return handleList(ctx);
    return err(405, ErrorCode.BadRequest, "method not allowed");
  }
  const [id, action] = rest;
  if (
    rest.length === 2 &&
    id &&
    (action === "approve" || action === "revoke")
  ) {
    if (method !== "POST")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    return action === "approve"
      ? handleApprove(ctx, id)
      : handleRevoke(ctx, id);
  }
  return adminNotFound();
}
