/// <reference types="@cloudflare/workers-types" />

/**
 * Account pictures (I-07, PX-W16; S-16 owner decision "import profile data"; PORTAL.md §4.30
 * rule 3, G33).
 *
 * A picture reaches Polaris Key two ways: a provider's picture, fetched server-side once per
 * change (Google, Steam), and an upload from Account → Profile (`POST /api/me/profile/picture`).
 * Either way it is DECODED AND RE-ENCODED before anything is stored: four renditions, WebP and PNG
 * at 256 and 96 px, square-cropped, by the Cloudflare Images binding (`env.IMAGES`). WebP and
 * PNG output always discards metadata (EXIF, GPS, XMP, comments), and the original is never kept.
 * The renditions live in the `BLOBS` bucket under `avatars/<asset>/<size>.<format>` and are served
 * same-origin at `/media/avatar/<asset>`, so the portal's CSP keeps `img-src 'self'` and neither
 * Google nor Steam learns who looks at a picture.
 *
 * ── WHY THE FETCH IS NOT AN SSRF (THREAT-MODEL "Login card") ────────────────────────────────
 *
 * There is ONE outbound fetcher, `core/safeFetch.ts` (S-20 §6.3); this module adds only its own,
 * narrower host rule (`allowHost`, checked on the first URL and on every redirect hop):
 *
 *   1. ALLOWLISTED HOSTS ONLY: Google's photo hosts (`lh3`–`lh6.googleusercontent.com`) and
 *      Steam's avatar hosts, on top of the guard (`https`, port 443, no userinfo, no IP literal,
 *      never our own zone). A provider-supplied URL naming anything else is never fetched.
 *   2. REDIRECTS RE-CHECKED: by hand, at most three, every hop against rule 1 before it is dialled.
 *   3. BOUNDED: a 5 s budget; at most `PROVIDER_PICTURE_MAX_BYTES`, counted while reading.
 *   4. STRICT TYPE: the bytes must BE a PNG, JPEG, WebP or GIF by magic number (`core/sniff.ts`,
 *      which can never answer SVG or HTML); the upstream `Content-Type` is ignored.
 *
 * The URL comes from the provider's own answer (Google's ID token, Steam's Web API), never from a
 * request a visitor can shape.
 *
 * ── NEVER ACTIVE CONTENT ────────────────────────────────────────────────────────────────────
 *
 * Bytes a person or a provider supplied are parsed by the Images service, never by the Worker,
 * and what is stored is the encoder's output. The media route serves a rendition only when its
 * bytes sniff as the WebP or PNG its name says, with `nosniff`, `default-src 'none'; sandbox`
 * and `Content-Disposition: inline`, so the response can be an image and nothing else. Without
 * the Images binding nothing is copied (the account shows initials): a picture is never stored
 * as fetched.
 *
 * ── CONTENT-ADDRESSED, PER ACCOUNT ──────────────────────────────────────────────────────────
 *
 * The asset id is `HMAC(KEY_HASH_PEPPER, "avatar:v1:" ‖ account ‖ SHA-256 of the source bytes)`:
 * the same picture is stored once per account and its URL never changes, but the id names nobody
 * and cannot be computed from a public provider picture, so it is no join key. One
 * `account_avatars` row per asset records whose it is; what USES an asset is
 * `accounts.avatar_key` (the picture in use) and each link's `profile_json.avatarKey` (that
 * provider's copy).
 *
 * ── DELETION AND GARBAGE COLLECTION ─────────────────────────────────────────────────────────
 *
 *   - A replaced picture is deleted at once when nothing uses it any more (`releaseAvatars`).
 *   - An upload not put to use is kept for `AVATAR_GC_GRACE_SECONDS` (the profile editor's Save
 *     follows it), at most `AVATAR_PENDING_UPLOADS` of them per account.
 *   - The nightly sweep (`sweepAvatars`, `scheduled.ts`) deletes every asset nothing uses that is
 *     older than the grace period: a disconnected provider's copy, a merged account's leftovers,
 *     an upload never saved, and the rows of a write that died half way.
 *   - Account deletion deletes every asset the account owns or uses, objects first, then rows
 *     (`deleteAccountAvatars`, called by `deleteAccount`).
 *
 * `avatars/` carries no R2 age lock (unlike `blobs/`), which is why avatars are not hosted assets:
 * a deleted account's picture must be gone at once, not in 180 days.
 */

import { hashKey, type Db, type Env } from "../../../core/platform.js";
import {
  cappedStream,
  guardUrl,
  safeFetch,
  TooLargeError,
  type FetchImpl,
  type SafeFetchReason,
} from "../../../core/safeFetch.js";
import { sniffContentType, SNIFF_BYTES } from "../../../core/sniff.js";
import { portalSecurityHeaders } from "../portal/headers.js";

/** The R2 prefix every avatar rendition lives under. */
export const AVATAR_PREFIX = "avatars/";
/** An asset id: 64 lower-case hex characters. */
export const AVATAR_ASSET_PATTERN = /^[0-9a-f]{64}$/;
/**
 * I-07's pre-re-encoding keys (32 hex, one object at `avatars/<key>`). Never served; replacement
 * and deletion still remove them. I-07 had not shipped when PX-W16 replaced it, so none should
 * exist; this keeps an early deploy of I-07 alone from leaving any behind.
 */
const LEGACY_KEY_PATTERN = /^[0-9a-f]{32}$/;

/** The renditions, in the order they are encoded. 256 is the size served by default. */
export const AVATAR_SIZES = [256, 96] as const;
export type AvatarSize = (typeof AVATAR_SIZES)[number];
export const AVATAR_FORMATS = ["webp", "png"] as const;
export type AvatarFormat = (typeof AVATAR_FORMATS)[number];
const MIME: Record<AvatarFormat, "image/webp" | "image/png"> = {
  webp: "image/webp",
  png: "image/png",
};

/** The largest provider picture fetched. Provider avatars are a few tens of KiB. */
export const PROVIDER_PICTURE_MAX_BYTES = 2 * 1024 * 1024;
/** The largest upload accepted (PORTAL.md §4.30: "up to 5 MB"). */
export const AVATAR_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
/** The provider fetch's budget: every hop, the headers and the body. */
export const AVATAR_FETCH_TIMEOUT_MS = 5000;
/** A sanity cap on one encoded rendition (a 256 px PNG is at most ~260 KiB). */
export const AVATAR_RENDITION_MAX_BYTES = 512 * 1024;
/** How long an asset nothing uses is kept before the sweep deletes it. */
export const AVATAR_GC_GRACE_SECONDS = 24 * 60 * 60;
/** Uploads not yet put to use, kept per account (the newest; older ones are deleted at once). */
export const AVATAR_PENDING_UPLOADS = 3;
/** Assets the nightly sweep deletes per run at most. */
export const AVATAR_SWEEP_BATCH = 200;

/** What a provider picture may be (rule 4). */
const PROVIDER_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
/** What an upload may be (PORTAL.md §4.30: PNG or JPEG). */
export const UPLOAD_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
]);

const ALLOWED_HOSTS = [
  /^lh[3-6]\.googleusercontent\.com$/,
  /^avatars\.steamstatic\.com$/,
  /^avatars\.akamai\.steamstatic\.com$/,
  /^avatars\.cloudflare\.steamstatic\.com$/,
];

/** Whether a host is one of the providers' picture hosts (rule 1, this route's `allowHost`). */
export function isAllowedAvatarHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return ALLOWED_HOSTS.some((re) => re.test(h));
}

/** Whether a picture URL may be fetched: the guard, then the provider hosts (rule 1). */
export function isAllowedAvatarUrl(raw: string): boolean {
  if (typeof raw !== "string" || guardUrl(raw) !== null) return false;
  return isAllowedAvatarHost(new URL(raw).hostname);
}

async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Read a body under `maxBytes`, counted while reading: its bytes, or `too-large`. */
export async function readBodyCapped(
  body: ReadableStream | null,
  maxBytes: number,
): Promise<Uint8Array | "too-large"> {
  if (!body) return new Uint8Array(0);
  try {
    return await readAll(cappedStream(body, maxBytes));
  } catch (err) {
    if (err instanceof TooLargeError) return "too-large";
    throw err;
  }
}

export type PictureFetch =
  | { ok: true; bytes: Uint8Array; contentType: string }
  | { ok: false; reason: SafeFetchReason | "not-an-image" };

/** Fetch a provider picture under rules 1–4, through the one guarded fetcher. */
export async function fetchProviderPicture(
  url: string,
  opts: { fetchImpl?: FetchImpl } = {},
): Promise<PictureFetch> {
  const res = await safeFetch(url, {
    maxBytes: PROVIDER_PICTURE_MAX_BYTES,
    timeoutMs: AVATAR_FETCH_TIMEOUT_MS,
    headers: { accept: [...PROVIDER_TYPES].join(", ") },
    allowHost: isAllowedAvatarHost,
    fetchImpl: opts.fetchImpl,
  });
  if (!res.ok) return { ok: false, reason: res.reason };
  if (res.status !== 200) return { ok: false, reason: "status:304" };
  let bytes: Uint8Array;
  try {
    bytes = await readAll(res.body);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof TooLargeError ? "too-large" : "network",
    };
  }
  const contentType = sniffContentType(bytes.subarray(0, SNIFF_BYTES));
  if (!PROVIDER_TYPES.has(contentType))
    return { ok: false, reason: "not-an-image" };
  return { ok: true, bytes, contentType };
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Response(bytes).body as ReadableStream<Uint8Array>;
}

/** The R2 key of one rendition. */
export function renditionKey(
  asset: string,
  size: AvatarSize,
  format: AvatarFormat,
): string {
  return `${AVATAR_PREFIX}${asset}/${size}.${format}`;
}

/**
 * Decode `source` and encode one rendition: square-cropped (`fit: cover`), one frame, metadata
 * discarded. `null` when the binding refuses the input (not an image it reads, too large) or
 * answers anything but a bounded image of the asked type.
 */
export async function encodeRendition(
  images: ImagesBinding,
  source: Uint8Array,
  size: AvatarSize,
  format: AvatarFormat,
): Promise<Uint8Array | null> {
  try {
    const result = await images
      .input(streamOf(source))
      .transform({ width: size, height: size, fit: "cover" })
      .output({ format: MIME[format], anim: false });
    const bytes = await readBodyCapped(
      result.image(),
      AVATAR_RENDITION_MAX_BYTES,
    );
    if (bytes === "too-large" || bytes.byteLength === 0) return null;
    return sniffContentType(bytes.subarray(0, SNIFF_BYTES)) === MIME[format]
      ? bytes
      : null;
  } catch {
    return null;
  }
}

/** All four renditions of `source`, or `null` if any one fails. */
async function encodeAll(
  images: ImagesBinding,
  source: Uint8Array,
): Promise<Map<string, Uint8Array> | null> {
  const out = new Map<string, Uint8Array>();
  for (const size of AVATAR_SIZES) {
    for (const format of AVATAR_FORMATS) {
      const bytes = await encodeRendition(images, source, size, format);
      if (!bytes) return null;
      out.set(`${size}.${format}`, bytes);
    }
  }
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type AvatarOrigin = "provider" | "upload";

export type StoreResult =
  | { ok: true; asset: string }
  | {
      ok: false;
      /** `unavailable`: no blob store or no Images binding. `unreadable`: not an image the encoder
       *  reads. `retry`: the store refused a write. */
      reason: "unavailable" | "unreadable" | "retry";
    };

/**
 * Re-encode `bytes` and store the four renditions as one of `accountId`'s assets. The row goes in
 * before the objects, so a write that dies half way leaves a row the sweep finds. The same source
 * for the same account is the same asset: its row's clock is reset and the renditions rewritten
 * (an upload of a provider's picture becomes an upload).
 */
export async function storeAvatar(
  env: Env,
  db: Db,
  input: { accountId: string; bytes: Uint8Array; origin: AvatarOrigin },
  now: number,
): Promise<StoreResult> {
  const bucket = env.BLOBS;
  if (!bucket || !env.IMAGES) return { ok: false, reason: "unavailable" };
  const renditions = await encodeAll(env.IMAGES, input.bytes);
  if (!renditions) return { ok: false, reason: "unreadable" };
  const asset = await hashKey(
    `avatar:v1:${input.accountId}:${await sha256Hex(input.bytes)}`,
    env.KEY_HASH_PEPPER,
  );
  let total = 0;
  for (const b of renditions.values()) total += b.byteLength;
  await db.run(
    `INSERT INTO account_avatars (asset, account_id, origin, bytes, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(asset) DO UPDATE SET
       created_at = excluded.created_at,
       origin = CASE WHEN excluded.origin = 'upload' THEN 'upload'
                     ELSE account_avatars.origin END`,
    asset,
    input.accountId,
    input.origin,
    total,
    now,
  );
  try {
    for (const size of AVATAR_SIZES) {
      for (const format of AVATAR_FORMATS) {
        await bucket.put(
          renditionKey(asset, size, format),
          renditions.get(`${size}.${format}`)!,
          { httpMetadata: { contentType: MIME[format] } },
        );
      }
    }
  } catch {
    // Nothing points at it yet: the sweep removes the row and whatever landed.
    return { ok: false, reason: "retry" };
  }
  return { ok: true, asset };
}

/** Copy a provider picture: fetch it (rules 1–4), re-encode and store it. The asset, or null. */
export async function copyProviderAvatar(
  env: Env,
  db: Db,
  accountId: string,
  url: string,
  now: number,
): Promise<string | null> {
  if (!env.BLOBS || !env.IMAGES || !isAllowedAvatarUrl(url)) return null;
  const picture = await fetchProviderPicture(url);
  if (!picture.ok) return null;
  const stored = await storeAvatar(
    env,
    db,
    { accountId, bytes: picture.bytes, origin: "provider" },
    now,
  );
  return stored.ok ? stored.asset : null;
}

// ── References, deletion and the sweep ─────────────────────────────────────────────────────

/**
 * Whether an asset (or a legacy key) is in use by any account or any link. Every such read uses
 * `idx_accounts_avatar_key` and the expression index `idx_account_links_avatar`; a correlated
 * read compares with `+a.asset`, which drops the column's TEXT affinity so SQLite can SEARCH the
 * expression index instead of scanning it.
 */
export async function avatarReferenced(db: Db, key: string): Promise<boolean> {
  const row = await db.first<{ n: number }>(
    `SELECT EXISTS (SELECT 1 FROM accounts WHERE avatar_key = ?)
         OR EXISTS (SELECT 1 FROM account_links
                     WHERE json_extract(profile_json, '$.avatarKey') = ?) AS n`,
    key,
    key,
  );
  return (row?.n ?? 0) > 0;
}

/** Delete one asset's renditions (or a legacy key's one object). Missing objects are fine. */
async function deleteObjects(env: Env, key: string): Promise<void> {
  if (!env.BLOBS) return;
  if (LEGACY_KEY_PATTERN.test(key)) {
    await env.BLOBS.delete(`${AVATAR_PREFIX}${key}`);
    return;
  }
  if (!AVATAR_ASSET_PATTERN.test(key)) return;
  const keys: string[] = [];
  for (const size of AVATAR_SIZES)
    for (const format of AVATAR_FORMATS)
      keys.push(renditionKey(key, size, format));
  await env.BLOBS.delete(keys);
}

/** Delete an asset: its objects first, then its row (a failed object delete keeps the row). */
async function deleteAsset(env: Env, db: Db, key: string): Promise<boolean> {
  try {
    await deleteObjects(env, key);
  } catch {
    return false;
  }
  await db.run("DELETE FROM account_avatars WHERE asset = ?", key);
  return true;
}

/**
 * Delete the given assets that nothing uses any more (a replaced provider copy, the picture an
 * edit moved away from). Answers how many went.
 */
export async function releaseAvatars(
  env: Env,
  db: Db,
  keys: ReadonlyArray<string | null | undefined>,
): Promise<number> {
  let n = 0;
  for (const k of new Set(keys)) {
    if (typeof k !== "string" || k === "") continue;
    if (await avatarReferenced(db, k)) continue;
    if (await deleteAsset(env, db, k)) n++;
  }
  return n;
}

/**
 * After an upload (`latest`), keep the newest `AVATAR_PENDING_UPLOADS` uploads `accountId` has not
 * put to use, `latest` among them, and delete the rest at once, so uploading in a loop cannot pile
 * up storage between sweeps.
 */
export async function prunePendingUploads(
  env: Env,
  db: Db,
  accountId: string,
  latest: string,
): Promise<number> {
  const rows = await db.all<{ asset: string }>(
    `SELECT a.asset FROM account_avatars a
      WHERE a.account_id = ? AND a.origin = 'upload' AND a.asset <> ?
        AND NOT EXISTS (SELECT 1 FROM accounts x WHERE x.avatar_key = a.asset)
        AND NOT EXISTS (SELECT 1 FROM account_links l
                         WHERE json_extract(l.profile_json, '$.avatarKey') = +a.asset)
      ORDER BY a.created_at DESC, a.asset
      LIMIT -1 OFFSET ?`,
    accountId,
    latest,
    AVATAR_PENDING_UPLOADS - 1,
  );
  let n = 0;
  for (const r of rows) if (await deleteAsset(env, db, r.asset)) n++;
  return n;
}

/** Every asset an account owns (its rows) or uses (its picture, each link's copy). */
export async function accountAvatarKeys(
  db: Db,
  accountId: string,
): Promise<string[]> {
  const rows = await db.all<{ k: string | null }>(
    `SELECT asset AS k FROM account_avatars WHERE account_id = ?
     UNION
     SELECT avatar_key AS k FROM accounts WHERE id = ?
     UNION
     SELECT json_extract(profile_json, '$.avatarKey') AS k
       FROM account_links WHERE account_id = ? AND profile_json IS NOT NULL`,
    accountId,
    accountId,
    accountId,
  );
  return rows
    .map((r) => r.k)
    .filter((k): k is string => typeof k === "string" && k !== "");
}

/** Whether an account other than `accountId` uses `key`. */
async function usedElsewhere(
  db: Db,
  key: string,
  accountId: string,
): Promise<boolean> {
  const row = await db.first<{ n: number }>(
    `SELECT EXISTS (SELECT 1 FROM accounts WHERE avatar_key = ? AND id <> ?)
         OR EXISTS (SELECT 1 FROM account_links
                     WHERE json_extract(profile_json, '$.avatarKey') = ?
                       AND account_id <> ?) AS n`,
    key,
    accountId,
    key,
    accountId,
  );
  return (row?.n ?? 0) > 0;
}

/**
 * Account deletion's picture step (`deleteAccount` calls it before the rows go; I-11 reuses it):
 * deletes every rendition of every asset the account owns or uses, then those assets' rows. An
 * asset whose objects the store refused to delete keeps a row with its clock at zero, so the next
 * nightly sweep deletes it once the account's rows are gone; the deletion itself goes on. Answers
 * how many assets went.
 */
export async function deleteAccountAvatars(
  env: Env,
  db: Db,
  accountId: string,
): Promise<number> {
  const keys = await accountAvatarKeys(db, accountId);
  let n = 0;
  for (const k of keys) {
    if (await usedElsewhere(db, k, accountId)) continue;
    try {
      await deleteObjects(env, k);
    } catch {
      await db.run(
        `INSERT INTO account_avatars (asset, account_id, origin, bytes, created_at)
         VALUES (?, ?, 'provider', 0, 0)
         ON CONFLICT(asset) DO UPDATE SET created_at = 0`,
        k,
        accountId,
      );
      continue;
    }
    await db.run("DELETE FROM account_avatars WHERE asset = ?", k);
    n++;
  }
  return n;
}

/**
 * The nightly sweep: delete the assets nothing uses that are older than the grace period, at most
 * `AVATAR_SWEEP_BATCH` a run (a backlog drains over several nights). Idempotent. Answers how many
 * assets went.
 */
export async function sweepAvatars(
  env: Env,
  db: Db,
  now: number,
): Promise<number> {
  if (!env.BLOBS) return 0;
  const cutoff = now - AVATAR_GC_GRACE_SECONDS;
  const rows = await db.all<{ asset: string }>(
    `SELECT a.asset FROM account_avatars a
      WHERE a.created_at < ?
        AND NOT EXISTS (SELECT 1 FROM accounts x WHERE x.avatar_key = a.asset)
        AND NOT EXISTS (SELECT 1 FROM account_links l
                         WHERE json_extract(l.profile_json, '$.avatarKey') = +a.asset)
      ORDER BY a.created_at
      LIMIT ?`,
    cutoff,
    AVATAR_SWEEP_BATCH,
  );
  let n = 0;
  for (const r of rows) {
    try {
      await deleteObjects(env, r.asset);
    } catch {
      continue;
    }
    // Only while it is still old: a re-store since the select reset its clock and keeps the row.
    // (Its objects may just have gone with this delete; the person then sees initials until the
    // picture next changes. Benign, and it needs a byte-identical re-store within milliseconds of
    // the nightly sweep reaching a picture nothing used for a day.)
    await db.run(
      "DELETE FROM account_avatars WHERE asset = ? AND created_at < ?",
      r.asset,
      cutoff,
    );
    n++;
  }
  return n;
}

// ── Serving ────────────────────────────────────────────────────────────────────────────────

/** An asset as the portal API hands it out: the id and its same-origin URLs. */
export interface AvatarView {
  asset: string;
  /** 256 px, WebP or PNG by the browser's `Accept`. */
  url: string;
  /** 96 px, likewise. */
  url96: string;
}

/** The same-origin URL of an asset (256 px), or null for anything that is not one. */
export function avatarUrl(key: string | null | undefined): string | null {
  return key && AVATAR_ASSET_PATTERN.test(key) ? `/media/avatar/${key}` : null;
}

export function avatarView(key: string | null | undefined): AvatarView | null {
  const url = avatarUrl(key);
  return url ? { asset: key!, url, url96: `${url}-96` } : null;
}

const AVATAR_SEGMENT = /^([0-9a-f]{64})(?:-(96|256))?(?:\.(webp|png))?$/;

/** `<asset>[-96|-256][.webp|.png]`, what `/media/avatar/<segment>` names, or null. */
export function parseAvatarSegment(segment: string): {
  asset: string;
  size: AvatarSize;
  format: AvatarFormat | null;
} | null {
  const m = AVATAR_SEGMENT.exec(segment);
  if (!m) return null;
  return {
    asset: m[1]!,
    size: m[2] === "96" ? 96 : 256,
    format: (m[3] as AvatarFormat | undefined) ?? null,
  };
}

/** The format for a request that named none: WebP when the browser takes it, else PNG. */
export function negotiateFormat(accept: string | null): AvatarFormat {
  return /(^|[\s,])image\/webp\s*(;|,|$)/i.test(accept ?? "") ? "webp" : "png";
}

/** The response's own policy: an image is never a document and never framed. */
export const AVATAR_CSP = "default-src 'none'; sandbox";
/** Private and a day: a deleted account's picture must not live on in shared caches. */
export const AVATAR_CACHE = "private, max-age=86400";

/**
 * The headers of an avatar response. Exported for the CSP browser test, which serves its images
 * with exactly these.
 */
export function avatarResponseHeaders(
  contentType: "image/webp" | "image/png",
  extra: Record<string, string> = {},
): Headers {
  return new Headers({
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    "content-security-policy": AVATAR_CSP,
    "content-disposition": `inline; filename="avatar.${contentType === "image/webp" ? "webp" : "png"}"`,
    "cache-control": AVATAR_CACHE,
    // An app shows the picture on its own origin after the consent step (PORTAL.md §4.30 rule 4),
    // so it may be embedded cross-origin; the URL is unguessable.
    "cross-origin-resource-policy": "cross-origin",
    "referrer-policy": "no-referrer",
    ...extra,
  });
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: "not_found" }), {
    status: 404,
    headers: portalSecurityHeaders(
      new Headers({
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      }),
    ),
  });
}

/**
 * `GET /media/avatar/<asset>[-96][.webp|.png]`: one stored rendition, or the media proxy's one
 * 404. A rendition whose bytes do not sniff as the type its name says is not served.
 */
export async function serveAvatar(
  req: Request,
  env: Env,
  segment: string,
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return notFound();
  const named = parseAvatarSegment(segment);
  if (!named || !env.BLOBS) return notFound();
  const format = named.format ?? negotiateFormat(req.headers.get("accept"));
  const key = renditionKey(named.asset, named.size, format);
  const etag = `"${named.asset}-${named.size}.${format}"`;
  const vary: Record<string, string> = named.format ? {} : { vary: "Accept" };
  if (req.headers.get("if-none-match") === etag) {
    // Still there: a deleted account's picture must not be revalidated from a browser cache.
    if (!(await env.BLOBS.head(key))) return notFound();
    return new Response(null, {
      status: 304,
      headers: avatarResponseHeaders(MIME[format], { etag, ...vary }),
    });
  }
  const obj = await env.BLOBS.get(key);
  if (!obj) return notFound();
  const bytes = new Uint8Array(await obj.arrayBuffer());
  if (sniffContentType(bytes.subarray(0, SNIFF_BYTES)) !== MIME[format])
    return notFound();
  return new Response(req.method === "HEAD" ? null : bytes, {
    status: 200,
    headers: avatarResponseHeaders(MIME[format], {
      "content-length": String(bytes.byteLength),
      etag,
      ...vary,
    }),
  });
}

/**
 * `GET /api/signin/confirm-email/picture`: the provider's picture for the email gate, before any
 * account exists. Fetched under rules 1–4 and re-encoded like a stored one (256 px, the
 * negotiated format), but stored nowhere and never cached.
 */
export async function serveProviderPreview(
  req: Request,
  env: Env,
  url: string | null | undefined,
): Promise<Response> {
  if (!url || !env.IMAGES || !isAllowedAvatarUrl(url)) return notFound();
  const picture = await fetchProviderPicture(url);
  if (!picture.ok) return notFound();
  const format = negotiateFormat(req.headers.get("accept"));
  const bytes = await encodeRendition(env.IMAGES, picture.bytes, 256, format);
  if (!bytes) return notFound();
  return new Response(bytes, {
    status: 200,
    headers: avatarResponseHeaders(MIME[format], {
      "content-length": String(bytes.byteLength),
      "cache-control": "no-store",
      vary: "Accept",
    }),
  });
}
