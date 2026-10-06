/// <reference types="@cloudflare/workers-types" />

/**
 * Release's own sub-router, over the path segments AFTER `/<product>/release`.
 *
 *     /release/changelog
 *     /release/channels/:channel/{promote,pin,unpin}  POST, `pkeyci_` + release:promote
 *     /release/releases/:releaseId/yank               POST, `pkeyci_` + release:yank
 *     /release/packages/prune                         POST, `pkeyci_` + release:yank (feed
 *                                                     retention's backfill; dry run by default)
 *     /release/publish/{token,uploads,submit}         POST (P2-02, trusted publishing)
 *     /release/records/:sha256                        GET, HEAD (P3-03, a CI-signed record)
 *
 * Returning `null` for an unmatched segment is the registry contract (`core/registry.ts`): only
 * Core decides what "no route here" means, which is what makes a disabled service, an
 * unregistered slug and a bad path indistinguishable from outside.
 *
 * BYTES ARE NOT HERE (P2b-04). `/release/dl/…`, `/release/install.sh`, `/release/builds/…`,
 * `/release/files/…` and `/release/blobs/…` are permanent aliases the core router rewrites to
 * Distribution's canonical `/<p>/distribution/…` routes before dispatch, so none of them reaches
 * this file; Distribution reads what it needs from Release through the `releaseCatalog` hook.
 */

import type { ServiceContext } from "../../core/registry.js";
import { errorResponse, ErrorCode, json } from "../../core/errors.js";
import { ciActor, readCiJson, requireCiScope } from "../../core/ciScope.js";
import { handleRelease } from "./surfaces.js";
import { getReleaseConfig } from "./config.js";
import { handlePublishRoute } from "./publish.js";
import { handleRecordRoute } from "./recordRoute.js";
import { prunePackages } from "./packages/prune.js";
import {
  applyPointerOp,
  yank,
  type PointerOp,
  type PolicyRefusal,
} from "./policy.js";

export async function handleReleaseRoutes(
  ctx: ServiceContext,
): Promise<Response | null> {
  const { req, env, db, product, rest } = ctx;

  if (rest.length === 1) {
    if (rest[0] === "changelog")
      return handleRelease(req, env, db, product, "changelog", {});
    return null;
  }

  // A CI-signed release record by its hash (P3-03, `recordRoute.ts`).
  if (rest.length === 2 && rest[0] === "records")
    return handleRecordRoute(ctx, rest[1] as string);

  // Trusted publishing (P2-02): the OIDC exchange, upload tickets and the submit.
  if (rest.length === 2 && rest[0] === "publish")
    return handlePublishRoute(ctx, rest[1] as string);

  // The CI policy routes (P2-05): `pkeyci_` token with the operation's scope.
  if (
    rest.length === 3 &&
    rest[0] === "channels" &&
    (rest[2] === "promote" || rest[2] === "pin" || rest[2] === "unpin")
  ) {
    if (req.method !== "POST") return null;
    return handleCiPointer(ctx, rest[1] as string, rest[2]);
  }
  if (rest.length === 3 && rest[0] === "releases" && rest[2] === "yank") {
    if (req.method !== "POST") return null;
    return handleCiYank(ctx, rest[1] as string);
  }
  if (rest.length === 2 && rest[0] === "packages" && rest[1] === "prune") {
    if (req.method !== "POST") return null;
    return handleCiPrune(ctx);
  }

  return null;
}

// ── CI policy routes (P2-05) ─────────────────────────────────────────────────────────────────

/** A CI body is tiny (`{deliverable?, releaseId}` or `{reason}`). */
const MAX_CI_BODY_BYTES = 16 * 1024;

/** The JSON object a CI route was sent, or a 400 to answer with. */
function readCiBody(req: Request): Promise<Record<string, unknown> | Response> {
  return readCiJson(req, MAX_CI_BODY_BYTES);
}

function refusal(r: PolicyRefusal): Response {
  return errorResponse(r.status, r.code, r.message, {
    reason: r.reason,
    ...(r.fields ? { fields: r.fields } : {}),
  });
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** `POST /<p>/release/channels/<channel>/{promote,pin,unpin}` — `release:promote`. */
async function handleCiPointer(
  ctx: ServiceContext,
  rawChannel: string,
  op: PointerOp,
): Promise<Response> {
  const { req, env, db, product, now } = ctx;
  const principal = await requireCiScope(
    req,
    env,
    db,
    product.slug,
    "release:promote",
    now,
  );
  if (principal instanceof Response) return principal;
  const body = await readCiBody(req);
  if (body instanceof Response) return body;
  const channel = decodeSegment(rawChannel);
  if (channel === null)
    return errorResponse(404, ErrorCode.NotFound, "no such channel", {
      reason: "unknown_channel",
    });
  const result = await applyPointerOp(
    env,
    db,
    product.slug,
    await getReleaseConfig(db, product.slug),
    op,
    { channel, deliverable: body.deliverable, releaseId: body.releaseId },
    { kind: "ci", principal },
    now,
  );
  if (!result.ok) return refusal(result);
  return json({ ok: true, policy: result.policy, packSets: result.packSets });
}

/** `POST /<p>/release/releases/<releaseId>/yank` — `release:yank`. */
async function handleCiYank(
  ctx: ServiceContext,
  rawReleaseId: string,
): Promise<Response> {
  const { req, env, db, product, now } = ctx;
  const principal = await requireCiScope(
    req,
    env,
    db,
    product.slug,
    "release:yank",
    now,
  );
  if (principal instanceof Response) return principal;
  const body = await readCiBody(req);
  if (body instanceof Response) return body;
  const releaseId = decodeSegment(rawReleaseId);
  if (releaseId === null)
    return errorResponse(404, ErrorCode.NotFound, "no such release", {
      reason: "unknown_release",
    });
  const result = await yank(
    env,
    db,
    product.slug,
    releaseId,
    body.reason,
    { kind: "ci", principal },
    now,
  );
  if (!result.ok) return refusal(result);
  return json({ ok: true, yank: result.yank, packSets: result.packSets });
}

/**
 * `POST /<p>/release/packages/prune` `{apply?, deliverable?}` — `release:yank` (the opt-in,
 * operator-granted scope that already covers taking a version out of circulation). Feed
 * retention's backfill (`packages/prune.ts`): for each package (or the one named), the builds of
 * main below its newest stable release. A DRY RUN unless `apply` is `true`; every deletion is
 * audited as `ci:<subject>`.
 */
async function handleCiPrune(ctx: ServiceContext): Promise<Response> {
  const { req, env, db, product, now } = ctx;
  const principal = await requireCiScope(
    req,
    env,
    db,
    product.slug,
    "release:yank",
    now,
  );
  if (principal instanceof Response) return principal;
  const body = await readCiBody(req);
  if (body instanceof Response) return body;
  if (body.apply !== undefined && typeof body.apply !== "boolean")
    return errorResponse(400, ErrorCode.BadRequest, "apply is a boolean", {
      reason: "bad_apply",
      fields: ["apply"],
    });
  if (body.deliverable !== undefined && typeof body.deliverable !== "string")
    return errorResponse(
      400,
      ErrorCode.BadRequest,
      "deliverable is a package deliverable id",
      { reason: "bad_deliverable", fields: ["deliverable"] },
    );
  const report = await prunePackages(db, env, product.slug, {
    apply: body.apply === true,
    ...(body.deliverable !== undefined
      ? { deliverable: body.deliverable as string }
      : {}),
    actor: { sub: ciActor(principal), name: "CI" },
    now,
  });
  if (!report)
    return errorResponse(404, ErrorCode.NotFound, "no such package", {
      reason: "unknown_deliverable",
    });
  return json({ ok: true, ...report });
}
