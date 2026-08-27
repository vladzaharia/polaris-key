// Credential minting + hashing. License keys are self-identifying (`pkey_<product>_…`)
// so the backend/SDK can route by product from the key alone; per-device tokens are the
// `pkeyt_` device principal of wire contract v3 §6 and never shown. Keys are stored only as
// hashes (optionally peppered so a KV/D1 dump can't confirm guessed keys).

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

function toArrayBuffer(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(
    b.byteOffset,
    b.byteOffset + b.byteLength,
  ) as ArrayBuffer;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** A license key: `pkey_<product>_<128-bit base64url>`, shown to the user once. */
export function mintLicenseKey(product: string): string {
  return `pkey_${product}_${b64url(randomBytes(16))}`;
}

/**
 * The device-token prefix (wire contract v3 §6/§8). Stable across wire-contract revisions;
 * the `plrst_` spelling the interim suite design proposed and Amendment A1 withdrew is not
 * accepted, so no second prefix is ever tolerated on this path.
 */
export const DEVICE_TOKEN_PREFIX = "pkeyt_";

/** A per-device bearer token: `pkeyt_` + 43 base64url chars (256 bits), never shown. */
export function mintDeviceToken(): string {
  return `${DEVICE_TOKEN_PREFIX}${b64url(randomBytes(32))}`;
}

/**
 * Shape gate for a presented device token.
 *
 * Cheap, and deliberately BEFORE the hash + KV/D1 lookups in `validateDeviceToken`: without it
 * "a foreign prefix is rejected" would only be true by accident (no such hash is stored), which
 * is a property of the data rather than of the code, and it would quietly stop being true the
 * moment somebody re-imported old rows. The length is checked as a floor rather than an equality
 * so a future widening of the entropy is not a wire break.
 */
export function isDeviceToken(token: string): boolean {
  return /^pkeyt_[A-Za-z0-9_-]{43,}$/.test(token);
}

/**
 * An opaque, unguessable 256-bit token with NO prefix: the browser-session cookie value and the
 * portal's single-use download token.
 *
 * Deliberately not `pkeyt_`: neither is a device principal, and a prefix that says otherwise
 * would mislead anyone reading a log or a URL. These strings identify nothing by themselves;
 * they are looked up in the one store that owns them.
 */
export function mintOpaqueToken(): string {
  return b64url(randomBytes(32));
}

/** A short opaque id with a typed prefix (lic_, dev_, flow_, …). */
export function randomId(prefix: string): string {
  return `${prefix}_${b64url(randomBytes(9))}`;
}

/** Extract the product slug from a `pkey_<product>_…` license key (or null). */
export function productFromKey(key: string): string | null {
  const m = key.match(/^pkey_([a-z0-9-]+)_[A-Za-z0-9_-]{8,}$/);
  return m ? (m[1] ?? null) : null;
}

async function sha256(input: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest(
    "SHA-256",
    toArrayBuffer(new TextEncoder().encode(input)),
  );
}

export async function sha256Hex(input: string): Promise<string> {
  return hex(await sha256(input));
}

/** SHA-256 → base64url, optionally truncated. This is the digest shape the device id
 *  (`pkey-device:…`) and the fingerprint component/hwid hashes (`pkey-hw:…`) both use, so the
 *  Worker and every SDK derive identical values from identical inputs. */
export async function sha256B64url(
  input: string,
  length?: number,
): Promise<string> {
  const digest = b64url(new Uint8Array(await sha256(input)));
  return length === undefined ? digest : digest.slice(0, length);
}

/** Hash a credential for storage. With a pepper, an offline KV dump can't confirm guesses. */
export async function hashKey(value: string, pepper?: string): Promise<string> {
  if (!pepper) return sha256Hex(value);
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(new TextEncoder().encode(pepper)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    toArrayBuffer(new TextEncoder().encode(value)),
  );
  return hex(sig);
}
