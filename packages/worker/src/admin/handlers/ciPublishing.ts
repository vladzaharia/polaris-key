/**
 * The Core admin handler for trusted publishing (P2-02), beside `secrets` and
 * `outlet-credentials`. Narrative-only (no OpenAPI entry, like every admin route):
 *
 *   GET    /api/products/<slug>/ci-publisher            — the publisher policy, or null
 *   PUT    /api/products/<slug>/ci-publisher            — claim/edit it (`source = 'admin'`)
 *   GET    /api/products/<slug>/ci-tokens               — tokens, newest first; never a value
 *   POST   /api/products/<slug>/ci-tokens               — issue a static token (shown ONCE)
 *   DELETE /api/products/<slug>/ci-tokens/<tokenId>     — revoke it (and its open tickets)
 *
 * A claim is how an operator takes the policy away from the manifest: once claimed, resync never
 * touches it (`core/publisher.ts`). It is also the only way to grant `release:yank`. A static
 * token is for a CI that is not GitHub; it expires at most 90 days out and only its peppered hash
 * is stored. Every write is audited with the session's actor.
 *
 * SEC-WP-05 (SEC-ADM-1): the SYSTEM product (`polaris-key`) feeds the platform's own package
 * feeds, so its publisher policy is manifest-authoritative: `PUT …/ci-publisher` and
 * `POST …/ci-tokens` are refused for it, for every console session (a platform admin is one
 * group, not a second factor), and the refusal is audited. Reading and revoking still work. The
 * deploy hook (`linkSystemProduct`) is the only writer of its policy, and it also revokes any
 * static token found on the product.
 */

import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../core/errors.js";
import {
  TRUSTED_PUBLISHER_ENVIRONMENT_RE,
  TRUSTED_PUBLISHER_WORKFLOW_RE,
} from "@polaris-key/manifest";
import {
  claimPublisherPolicy,
  getPublisherPolicy,
  issueStaticCiToken,
  listCiTokens,
  normalizeScopes,
  revokeCiToken,
  STATIC_CI_TOKEN_MAX_TTL_SECONDS,
  type PublisherClaim,
} from "../../core/publisher.js";
import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import { getProduct } from "../../repo.js";
import { audit } from "../audit.js";
import { isPlatformAdmin } from "../authz.js";
import type { AdminSession } from "../session.js";
import {
  adminJson,
  err,
  forbidden,
  notFound,
  readBody,
} from "../lib/respond.js";

const REPOSITORY_RE =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/;
const TOKEN_ID_RE = /^cit_[A-Za-z0-9_-]{1,32}$/;
const MAX_LABEL = 100;

function bad(message: string, field?: string): Response {
  return err(400, ErrorCode.BadRequest, message, field ? { field } : undefined);
}

function positiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

/** `PUT …/ci-publisher`: validate a claim body, field by field. */
function parseClaim(body: Record<string, unknown>): PublisherClaim | Response {
  const claim: PublisherClaim = {};
  if (body.workflow !== undefined) {
    if (
      typeof body.workflow !== "string" ||
      !TRUSTED_PUBLISHER_WORKFLOW_RE.test(body.workflow)
    )
      return bad("workflow must be .github/workflows/<file>.yml", "workflow");
    claim.workflow = body.workflow;
  }
  if (body.environment !== undefined) {
    if (
      typeof body.environment !== "string" ||
      !TRUSTED_PUBLISHER_ENVIRONMENT_RE.test(body.environment)
    )
      return bad(
        "environment must be a GitHub environment name",
        "environment",
      );
    claim.environment = body.environment;
  }
  if (body.scopes !== undefined) {
    const scopes = normalizeScopes(body.scopes);
    if (!scopes || scopes.length === 0)
      return bad("scopes must be a non-empty list of known scopes", "scopes");
    claim.scopes = scopes;
  }
  if (body.repositoryId !== undefined) {
    if (!positiveInt(body.repositoryId))
      return bad(
        "repositoryId must be GitHub's numeric repository id",
        "repositoryId",
      );
    claim.repositoryId = body.repositoryId;
  }
  if (body.repositoryOwnerId !== undefined) {
    if (!positiveInt(body.repositoryOwnerId))
      return bad(
        "repositoryOwnerId must be GitHub's numeric owner id",
        "repositoryOwnerId",
      );
    claim.repositoryOwnerId = body.repositoryOwnerId;
  }
  if (body.repository !== undefined) {
    if (
      typeof body.repository !== "string" ||
      !REPOSITORY_RE.test(body.repository)
    )
      return bad("repository must be owner/repo", "repository");
    claim.repository = body.repository;
  }
  return claim;
}

/** True for the platform's own product: the reserved slug, or a row marked `system`. */
async function isSystemProduct(db: Db, slug: string): Promise<boolean> {
  if (slug === SYSTEM_PRODUCT_SLUG) return true;
  return (await getProduct(db, slug))?.system === 1;
}

/** The audited 403 for a policy change or token mint the system product does not accept. */
async function refuseSystem(
  db: Db,
  session: AdminSession,
  slug: string,
  now: number,
  action: string,
  target: { kind: string; id: string },
  what: string,
): Promise<Response> {
  await audit(
    db,
    slug,
    session,
    now,
    action,
    target,
    `Refused: ${what} on the system product ${slug} (manifest-authoritative; changed by the deploy only)`,
  );
  return err(
    403,
    ErrorCode.Forbidden,
    `${slug} is the platform's own product: its trusted publisher and CI tokens are set by the deploy, not the console`,
    { reason: "system_product_manifest_only" },
  );
}

export async function handleCiPublisher(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  id: string | undefined,
  now: number,
): Promise<Response> {
  if (!isPlatformAdmin(env, session)) return forbidden("platform admin only");
  if (id !== undefined) return notFound();
  if (req.method === "GET")
    return adminJson({ ok: true, policy: await getPublisherPolicy(db, slug) });
  if (req.method !== "PUT")
    return err(405, ErrorCode.BadRequest, "method not allowed");
  if (await isSystemProduct(db, slug))
    return refuseSystem(
      db,
      session,
      slug,
      now,
      "ci.publisher.claim.refused",
      { kind: "ci_publisher", id: slug },
      "a claim or edit of the trusted publisher",
    );
  const claim = parseClaim(await readBody(req));
  if (claim instanceof Response) return claim;
  const res = await claimPublisherPolicy(db, slug, claim, session.sub, now);
  if ("error" in res) return bad(res.error);
  await audit(
    db,
    slug,
    session,
    now,
    "ci.publisher.claim",
    { kind: "ci_publisher", id: slug },
    `Claimed the trusted publisher: ${res.repository} ${res.workflow} (environment ${res.environment}; scopes ${res.scopes.join(", ")})`,
  );
  return adminJson({ ok: true, policy: res });
}

export async function handleCiTokens(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  id: string | undefined,
  now: number,
): Promise<Response> {
  if (!isPlatformAdmin(env, session)) return forbidden("platform admin only");

  if (id === undefined) {
    if (req.method === "GET")
      return adminJson({ ok: true, tokens: await listCiTokens(db, slug) });
    if (req.method !== "POST")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    if (await isSystemProduct(db, slug))
      return refuseSystem(
        db,
        session,
        slug,
        now,
        "ci.token.issue.refused",
        { kind: "ci_token", id: slug },
        "issuing a static CI token",
      );
    const body = await readBody(req);
    const scopes = normalizeScopes(body.scopes);
    if (!scopes || scopes.length === 0)
      return bad("scopes must be a non-empty list of known scopes", "scopes");
    const days = body.expiresInDays;
    if (
      typeof days !== "number" ||
      !Number.isSafeInteger(days) ||
      days < 1 ||
      days * 86400 > STATIC_CI_TOKEN_MAX_TTL_SECONDS
    )
      return bad(
        "expiresInDays must be an integer from 1 to 90",
        "expiresInDays",
      );
    let label: string | null = null;
    if (body.label !== undefined && body.label !== null) {
      if (
        typeof body.label !== "string" ||
        body.label.length > MAX_LABEL ||
        /[\u0000-\u001f\u007f]/.test(body.label)
      )
        return bad(
          `label must be text of at most ${MAX_LABEL} characters`,
          "label",
        );
      label = body.label;
    }
    const issued = await issueStaticCiToken(env, db, {
      product: slug,
      scopes,
      expiresAt: now + days * 86400,
      label,
      createdBy: session.sub,
      now,
    });
    await audit(
      db,
      slug,
      session,
      now,
      "ci.token.issue",
      { kind: "ci_token", id: issued.tokenId },
      `Issued static CI token ${issued.tokenId}${label ? ` (${label})` : ""}, scopes ${scopes.join(", ")}, expiring in ${days} day(s)`,
    );
    // The token itself, exactly once. It is never readable again.
    return adminJson({ ok: true, ...issued }, 201);
  }

  if (req.method !== "DELETE")
    return err(405, ErrorCode.BadRequest, "method not allowed");
  if (!TOKEN_ID_RE.test(id)) return notFound();
  if (!(await revokeCiToken(db, slug, id, now))) return notFound();
  await audit(
    db,
    slug,
    session,
    now,
    "ci.token.revoke",
    { kind: "ci_token", id },
    `Revoked CI token ${id}`,
  );
  return adminJson({ ok: true, tokenId: id, revokedAt: now });
}
