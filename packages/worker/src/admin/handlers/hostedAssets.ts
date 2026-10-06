/**
 * The product's hosted assets in the console (HA-05, HA-06; notes/S-20 §6.3, §6.4, owner
 * decision 11). The console's Presentation page reads and writes them here:
 *
 *   GET    /manage/api/products/<slug>/assets                    every slot's copy: source,
 *                                                                status, size, the pull it owes,
 *                                                                "sizes pending", image-host URLs
 *   POST   /manage/api/products/<slug>/assets/<slot>[?locale=]   upload: the body is the file; the
 *                                                                upload CLAIMS the slot
 *   DELETE /manage/api/products/<slug>/assets/<slot>[?locale=]   Revert to the manifest (a claim
 *                                                                the manifest still names) or
 *                                                                delete the copy
 *
 * The upload streams the body into `ingest` (HA-01) under the slot's cap: a declared
 * `Content-Length` over the cap is refused before a byte is read, and the stream is cut at the cap
 * whatever the header said. The type is sniffed, never the request's `Content-Type`. A refused
 * file changes nothing on the slot (`recordRefusal: false`). A listing-model slot (A-18) is also
 * written into `dist_listing_assets` as an `admin` row (`services/distribution/listing/
 * hostedMirror.ts`).
 *
 * CORE, like `activity`: a product has hosted assets whether or not it runs Distribution
 * (`presentation.icon` is `.pkey/product`'s). Platform-admin gated and CSRF-checked by the
 * dispatcher; every write is audited with the session's actor (`assets.ingest`, `assets.revert`,
 * `assets.delete`).
 */

import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import type { AdminSession } from "../session.js";
import { ErrorCode } from "../../core/errors.js";
import {
  listHostedAssetViews,
  type HostedAssetView,
} from "../../core/hostedAssetPulls.js";
import { isHostedAssetLocale } from "../../core/hostedAssets.js";
import {
  isUploadSlot,
  releaseHostedAsset,
  uploadHostedAsset,
  uploadSlotMaxBytes,
} from "../../core/hostedAssetUploads.js";
import { IMG_HOST_TYPES } from "../../core/imgHost.js";
import { imgUrl } from "../../core/imgHostname.js";
import { listingSlotMirror } from "../../services/distribution/listing/hostedMirror.js";
import { adminJson, err } from "../lib/respond.js";

/** The variant the Presentation page previews: the smallest rung at least this wide. */
export const PREVIEW_WIDTH = 256;

/** One slot as the console reads it: the stored facts plus where the image host serves it. */
export interface HostedAssetDto extends HostedAssetView {
  /** The original on the image host, when the host would serve it. */
  url: string | null;
  /** A variant of at least `PREVIEW_WIDTH` px (the largest there is, else the original). */
  previewUrl: string | null;
  /** May the console upload to and delete this slot (`isUploadSlot`)? */
  uploadable: boolean;
  /** The slot's byte cap, for an uploadable slot. */
  maxBytes: number | null;
}

function dtoOf(env: Env, product: string, v: HostedAssetView): HostedAssetDto {
  const serves =
    v.sha256 !== null &&
    v.contentType !== null &&
    IMG_HOST_TYPES.has(v.contentType) &&
    isUploadSlot(v.slot);
  const url = serves ? imgUrl(env, product, v.sha256!) : null;
  const rung =
    v.widths.find((w) => w >= PREVIEW_WIDTH) ?? v.widths[v.widths.length - 1];
  const previewUrl =
    url === null
      ? null
      : rung === undefined
        ? url
        : (imgUrl(env, product, v.sha256!, rung) ?? url);
  return {
    ...v,
    url,
    previewUrl,
    uploadable: isUploadSlot(v.slot),
    maxBytes: uploadSlotMaxBytes(v.slot),
  };
}

async function views(
  env: Env,
  db: Db,
  slug: string,
): Promise<HostedAssetDto[]> {
  return (await listHostedAssetViews(db, slug, { images: !!env.IMAGES })).map(
    (v) => dtoOf(env, slug, v),
  );
}

/** A path segment, decoded; `null` when it is not valid percent-encoding. */
function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export async function handleHostedAssets(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  rest: string[],
  now: number,
): Promise<Response> {
  if (rest.length === 0) {
    if (req.method !== "GET" && req.method !== "HEAD")
      return err(405, "method_not_allowed", "use GET on the list");
    return adminJson({ assets: await views(env, db, slug) });
  }
  if (rest.length !== 1) return err(404, ErrorCode.NotFound);
  if (req.method !== "POST" && req.method !== "DELETE")
    return err(405, "method_not_allowed", "use POST to upload or DELETE");
  const slot = decodeSegment(rest[0]!);
  if (slot === null || !isUploadSlot(slot))
    return err(
      400,
      "bad_slot",
      "not a slot the console can upload: presentation.icon, listing.icon, listing.header, listing.screenshot:<1-16> or a listing image slot",
    );
  const locale = new URL(req.url).searchParams.get("locale") ?? "";
  if (!isHostedAssetLocale(locale))
    return err(400, "bad_locale", "locale must be a language tag");
  const actor = {
    sub: session.sub,
    name: session.name,
    email: session.email,
  };

  if (req.method === "POST") {
    if (!env.BLOBS)
      return err(404, ErrorCode.NotFound, "no blob store here", {
        reason: "no_blob_store",
      });
    const maxBytes = uploadSlotMaxBytes(slot)!;
    const declared = req.headers.get("content-length");
    const size = declared === null ? NaN : Number(declared);
    if (!req.body || !Number.isSafeInteger(size) || size < 1)
      return err(
        411,
        "length_required",
        "send the file as the request body, with its Content-Length",
      );
    if (size > maxBytes) {
      await req.body.cancel().catch(() => undefined);
      return err(
        413,
        "too_large",
        `${slot} takes files up to ${maxBytes} bytes`,
        {
          maxBytes,
        },
      );
    }
    const result = await uploadHostedAsset(
      { env, db, now },
      slug,
      slot,
      locale,
      req.body,
      size,
      actor,
      listingSlotMirror,
    );
    if (!result.ok) {
      if (result.reason === "unavailable")
        return err(404, ErrorCode.NotFound, "no blob store here", {
          reason: "no_blob_store",
        });
      return err(422, "asset_refused", refusalMessage(result.reason), {
        reason: result.reason,
        ...(result.reason === "too-large" ? { maxBytes } : {}),
      });
    }
    const asset = (await views(env, db, slug)).find(
      (a) => a.slot === slot && a.locale === locale,
    );
    return adminJson({ asset: asset ?? null });
  }

  // DELETE: Revert, or delete-a-copy.
  const out = await releaseHostedAsset(
    { env, db, now },
    slug,
    slot,
    locale,
    actor,
    listingSlotMirror,
  );
  if (out.outcome === "missing") return err(404, ErrorCode.NotFound);
  if (out.outcome === "changed")
    return err(
      409,
      "asset_changed",
      "the slot changed since it was read (another upload or pull landed first); reload and try again",
    );
  return adminJson(out);
}

/** A refused upload, in the operator's words. */
function refusalMessage(reason: string): string {
  switch (reason) {
    case "not-an-image":
      return "That file is not a PNG, JPEG, WebP, GIF or AVIF image";
    case "too-large":
      return "That file is larger than this slot takes";
    case "size-mismatch":
      return "The upload ended before the whole file arrived; try again";
    case "retry":
      return "The file could not be stored just now; try again";
    default:
      return `The file was refused (${reason})`;
  }
}
