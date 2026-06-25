// Credential minting + hashing. License keys are self-identifying (`pkey_<product>_…`)
// so the backend/SDK can route by product from the key alone; per-machine tokens are
// opaque (`pkeyt_…`) and never shown. Keys are stored only as hashes (optionally peppered
// so a KV/D1 dump can't confirm guessed keys).

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

/** A per-machine bearer token: opaque `pkeyt_<256-bit base64url>`, never shown. */
export function mintToken(): string {
  return `pkeyt_${b64url(randomBytes(32))}`;
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
