/// <reference types="@cloudflare/workers-types" />

/**
 * Registering derived listing assets (A-18d; notes/S-15 §5.4, §7.4, decision 2).
 *
 *     POST /<p>/distribution/listing/assets      `pkeyci_` + distribution:listing (opt-in)
 *         { ticket?, assets: [{ slot, locale?, sha256, size, width?, height?, alpha,
 *                               derivedFrom?, textAllowed }] }
 *
 * `pkey listing assets` (packages/cli/src/listingAssets.ts) makes every store's icons, composed
 * art, fitted screenshots and per-store packs in CI, where the image library is (the Worker has
 * none and makes no image). It uploads the bytes through P2-02's upload ticket (the uploads route
 * accepts `distribution:listing`) and registers them here into `dist_listing_assets`, from which
 * the storefront adapters push listing images (decision 2: listing assets from the blob store,
 * binaries never). Nothing here pushes to a store, and nothing is served: the rows are what the
 * console's slot board shows and accepts (A-18j) and what the adapters read (A-18e, A-18f, A-18m).
 *
 * ── RULES ───────────────────────────────────────────────────────────────────────────────────
 *
 *   - Every row passes the model's own validator (`assetProblems`): a known slot (the fixed
 *     slots, plus `<store>:screenshot:<class>:<n>`), the slot's text rule, a locale code, a
 *     digest, dimensions of 1 to 16,384 pixels, a known `derivedFrom`. One bad row refuses all.
 *   - Every object is `blobs/sha256/<sha256>`, earned as the release submit and the F-Droid
 *     register earn theirs (THREAT-MODEL §3): either an object an earlier register already
 *     earned (this product's `listing-asset` ref; any other ref kind does not count, since naming
 *     a digest is no proof of holding it), or an object of the caller's own ticket, verified in
 *     staging and promoted here.
 *   - An `admin` row (an image the operator uploaded in the console) is never replaced: it is
 *     answered as `kept`. A CI row is `source = 'import'`, like every other import's copy.
 *   - The rows, and the `listing-asset` refs (`<slot>@<locale>`) they hold, are written in one
 *     batch; a replaced row's old ref is dropped in the same batch, so the collector (P4-14) can
 *     reclaim bytes nothing references any more.
 *   - Audited as `distribution.listing.assets`.
 */

import type { Db, DbStatement } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { randomId } from "../../../platform/crypto.js";
import { errorResponse, ErrorCode, json } from "../../../core/errors.js";
import {
  blobKey,
  promote,
  stagingKey,
  stmtRecordRef,
  storedObjects,
  verifyStaged,
} from "../../../core/assets/blobs.js";
import {
  claimUploadTicket,
  findUploadTicket,
  releaseUploadTicket,
  type CiTokenRecord,
} from "../../../core/publisher.js";
import { ciActor, type CiPrincipal } from "../../../core/ciScope.js";
import { appendAudit } from "../../../core/repo.js";
import {
  assetProblems,
  TEXT_ALLOWED,
  type ListingAssetInput,
  type TextAllowed,
} from "../../../core/storefront/listingModel.js";
import { assetSources, stmtUpsertAsset } from "./store.js";

/** At most this many rows per register: every store's slots and packs, with room to spare. */
export const MAX_LISTING_ASSETS = 160;
/** The largest object a row may name: a store's pack (a ZIP of its outputs) is the largest. */
export const MAX_LISTING_ASSET_BYTES = 128 * 1024 * 1024;
/** The register body: 160 rows of a few hundred bytes. */
export const MAX_LISTING_ASSETS_BODY_BYTES = 96 * 1024;
/** What a listing row's blob ref is held as. */
export const LISTING_ASSET_REF = "listing-asset";

export interface ListingAssetsContext {
  env: Env;
  db: Db;
  product: string;
  now: number;
  principal: CiPrincipal;
}

interface RegisterAsset extends ListingAssetInput {
  size: number;
}

function bad(
  reason: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return errorResponse(400, ErrorCode.BadRequest, message, {
    reason,
    ...extra,
  });
}

const refId = (a: { slot: string; locale: string | null }) =>
  `${a.slot}@${a.locale ?? ""}`;

function parseAssets(raw: unknown): RegisterAsset[] | Response {
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > MAX_LISTING_ASSETS
  )
    return bad(
      "bad_assets",
      `assets must be an array of 1 to ${MAX_LISTING_ASSETS} entries`,
    );
  const out: RegisterAsset[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    const o = entry as Record<string, unknown> | null;
    if (!o || typeof o !== "object" || Array.isArray(o))
      return bad("bad_assets", `assets[${i}] must be an object`);
    const dim = (v: unknown) => (v === undefined || v === null ? null : v);
    const a = {
      slot: o.slot,
      locale: o.locale === undefined || o.locale === "" ? null : o.locale,
      blob:
        typeof o.sha256 === "string" && /^[0-9a-f]{64}$/.test(o.sha256)
          ? blobKey(o.sha256)
          : "",
      sha256: o.sha256,
      width: dim(o.width),
      height: dim(o.height),
      alpha: o.alpha,
      derivedFrom: o.derivedFrom === undefined ? null : o.derivedFrom,
      textAllowed: o.textAllowed,
      size: o.size,
    };
    if (
      typeof a.slot !== "string" ||
      (a.locale !== null && typeof a.locale !== "string") ||
      typeof a.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(a.sha256) ||
      (a.width !== null && typeof a.width !== "number") ||
      (a.height !== null && typeof a.height !== "number") ||
      typeof a.alpha !== "boolean" ||
      (a.derivedFrom !== null && typeof a.derivedFrom !== "string") ||
      !TEXT_ALLOWED.includes(a.textAllowed as TextAllowed)
    )
      return bad(
        "bad_assets",
        `assets[${i}] must be {slot, locale?, sha256 (64 lower-case hex), size, width?, height?, alpha (boolean), derivedFrom?, textAllowed (${TEXT_ALLOWED.join(" | ")})}`,
        { index: i },
      );
    if (
      typeof a.size !== "number" ||
      !Number.isSafeInteger(a.size) ||
      a.size < 1 ||
      a.size > MAX_LISTING_ASSET_BYTES
    )
      return bad(
        "bad_assets",
        `assets[${i}].size must be an integer from 1 to ${MAX_LISTING_ASSET_BYTES}`,
        { index: i },
      );
    const asset = a as RegisterAsset;
    const problems = assetProblems(asset);
    if (problems.length)
      return bad("invalid_asset", `assets[${i}] (${asset.slot}) is invalid`, {
        index: i,
        problems,
      });
    const id = refId(asset);
    if (seen.has(id))
      return bad(
        "bad_assets",
        `assets[${i}]: ${asset.slot} appears twice in one locale`,
        { index: i },
      );
    seen.add(id);
    out.push(asset);
  }
  return out.sort((x, y) => (refId(x) < refId(y) ? -1 : 1));
}

function asTokenRecord(p: CiPrincipal): CiTokenRecord | null {
  return "tokenHash" in p && "expiresAt" in p
    ? (p as unknown as CiTokenRecord)
    : null;
}

/** The keys among `keys` this product already holds as a listing row's ref. */
async function listingRefKeys(
  db: Db,
  product: string,
  keys: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  const unique = [...new Set(keys)];
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const rows = await db.all<{ storage_key: string }>(
      `SELECT DISTINCT storage_key FROM blob_refs
        WHERE product = ? AND ref_kind = ? AND storage_key IN (${chunk.map(() => "?").join(", ")})`,
      product,
      LISTING_ASSET_REF,
      ...chunk,
    );
    for (const r of rows) out.add(r.storage_key);
  }
  return out;
}

/** `POST /<p>/distribution/listing/assets` — `{ticket?, assets}`. */
export async function registerListingAssets(
  ctx: ListingAssetsContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const { env, db, product, now, principal } = ctx;
  const bucket = env.BLOBS;
  if (!bucket)
    return errorResponse(404, ErrorCode.NotFound, "no blob store here", {
      reason: "no_blob_store",
    });
  const assets = parseAssets(body.assets);
  if (assets instanceof Response) return assets;

  // Which objects an earlier register already earned, with the size promote verified. Every other
  // object comes from the caller's own ticket.
  const keys = assets.map((a) => a.blob);
  const held = await listingRefKeys(db, product, keys);
  const stored = await storedObjects(db, keys);
  const needed = new Map<string, RegisterAsset>();
  for (const a of assets) {
    if (held.has(a.blob)) {
      const s = stored.get(a.blob);
      if (!s || s.size !== a.size)
        return bad(
          "stored_object_mismatch",
          `${a.slot}: the stored object with that sha256 is not ${a.size} bytes`,
          { slot: a.slot },
        );
      continue;
    }
    const prev = needed.get(a.blob);
    if (prev && prev.size !== a.size)
      return bad(
        "bad_assets",
        `${a.slot} names ${a.sha256} with another size than ${prev.slot}`,
        { slot: a.slot },
      );
    needed.set(a.blob, a);
  }

  let claim: { ticketHash: string } | null = null;
  if (needed.size > 0) {
    const holder = asTokenRecord(principal);
    if (!holder)
      return errorResponse(401, ErrorCode.Unauthorized, "unknown CI token", {
        reason: "invalid_ci_token",
      });
    const found = await findUploadTicket(env, db, {
      ticket: body.ticket,
      product,
      holder,
      now,
    });
    if (!found.ok)
      return errorResponse(
        found.status,
        found.status === 403 ? ErrorCode.Forbidden : ErrorCode.BadRequest,
        found.message,
        { reason: found.reason },
      );
    const ticket = found.ticket;
    for (const [key, a] of needed) {
      if (
        !ticket.objects.some(
          (o) => o.sha256 === a.sha256 && o.size === a.size && !o.gated,
        )
      )
        return bad(
          "object_not_in_ticket",
          `${a.slot} (${key}) is not an object of this ticket`,
          { slot: a.slot },
        );
      const v = await verifyStaged(
        bucket,
        stagingKey(product, ticket.ticketId, a.sha256),
        { sha256: a.sha256, size: a.size },
      );
      if (!v.ok)
        return bad(
          v.reason === "missing"
            ? "staged_object_missing"
            : "staged_object_mismatch",
          `${a.slot} was ${v.reason === "missing" ? "not uploaded" : "uploaded with another sha256 or size"}`,
          { slot: a.slot },
        );
    }
    if (!(await claimUploadTicket(db, ticket.ticketHash, now)))
      return bad("ticket_redeemed", "this upload ticket was already redeemed");
    claim = { ticketHash: ticket.ticketHash };
    for (const [key, a] of needed) {
      const res = await promote(
        bucket,
        stagingKey(product, ticket.ticketId, a.sha256),
        key,
        { sha256: a.sha256, size: a.size },
        { db, now, product },
      );
      if (!res.ok) {
        await releaseUploadTicket(db, ticket.ticketHash, now);
        return errorResponse(
          409,
          ErrorCode.BadRequest,
          `${a.slot} could not be promoted`,
          { reason: "promote_failed", slot: a.slot, retryable: true },
        );
      }
    }
  }

  // An operator's own image is never replaced by CI.
  const sources = await assetSources(db, product);
  const by = ciActor(principal);
  const stmts: DbStatement[] = [];
  const written: RegisterAsset[] = [];
  const kept: { slot: string; locale: string | null }[] = [];
  for (const a of assets) {
    if (sources.get(`${a.slot}\u0000${a.locale ?? ""}`) === "admin") {
      kept.push({ slot: a.slot, locale: a.locale });
      continue;
    }
    written.push(a);
    stmts.push(
      {
        sql: "DELETE FROM blob_refs WHERE product = ? AND ref_kind = ? AND ref_id = ?",
        params: [product, LISTING_ASSET_REF, refId(a)],
      },
      stmtUpsertAsset(product, a, "import", now, by),
      stmtRecordRef(
        {
          product,
          storageKey: a.blob,
          refKind: LISTING_ASSET_REF,
          refId: refId(a),
        },
        now,
      ),
    );
  }
  if (stmts.length) {
    try {
      await db.batch(stmts);
    } catch (e) {
      if (claim) await releaseUploadTicket(db, claim.ticketHash, now);
      throw e;
    }
  }
  await appendAudit(db, {
    product,
    id: randomId("aud"),
    at: now,
    actor_sub: by,
    actor_name: "CI",
    actor_email: null,
    action: "distribution.listing.assets",
    target_kind: "listing",
    target_id: product,
    parent_id: null,
    summary:
      `Registered ${written.length} listing asset${written.length === 1 ? "" : "s"}` +
      (kept.length
        ? `; kept ${kept.length} the operator uploaded (${kept.map((k) => k.slot).join(", ")})`
        : ""),
  });
  return json({
    ok: true,
    stored: written.map((a) => ({
      slot: a.slot,
      locale: a.locale,
      sha256: a.sha256,
      blob: a.blob,
    })),
    kept,
  });
}
