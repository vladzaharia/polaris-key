/// <reference types="@cloudflare/workers-types" />

/**
 * Release's own sub-router, over the path segments AFTER `/<product>/release`.
 *
 *     /release/changelog
 *     /release/install.sh            (+ the permanent alias `/<p>/install.sh`)
 *     /release/dl/:version/:binary-:arch[.dmg]
 *     /release/builds/:selector/:buildId          GET|HEAD  (P2-05, also on the bytes host)
 *     /release/files/:releaseId/:name             GET|HEAD  (P2-05, also on the bytes host)
 *     /release/blobs/sha256/:hash                 GET|HEAD  (P2-05, also on the bytes host)
 *     /release/channels/:channel/{promote,pin,unpin}  POST, `pkeyci_` + release:promote
 *     /release/releases/:releaseId/yank               POST, `pkeyci_` + release:yank
 *
 * Returning `null` for an unmatched segment is the registry contract (`core/registry.ts`): only
 * Core decides what "no route here" means, which is what makes a disabled service, an
 * unregistered slug and a bad path indistinguishable from outside.
 *
 * The alias reaches this file having been rewritten by the core router into the canonical
 * segments, so there is exactly one code path per surface and the two spellings cannot drift.
 */

import type { ServiceContext } from "../../core/registry.js";
import { errorResponse, ErrorCode, json } from "../../core/errors.js";
import { requireCiScope } from "../../core/ciScope.js";
import { normalizeArch } from "./assets.js";
import { handleRelease } from "./surfaces.js";
import { byteTargetOf, serveReleaseBytes } from "./bytes.js";
import { getReleaseConfig } from "./config.js";
import {
  applyPointerOp,
  yank,
  type PointerOp,
  type PolicyRefusal,
} from "./policy.js";

/** `<binary>-<arch>` with the arch aliases the old `/cli/` and `/dmg/` routes accepted. */
const ARCH_SUFFIX = /^(?:[^/]+)-(arm64|aarch64|x86_64|amd64)$/;

export async function handleReleaseRoutes(
  ctx: ServiceContext,
): Promise<Response | null> {
  const { req, env, db, product, rest } = ctx;

  if (rest.length === 1) {
    if (rest[0] === "changelog")
      return handleRelease(req, env, db, product, "changelog", {});
    if (rest[0] === "install.sh")
      return handleRelease(req, env, db, product, "install", {});
    return null;
  }

  // The three byte routes (P2-05) — the same handler the bytes host runs (`bytes.ts`).
  if (
    rest.length === 3 &&
    (rest[0] === "builds" || rest[0] === "files" || rest[0] === "blobs")
  ) {
    const target = byteTargetOf(rest);
    return target ? serveReleaseBytes(req, env, db, product, target) : null;
  }

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

  // /release/dl/<version>/<binary>-<arch>[.dmg]
  if (rest.length === 3 && rest[0] === "dl") {
    const version = rest[1] as string;
    const leaf = rest[2] as string;
    const dmg = leaf.endsWith(".dmg");
    const name = dmg ? leaf.slice(0, -".dmg".length) : leaf;
    const arch = normalizeArch(name.match(ARCH_SUFFIX)?.[1]);
    if (!arch) return null;
    return handleRelease(req, env, db, product, dmg ? "dmg" : "cli", {
      version,
      arch,
    });
  }

  return null;
}

// ── CI policy routes (P2-05) ─────────────────────────────────────────────────────────────────

/** A CI body is tiny (`{deliverable?, releaseId}` or `{reason}`). */
const MAX_CI_BODY_BYTES = 16 * 1024;

/** The JSON object a CI route was sent, or a 400 to answer with. */
async function readCiBody(
  req: Request,
): Promise<Record<string, unknown> | Response> {
  const bad = (message: string) =>
    errorResponse(400, ErrorCode.BadRequest, message, { reason: "bad_body" });
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_CI_BODY_BYTES)
    return bad("request body too large");
  const raw = await req.text();
  if (raw.length > MAX_CI_BODY_BYTES) return bad("request body too large");
  if (raw.trim() === "") return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v))
      return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  return bad("request body must be a JSON object");
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
  return json({ ok: true, policy: result.policy });
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
  return json({ ok: true, yank: result.yank });
}
