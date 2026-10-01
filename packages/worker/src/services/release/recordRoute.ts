/// <reference types="@cloudflare/workers-types" />

/**
 * `GET|HEAD /<product>/release/records/<sha256>` — one CI-signed release record, by its hash
 * (P3-03, plans/P3-01.md §6; WIRE-CONTRACT-V4 §2.4–§2.5).
 *
 * The body is the stored compact JWS, byte for byte, so its SHA-256 is the path: the client
 * checks the hash BEFORE any signature work (§2.5 step 12), and where the bytes came from never
 * matters to trust. A record is immutable, so it is `public, max-age=31536000, immutable` when
 * the release METADATA mode is `public`, and the gated blob's `private, no-store` otherwise.
 *
 * Access, in the order of Distribution's blob route:
 *
 *   1. the metadata mode's request-level check. Under `entitled` it proves only a usable licence
 *      (the stable channel every grant holds), as the blob route's does;
 *   2. an unknown hash is the plain not-found, so the route is no oracle for which records exist
 *      to a caller who has not passed (1);
 *   3. under `entitled`, the blob route's rule applied to the record's own release: the licence's
 *      version window must admit that release's STORED version (`fixedVersion`, never a
 *      selector). A hash learned elsewhere unlocks nothing the device could not already
 *      download from that release. A device refused here decides with no record.
 */

import type { ServiceContext } from "../../core/registry.js";
import { errorResponse, notFound } from "../../core/errors.js";
import { appSecurityHeaders, bearer } from "../../core/platform.js";
import { accessRefusal } from "../../core/entitledAccess.js";
import { clientIp, rateLimitOk } from "../../core/rateLimit.js";
import { enforceReleaseAccess, entitledSelectorFor } from "./access.js";
import { accessModeFor, artifactPolicy, getReleaseConfig } from "./config.js";
import { getRecordByHash, isRecordHash } from "./records.js";

/** A record is fetched once per release per device; a probe walking hashes is not. */
const RECORD_RATE_LIMIT = { limit: 60, windowSec: 60 } as const;

const PUBLIC_RECORD_CACHE = "public, max-age=31536000, immutable, no-transform";
const GATED_RECORD_CACHE = "private, no-store, no-transform";

function harden(res: Response): Response {
  return new Response(res.body, {
    status: res.status,
    headers: appSecurityHeaders(new Headers(res.headers)),
  });
}

export async function handleRecordRoute(
  ctx: ServiceContext,
  rawHash: string,
): Promise<Response | null> {
  const { req, env, db, product, now } = ctx;
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  if (!isRecordHash(rawHash)) return null;
  const cfg = await getReleaseConfig(db, product.slug);
  if (!cfg) return null;

  const mode = accessModeFor(artifactPolicy(cfg), "record");
  // 1. The request-level check: under `entitled`, a usable licence (no channel or version yet).
  const denied = await accessRefusal(
    env,
    db,
    product,
    bearer(req),
    mode,
    entitledSelectorFor(cfg, "record", {}),
    false,
    now,
  );
  if (denied) return harden(denied);

  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { bucket: "releaseRecord", id: clientIp(req), ...RECORD_RATE_LIMIT },
      now,
    ))
  )
    return harden(
      errorResponse(429, "rate_limited", "too many release record requests"),
    );

  // 2. An unknown hash: the plain not-found.
  const row = await getRecordByHash(db, product.slug, rawHash);
  if (!row) return harden(notFound());

  // 3. Under `entitled`, the record's own release's stored version, pinned.
  if (mode === "entitled") {
    const release = await db.first<{ version: string }>(
      "SELECT version FROM release_metadata WHERE product = ? AND release_id = ?",
      product.slug,
      row.release_id,
    );
    const refused = await enforceReleaseAccess(
      req,
      env,
      db,
      product,
      cfg,
      "record",
      { fixedVersion: release?.version ?? "" },
      now,
    );
    if (refused) return harden(refused);
  }

  const etag = `"${row.record_sha256}"`;
  const headers: Record<string, string> = {
    "content-type": "application/jose",
    "cache-control":
      mode === "public" ? PUBLIC_RECORD_CACHE : GATED_RECORD_CACHE,
    etag,
    "x-content-type-options": "nosniff",
  };
  const inm = req.headers.get("if-none-match");
  if (
    inm !== null &&
    inm
      .split(",")
      .map((t) => t.trim().replace(/^W\//, ""))
      .some((t) => t === etag || t === "*")
  )
    return harden(new Response(null, { status: 304, headers }));
  headers["content-length"] = String(row.jws.length);
  return harden(
    new Response(req.method === "HEAD" ? null : row.jws, {
      status: 200,
      headers,
    }),
  );
}
