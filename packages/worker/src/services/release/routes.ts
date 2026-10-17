/// <reference types="@cloudflare/workers-types" />

/**
 * Release's routes, as a table (`core/http/routes.ts`), over the path AFTER `/<product>/release`.
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
import { ciActor } from "../../core/ciScope.js";
import { serviceRoutes, type RouteMatch } from "../../core/http/routes.js";
import { handleRelease } from "./surfaces.js";
import { getReleaseConfig } from "./config.js";
import {
  handleDelegations,
  handleStage,
  handleSubmit,
  handleToken,
  handleUploads,
} from "./publish.js";
import { handleRecordRoute } from "./recordRoute.js";
import { prunePackages } from "./packages/prune.js";
import {
  applyPointerOp,
  yank,
  type PointerOp,
  type PolicyRefusal,
} from "./policy.js";

/** A CI body is tiny (`{deliverable?, releaseId}` or `{reason}`). */
const MAX_CI_BODY_BYTES = 16 * 1024;

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

export const RELEASE_ROUTES = serviceRoutes("release", [
  {
    path: "changelog",
    methods: ["GET"],
    alsoHead: true,
    auth: { kind: "handler" },
    handler: ({ req, env, db, product }) =>
      handleRelease(req, env, db, product, "changelog", {}),
  },
  // A CI-signed release record by its hash (P3-03, `recordRoute.ts`).
  {
    path: "records/:sha256",
    methods: ["GET"],
    alsoHead: true,
    auth: { kind: "handler" },
    other: "none",
    handler: (ctx, { params }) =>
      handleRecordRoute(ctx, params.sha256 as string),
  },
  // Trusted publishing (P2-02): the OIDC exchange, upload tickets and the submit; P4-02's stage
  // round and P4-19's delegations. Each holds a publisher token and checks it in the handler.
  {
    path: "publish/token",
    methods: ["POST"],
    auth: { kind: "handler" },
    other: "none",
    handler: (ctx) => handleToken(ctx),
  },
  {
    path: "publish/uploads",
    methods: ["POST"],
    auth: { kind: "handler" },
    other: "none",
    handler: (ctx) => handleUploads(ctx),
  },
  {
    path: "publish/submit",
    methods: ["POST"],
    auth: { kind: "handler" },
    other: "none",
    handler: (ctx) => handleSubmit(ctx),
  },
  {
    path: "publish/stage",
    methods: ["POST"],
    auth: { kind: "handler" },
    other: "none",
    handler: (ctx) => handleStage(ctx),
  },
  {
    path: "publish/delegations",
    methods: ["POST"],
    auth: { kind: "handler" },
    other: "none",
    handler: (ctx) => handleDelegations(ctx),
  },
  // The CI policy routes (P2-05): `pkeyci_` token with the operation's scope.
  ...(["promote", "pin", "unpin"] as const).map((op) => ({
    path: `channels/:channel/${op}`,
    doc: `channels/{channel}/${op}`,
    methods: ["POST"] as const,
    auth: { kind: "ci", scope: "release:promote" } as const,
    bodyCap: MAX_CI_BODY_BYTES,
    other: "none" as const,
    handler: (ctx: ServiceContext, m: RouteMatch) =>
      pointer(ctx, m, m.params.channel as string, op),
  })),
  {
    path: "releases/:releaseId/yank",
    methods: ["POST"],
    auth: { kind: "ci", scope: "release:yank" },
    bodyCap: MAX_CI_BODY_BYTES,
    other: "none",
    handler: (ctx, m) => ciYank(ctx, m, m.params.releaseId as string),
  },
  {
    path: "packages/prune",
    methods: ["POST"],
    auth: { kind: "ci", scope: "release:yank" },
    bodyCap: MAX_CI_BODY_BYTES,
    other: "none",
    handler: ciPrune,
  },
]);

// ── CI policy routes (P2-05) ─────────────────────────────────────────────────────────────────

/** `POST /<p>/release/channels/<channel>/{promote,pin,unpin}` — `release:promote`. */
async function pointer(
  ctx: ServiceContext,
  m: RouteMatch,
  rawChannel: string,
  op: PointerOp,
): Promise<Response> {
  const { env, db, product, now } = ctx;
  const body = await m.readJson();
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
    { kind: "ci", principal: m.principal! },
    now,
  );
  if (!result.ok) return refusal(result);
  return json({ ok: true, policy: result.policy, packSets: result.packSets });
}

/** `POST /<p>/release/releases/<releaseId>/yank` — `release:yank`. */
async function ciYank(
  ctx: ServiceContext,
  m: RouteMatch,
  rawReleaseId: string,
): Promise<Response> {
  const { env, db, product, now } = ctx;
  const body = await m.readJson();
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
    { kind: "ci", principal: m.principal! },
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
async function ciPrune(ctx: ServiceContext, m: RouteMatch): Promise<Response> {
  const { env, db, product, now } = ctx;
  const body = await m.readJson();
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
    actor: { sub: ciActor(m.principal!), name: "CI" },
    now,
  });
  if (!report)
    return errorResponse(404, ErrorCode.NotFound, "no such package", {
      reason: "unknown_deliverable",
    });
  return json({ ok: true, ...report });
}
