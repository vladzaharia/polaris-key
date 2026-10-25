/// <reference types="@cloudflare/workers-types" />

/**
 * Reading a listed release asset's bytes from the store (P2-12.5, plans/P2-12.md §6.1).
 *
 * The legacy compute steps fetch a `.sig` / `.sha256` sidecar and the Sparkle DMG from GitHub by
 * asset id on every request. The store steps read Polaris Key's own copy first: the blob this
 * product holds a ref to under the asset's SHA-256 (HA-08's mirror, or the same bytes published
 * to R2), through `blobResponse`, which checks R2's stored checksum against that digest. Only
 * when there is no such copy does the caller read the asset by id, as `mirroredDownload` has
 * always streamed the one file it cannot serve from R2.
 *
 * The digest is the one the store offers the asset with (`storeRelease`: the sync's GitHub
 * digest from `listedAssets`, else the row's own `sha256`), accepted only in the exact shape
 * `checkedDigest` allows; it is a blob key, never a trusted value on its own.
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { blobKey, blobResponse, hasRef } from "../../core/assets/blobs.js";
import { readCappedText } from "../../core/readCapped.js";
import { NotFoundError, type ReleaseAsset } from "./github.js";
import { releaseMirrorEnabled } from "./mirrorSwitch.js";
import { checkedDigest } from "./storeRelease.js";

/** The blob response for a listed asset's R2 copy, or null when there is no usable copy. */
async function storedCopy(
  env: Env,
  db: Db,
  product: string,
  asset: Pick<ReleaseAsset, "digest" | "name">,
): Promise<Response | null> {
  const digest = checkedDigest(asset.digest);
  if (digest === null || !env.BLOBS) return null;
  const hex = digest.slice("sha256:".length);
  const key = blobKey(hex);
  if (!(await hasRef(db, product, key))) return null;
  if (!(await releaseMirrorEnabled(env, db, product))) return null;
  const res = await blobResponse(
    new Request("https://store.internal/asset", { method: "GET" }),
    env.BLOBS,
    key,
    { sha256: hex, gated: false, env, filename: asset.name },
  );
  if (res.status !== 200 || !res.body) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  return res;
}

/** The whole body of the asset's R2 copy, or null (no ref, mirroring off, object missing). */
export async function openStoredAsset(
  env: Env,
  db: Db,
  product: string,
  asset: Pick<ReleaseAsset, "digest" | "name">,
): Promise<ReadableStream<Uint8Array> | null> {
  const res = await storedCopy(env, db, product, asset);
  return res?.body ?? null;
}

/**
 * A small text asset from its R2 copy, bounded by `maxBytes` (an over-large copy is refused, not
 * truncated, as `fetchTextAsset` refuses it), or null when there is no copy.
 */
export async function storedTextAsset(
  env: Env,
  db: Db,
  product: string,
  asset: Pick<ReleaseAsset, "digest" | "name">,
  maxBytes: number,
): Promise<string | null> {
  const res = await storedCopy(env, db, product, asset);
  if (!res) return null;
  return readCappedText(
    res,
    maxBytes,
    (detail) => new NotFoundError(`asset too large: ${detail}`),
  );
}
