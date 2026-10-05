/// <reference types="@cloudflare/workers-types" />

/**
 * Copied avatars (I-07; S-16 owner decision "import profile data"; PORTAL.md §4.30 rule 3, G33).
 *
 * A provider's picture is fetched ONCE per change, server-side, and stored in R2 (the `BLOBS`
 * bucket, under `avatars/`) as an opaque random key; the portal and the consent screen load it
 * from this origin at `/media/avatar/<key>`. So the CSP keeps `img-src 'self'`, Google and Steam
 * learn nothing about who views it, and the URL never changes under a page.
 *
 * ── WHY THE FETCH IS NOT AN SSRF (THREAT-MODEL "Login card") ────────────────────────────────
 *
 *   1. ALLOWLISTED HOSTS ONLY: Google's photo hosts (`lh3`–`lh6.googleusercontent.com`) and
 *      Steam's avatar hosts. `https`, default port, no credentials. A provider-supplied URL
 *      naming anything else is ignored (no picture), never fetched.
 *   2. REDIRECTS RE-CHECKED: followed by hand, at most three, every hop against rule 1.
 *   3. BOUNDED: a 5 s budget; at most `AVATAR_MAX_BYTES`, enforced while reading.
 *   4. STRICT TYPE: the bytes must BE a PNG, JPEG, WebP or GIF by their magic numbers; the
 *      upstream `Content-Type` is ignored. SVG is never stored.
 *
 * The Worker carries no image codec, so pictures are stored as fetched (rule 4 is the strict
 * content-type alternative the design allows, as for the product media proxy). They are served
 * with the sniffed type, `nosniff`, and a `default-src 'none'; sandbox` policy.
 *
 * ── PRIVACY ─────────────────────────────────────────────────────────────────────────────────
 *
 * The key is random, not a content hash and not the account id, so the URL is no join key by
 * itself and names nobody. The keys an account holds are on its rows (`accounts.avatar_key` and
 * each link's `profile_json.avatarKey`), which is how account deletion finds and removes the
 * bytes (`deleteAccountAvatars`, called by `deleteAccount` and exported for I-11).
 */

import type { Db, Env } from "../../../core/platform.js";
import { portalSecurityHeaders } from "../portal/headers.js";

/** The R2 prefix every copied avatar lives under. */
export const AVATAR_PREFIX = "avatars/";
/** The largest picture copied. Provider avatars are a few tens of KiB. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_FETCH_TIMEOUT_MS = 5000;
export const AVATAR_MAX_REDIRECTS = 3;
/** An avatar key: 32 lower-case hex characters. */
export const AVATAR_KEY_PATTERN = /^[0-9a-f]{32}$/;

const ALLOWED_HOSTS = [
  /^lh[3-6]\.googleusercontent\.com$/,
  /^avatars\.steamstatic\.com$/,
  /^avatars\.akamai\.steamstatic\.com$/,
  /^avatars\.cloudflare\.steamstatic\.com$/,
];

/** Whether a picture URL may be fetched (rule 1). */
export function isAllowedAvatarUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return (
    u.protocol === "https:" &&
    u.port === "" &&
    u.username === "" &&
    u.password === "" &&
    ALLOWED_HOSTS.some((re) => re.test(u.hostname.toLowerCase()))
  );
}

/** The image type the bytes are, by magic number, or null. */
export function sniffImageType(bytes: Uint8Array): string | null {
  const at = (i: number) => bytes[i] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47)
    return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  )
    return "image/webp";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38)
    return "image/gif";
  return null;
}

async function readCapped(
  res: Response,
  max: number,
): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Fetch a provider picture under rules 1–4: its bytes and sniffed type, or null. */
export async function fetchProviderPicture(
  url: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const deadline = AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS);
  let current = url;
  try {
    for (let hop = 0; hop <= AVATAR_MAX_REDIRECTS; hop++) {
      if (!isAllowedAvatarUrl(current)) return null;
      const res = await fetch(current, {
        redirect: "manual",
        signal: deadline,
        headers: { accept: "image/png,image/jpeg,image/webp,image/gif" },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) return null;
        current = new URL(location, current).toString();
        continue;
      }
      if (!res.ok) return null;
      const bytes = await readCapped(res, AVATAR_MAX_BYTES);
      if (!bytes) return null;
      const contentType = sniffImageType(bytes);
      return contentType ? { bytes, contentType } : null;
    }
    return null;
  } catch {
    return null;
  }
}

function randomAvatarKey(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Copy a provider picture into R2. The new key, or null (no bucket, refused, or failed). */
export async function copyAvatar(
  env: Env,
  url: string,
): Promise<string | null> {
  if (!env.BLOBS) return null;
  const picture = await fetchProviderPicture(url);
  if (!picture) return null;
  const key = randomAvatarKey();
  try {
    await env.BLOBS.put(`${AVATAR_PREFIX}${key}`, picture.bytes, {
      httpMetadata: { contentType: picture.contentType },
    });
  } catch {
    return null;
  }
  return key;
}

/** Remove copied avatars by key (missing objects are fine). */
export async function deleteAvatars(
  env: Env,
  keys: readonly string[],
): Promise<void> {
  if (!env.BLOBS) return;
  const valid = [...new Set(keys)].filter((k) => AVATAR_KEY_PATTERN.test(k));
  for (const k of valid) {
    await env.BLOBS.delete(`${AVATAR_PREFIX}${k}`).catch(() => undefined);
  }
}

/** Every avatar key an account's rows name: its chosen picture and each link's copy. */
export async function accountAvatarKeys(
  db: Db,
  accountId: string,
): Promise<string[]> {
  const rows = await db.all<{ k: string | null }>(
    `SELECT avatar_key AS k FROM accounts WHERE id = ?
     UNION
     SELECT json_extract(profile_json, '$.avatarKey') AS k
       FROM account_links WHERE account_id = ? AND profile_json IS NOT NULL`,
    accountId,
    accountId,
  );
  return rows
    .map((r) => r.k)
    .filter((k): k is string => typeof k === "string" && k !== "");
}

/**
 * Account deletion's avatar step (I-11's hook; `deleteAccount` calls it before the rows go):
 * removes every copied picture the account's rows name. Answers how many keys it removed.
 */
export async function deleteAccountAvatars(
  env: Env,
  db: Db,
  accountId: string,
): Promise<number> {
  const keys = await accountAvatarKeys(db, accountId);
  await deleteAvatars(env, keys);
  return keys.length;
}

/** The same-origin URL of an avatar key. */
export function avatarUrl(key: string | null | undefined): string | null {
  return key && AVATAR_KEY_PATTERN.test(key) ? `/media/avatar/${key}` : null;
}

/** `GET /media/avatar/<key>`: the copied picture, or the media proxy's one 404. */
export async function serveAvatar(
  req: Request,
  env: Env,
  key: string,
): Promise<Response> {
  const notFound = () =>
    new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: portalSecurityHeaders(
        new Headers({
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        }),
      ),
    });
  if (req.method !== "GET" && req.method !== "HEAD") return notFound();
  if (!AVATAR_KEY_PATTERN.test(key) || !env.BLOBS) return notFound();
  const obj = await env.BLOBS.get(`${AVATAR_PREFIX}${key}`);
  if (!obj) return notFound();
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const type = sniffImageType(bytes);
  if (!type) return notFound();
  return new Response(req.method === "HEAD" ? null : bytes, {
    status: 200,
    headers: {
      "content-type": type,
      "content-length": String(bytes.byteLength),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      // Private and a day: a deleted account's picture must not live on in shared caches.
      "cache-control": "private, max-age=86400",
      "cross-origin-resource-policy": "cross-origin",
      "referrer-policy": "no-referrer",
    },
  });
}
