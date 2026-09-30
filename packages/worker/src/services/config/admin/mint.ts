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
 *                                 registration policy, whether anonymous enrolment is on, and
 *                                 whether the mint is therefore public (`publicMint`)
 *   POST config/mint/<id>/approve the recipe's fields ECHOED back, plus
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
 * `POST /<p>/license/enroll`. Either way an approved recipe is a public token mint
 * (`mintIsPublic` in `../mint.ts`). That can be right — it is the operator's decision — but it
 * has to be a visible one: the flag is required, and the audit row says it was given.
 *
 * The acknowledgement is stored ON the approval (`open_registration_acknowledged`), not just
 * checked once. Both settings are product state a `.pkey/product` push can change — declare
 * `devices.registration: open`, turn License off so the derived policy is open, or enable
 * anonymous `autoIssue` — without touching the recipe. The mint route re-checks it on every
 * request: while the mint is public an approval without the acknowledgement does not match, the
 * recipe answers 404, and this list reports it `changed` with `registration` among its changed
 * fields.
 */

import { ErrorCode } from "../../../core/errors.js";
import {
  adminJson,
  adminNotFound,
  audit,
  err,
  readBody,
} from "../../../core/adminApi.js";
import { getProductSecretUsage } from "../../../core/products.js";
import { allowsAnonymousEnroll } from "../../../core/fingerprint.js";
import { mintIsPublic } from "../mint.js";
import type { ConfigAdminContext } from "./index.js";

interface RecipeRow {
  id: string;
  alg: string;
  signing_key_secret: string;
  kid: string | null;
  claims_template_json: string | null;
  ttl_seconds: number;
  audience: string | null;
}

interface ApprovalRow extends RecipeRow {
  open_registration_acknowledged: number;
  approved_at: number;
  approved_by: string;
}

/** The security-relevant fields, in their wire (camelCase) spelling, paired with the column. */
const FIELDS = [
  ["alg", "alg"],
  ["signingKeySecret", "signing_key_secret"],
  ["kid", "kid"],
  ["claimsTemplateJson", "claims_template_json"],
  ["ttlSeconds", "ttl_seconds"],
  ["audience", "audience"],
] as const;

type WireField = (typeof FIELDS)[number][0];

function wireFields(row: RecipeRow): Record<WireField, string | number | null> {
  return {
    alg: row.alg,
    signingKeySecret: row.signing_key_secret,
    kid: row.kid,
    claimsTemplateJson: row.claims_template_json,
    ttlSeconds: row.ttl_seconds,
    audience: row.audience,
  };
}

/** Which wire fields differ between two rows (strict equality; NULL equals NULL). */
function differingFields(a: RecipeRow, b: RecipeRow): WireField[] {
  return FIELDS.filter(([, col]) => a[col] !== b[col]).map(([wire]) => wire);
}

/**
 * Why an approval no longer applies: the differing recipe fields, plus `registration` when the
 * mint is public now (`mintIsPublic`) and the approval was given without the acknowledgement.
 * Empty means the approval matches — the same rule as `approvalMatchesRecipe` in `../mint.ts`.
 */
function approvalMismatch(
  recipe: RecipeRow,
  approval: ApprovalRow,
  open: boolean,
): Array<WireField | "registration"> {
  return [
    ...differingFields(recipe, approval),
    ...(open && approval.open_registration_acknowledged !== 1
      ? (["registration"] as const)
      : []),
  ];
}

/** Parsed for display only. Never used to decide anything; a corrupt column shows as null. */
function parsedTemplate(json: string | null): unknown {
  if (json === null) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

async function listRecipes(
  ctx: ConfigAdminContext,
): Promise<Array<{ recipe: RecipeRow; approval: ApprovalRow | null }>> {
  const slug = ctx.product.slug;
  const recipes = await ctx.db.all<RecipeRow>(
    `SELECT id, alg, signing_key_secret, kid, claims_template_json, ttl_seconds, audience
       FROM edge_mint_config WHERE product = ? ORDER BY id`,
    slug,
  );
  const approvals = await ctx.db.all<ApprovalRow & { product: string }>(
    "SELECT * FROM edge_mint_approvals WHERE product = ?",
    slug,
  );
  const byId = new Map(approvals.map((a) => [a.id, a]));
  return recipes.map((recipe) => ({
    recipe,
    approval: byId.get(recipe.id) ?? null,
  }));
}

function statusOf(
  recipe: RecipeRow,
  approval: ApprovalRow | null,
  open: boolean,
): "approved" | "pending" | "changed" {
  if (!approval) return "pending";
  return approvalMismatch(recipe, approval, open).length === 0
    ? "approved"
    : "changed";
}

async function handleList(ctx: ConfigAdminContext): Promise<Response> {
  const open = mintIsPublic(ctx.product);
  const rows = await listRecipes(ctx);
  const recipes = [];
  for (const { recipe, approval } of rows) {
    const usage = await getProductSecretUsage(
      ctx.db,
      ctx.product.slug,
      recipe.signing_key_secret,
    );
    const status = statusOf(recipe, approval, open);
    recipes.push({
      id: recipe.id,
      ...wireFields(recipe),
      claimsTemplate: parsedTemplate(recipe.claims_template_json),
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
            approvedAt: approval.approved_at,
            approvedBy: approval.approved_by,
          }
        : null,
      changedFields:
        status === "changed" && approval
          ? approvalMismatch(recipe, approval, open)
          : [],
    });
  }
  return adminJson({
    registration: ctx.product.registration,
    anonymousEnroll: allowsAnonymousEnroll(ctx.product.autoIssue),
    publicMint: open,
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
  const recipe = await db.first<RecipeRow>(
    `SELECT id, alg, signing_key_secret, kid, claims_template_json, ttl_seconds, audience
       FROM edge_mint_config WHERE product = ? AND id = ?`,
    slug,
    id,
  );
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
  ];
  if (malformed.length > 0) {
    return err(
      422,
      ErrorCode.BadRequest,
      "echo every recipe field you are approving",
      { fields: malformed },
    );
  }
  const echoed: RecipeRow = {
    id,
    alg: body.alg as string,
    signing_key_secret: body.signingKeySecret as string,
    kid: kid as string | null,
    claims_template_json: claims as string | null,
    ttl_seconds: body.ttlSeconds as number,
    audience: audience as string | null,
  };
  const stale = differingFields(recipe, echoed);
  if (stale.length > 0) {
    return err(
      409,
      ErrorCode.BadRequest,
      "the recipe changed since it was shown; reload and review it",
      { fields: stale },
    );
  }

  const open = mintIsPublic(product);
  const acknowledged = body.acknowledgeOpenRegistration === true;
  if (open && !acknowledged) {
    return err(
      422,
      ErrorCode.BadRequest,
      "the mint is public (open registration or anonymous enrolment): anyone who installs this product can mint this token; set acknowledgeOpenRegistration to approve",
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
        open_registration_acknowledged, approved_at, approved_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product, id) DO UPDATE SET
       alg = excluded.alg, signing_key_secret = excluded.signing_key_secret,
       kid = excluded.kid, claims_template_json = excluded.claims_template_json,
       ttl_seconds = excluded.ttl_seconds, audience = excluded.audience,
       open_registration_acknowledged = excluded.open_registration_acknowledged,
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
