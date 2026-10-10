/**
 * The product's hosted assets in the console (HA-05, HA-06, HA-08; notes/S-20 §6.3, §6.4, §6.8,
 * owner decision 11). The console's Presentation page reads and writes them here:
 *
 *   GET    /manage/api/products/<slug>/assets                    every slot's copy: source,
 *                                                                status, size, the pull it owes,
 *                                                                "sizes pending", image-host URLs
 *   POST   /manage/api/products/<slug>/assets/mirror             the operator's "mirror now"
 *                                                                (HA-08): every release file that
 *                                                                still owes a copy of ours is
 *                                                                queued at once, a failed file's
 *                                                                back-off or not (a file whose
 *                                                                message is in flight is skipped),
 *                                                                at most `MIRROR_OPERATOR_MAX_PER_RUN`
 *                                                                per request (`services/release/
 *                                                                mirror.ts`); answers how many were
 *                                                                queued and how many still owe one
 *   GET    /manage/api/products/<slug>/assets/usage              HA-10: the bytes the product holds
 *                                                                against its two quotas, the
 *                                                                kill switch, and its three
 *                                                                hosted-asset settings
 *                                                                (`assets.releases.mirror`,
 *                                                                `assets.quota.mediaBytes`,
 *                                                                `assets.quota.releaseBytes`)
 *   PATCH  /manage/api/products/<slug>/assets/settings/<key>     HA-10: set one of those three
 *                                                                `{ value, expectedVersion,
 *                                                                reason? }`, through
 *                                                                `writeSetting()`
 *   DELETE /manage/api/products/<slug>/assets/settings/<key>     HA-10: drop the product's own
 *                                                                value `{ expectedVersion }`: it
 *                                                                follows the platform again
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
 * hostedMirror.ts`). A release file's copy (`release-file:<sha256>`, HA-08) is not an upload slot:
 * the console can neither upload into nor delete it here.
 *
 * CORE, like `activity`: a product has hosted assets whether or not it runs Distribution
 * (`presentation.icon` is `.pkey/product`'s). The mirror action is composed here, in the admin
 * layer, because the files and their GitHub access are Release's. Platform-admin gated and
 * CSRF-checked by the dispatcher; every write is audited with the session's actor
 * (`assets.ingest`, `assets.revert`, `assets.delete`, `assets.mirror`, and `setting.update` /
 * `setting.reset` with the setting's key for a settings write). The settings routes are the
 * bespoke console writers ST-05's generic API will alias: strict `writeSetting()` (the version is
 * required), registry keys only, and only the three `assets.*` product keys.
 */

import type { Env } from "../../platform/env.js";
import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../core/errors.js";
import {
  listHostedAssetViews,
  type HostedAssetView,
} from "../../core/assets/hostedAssetPulls.js";
import { isHostedAssetLocale } from "../../core/assets/hostedAssets.js";
import {
  isUploadSlot,
  releaseHostedAsset,
  uploadHostedAsset,
  uploadSlotMaxBytes,
} from "../../core/assets/hostedAssetUploads.js";
import { IMG_HOST_TYPES } from "../../core/assets/imgHost.js";
import { imgUrl } from "../../core/assets/imgHostname.js";
import { listingSlotMirror } from "../../services/distribution/public.js";
import { mirrorNow } from "../../services/release/public.js";
import { assetHostingEnabled } from "../../core/assets/assetHosting.js";
import {
  ASSET_PRODUCT_KEYS,
  inheritedValue,
  isAssetProductKey,
  productAssetSettings,
} from "../../core/assets/assetSettings.js";
import { assetUsage } from "../../core/assets/assetQuota.js";
import type {
  SettingConfirm,
  SettingSource,
  ValueSpec,
} from "../../core/settings/types.js";
import { writeSetting } from "../../core/settings/write.js";
import { SETTINGS } from "../../mount.js";
import { audit } from "../../core/console/audit.js";
import {
  adminJson,
  err,
  readBody,
  settingRefused,
} from "../../core/console/respond.js";
import type { AdminSession } from "../../core/console/session.js";

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

/** One of the product's hosted-asset settings, as the Presentation page edits it (HA-10). */
export interface AssetSettingDto {
  key: string;
  label: string;
  description: string;
  spec: ValueSpec;
  confirm: SettingConfirm;
  /** The value in force. */
  value: unknown;
  /** Where it came from: `console` (the product's own), `platform` (inherited) or `default`. */
  source: SettingSource;
  /** What the product follows without a value of its own (what Reset leaves). */
  inherited: unknown;
  /** The product has a value of its own. */
  own: boolean;
  /** The `expectedVersion` the next write carries (0: no value of its own). */
  version: number;
}

/** One quota: the bytes and distinct files the product holds, against the limit. */
export interface QuotaUsageDto {
  bytes: number;
  files: number;
  quota: number;
  /** No room for one byte more: new images are refused, or mirroring has stopped. */
  full: boolean;
}

/** `GET …/assets/usage` (HA-10; notes/S-20 §6.10). */
export interface AssetUsageDto {
  /** The platform kill switch `assets.hosting.enabled`. */
  hosting: boolean;
  media: QuotaUsageDto;
  release: QuotaUsageDto;
  settings: AssetSettingDto[];
}

async function usageDto(
  env: Env,
  db: Db,
  slug: string,
): Promise<AssetUsageDto | null> {
  const settings = await productAssetSettings(env, db, slug);
  if (!settings) return null;
  const used = await assetUsage(db, slug);
  const quota = (bytes: number, files: number, limit: number) => ({
    bytes,
    files,
    quota: limit,
    full: bytes >= limit,
  });
  return {
    hosting: await assetHostingEnabled(env, db),
    media: quota(used.media.bytes, used.media.files, settings.mediaQuota),
    release: quota(
      used.release.bytes,
      used.release.files,
      settings.releaseQuota,
    ),
    settings: ASSET_PRODUCT_KEYS.map((key) => {
      const def = SETTINGS.get(key, "product")!;
      const r = settings.resolved[key];
      return {
        key,
        label: def.label,
        description: def.description,
        spec: def.value,
        confirm: def.confirm,
        value: r.value,
        source: r.source,
        inherited: inheritedValue(r),
        own: r.source === "console",
        version: r.version,
      };
    }),
  };
}

/** `…/assets/usage` and `…/assets/settings/<key>` (HA-10). */
async function handleAssetSettings(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  rest: string[],
  now: number,
): Promise<Response> {
  if (rest[0] === "usage") {
    if (rest.length !== 1) return err(404, ErrorCode.NotFound);
    if (req.method !== "GET" && req.method !== "HEAD")
      return err(405, "method_not_allowed", "use GET");
    const dto = await usageDto(env, db, slug);
    return dto ? adminJson(dto) : err(404, ErrorCode.NotFound);
  }
  // `settings/<key>`: registry keys are dotted lowerCamel words, which no URL encoding changes.
  const key = rest[1];
  if (rest.length !== 2 || key === undefined || !isAssetProductKey(key))
    return err(
      404,
      ErrorCode.NotFound,
      `the hosted-asset settings are ${ASSET_PRODUCT_KEYS.join(", ")}`,
      { reason: "unknown_setting" },
    );
  if (req.method !== "PATCH" && req.method !== "DELETE")
    return err(
      405,
      "method_not_allowed",
      "use PATCH to set or DELETE to reset",
    );
  const body = await readBody(req);
  if (req.method === "PATCH" && !("value" in body))
    return err(422, ErrorCode.BadRequest, "value is required", {
      reason: "invalid_value",
      fields: ["value"],
    });
  const out = await writeSetting(
    { env, db, registry: SETTINGS },
    {
      key,
      op: req.method === "PATCH" ? "set" : "reset",
      ...(req.method === "PATCH" ? { value: body.value } : {}),
      expectedVersion:
        typeof body.expectedVersion === "number"
          ? body.expectedVersion
          : undefined,
      reason:
        typeof body.reason === "string" && body.reason.trim() !== ""
          ? body.reason.trim().slice(0, 500)
          : null,
    },
    {
      actor: {
        sub: session.sub,
        name: session.name ?? null,
        email: session.email ?? null,
      },
      origin: "console",
      now,
      product: slug,
    },
  );
  if (!out.ok) return settingRefused(out);
  const dto = await usageDto(env, db, slug);
  return dto ? adminJson(dto) : err(404, ErrorCode.NotFound);
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
  if (rest[0] === "usage" || rest[0] === "settings")
    return handleAssetSettings(req, env, db, session, slug, rest, now);
  if (rest.length === 1 && rest[0] === "mirror") {
    if (req.method !== "POST")
      return err(405, "method_not_allowed", "POST to queue the mirrors");
    const result = await mirrorNow(env, db, slug, now);
    if (!result.ok)
      return result.reason === "disabled"
        ? err(
            409,
            "mirror_disabled",
            "release-file mirroring is off for this product (Release is off, assets.releases.mirror is off, or hosted assets are off on this deployment)",
          )
        : result.reason === "quota"
          ? err(
              409,
              "asset_quota_exceeded",
              "this product holds its whole release-file quota (assets.quota.releaseBytes): mirroring has stopped and GitHub keeps serving",
              { reason: "quota" },
            )
          : err(
              503,
              "unavailable",
              "no blob store or asset queue is bound on this deployment",
            );
    await audit(
      db,
      slug,
      session,
      now,
      "assets.mirror",
      { kind: "product", id: slug },
      `Queued ${result.queued} release file${result.queued === 1 ? "" : "s"} for a copy of Polaris Key's own (${result.owed} still owe one)`,
    );
    return adminJson({ queued: result.queued, owed: result.owed });
  }
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
      if (result.reason === "quota")
        return err(422, "asset_quota_exceeded", refusalMessage(result.reason), {
          reason: result.reason,
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
    case "quota":
      return "This product holds its whole media quota (assets.quota.mediaBytes); the current copy keeps serving";
    default:
      return `The file was refused (${reason})`;
  }
}
