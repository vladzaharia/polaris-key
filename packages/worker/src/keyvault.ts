/// <reference types="@cloudflare/workers-types" />

// KEK-based key custody. Per-product signing keys + secrets are envelope-encrypted in D1
// under a platform KEK KEYRING: one ACTIVE kid used for every new `seal`, plus any number of
// secondary kids that `open` will still accept. Each KEK is base64 of 32 random bytes and
// imports as a raw AES-256-GCM key; the sealed blob carries a fresh 12-byte nonce so the same
// plaintext never produces the same ciphertext, and its own `kekId` so `open` can pick the
// right key out of the ring.
//
// The ring is what makes a KEK rotation survivable (R2-09): add the new key as a secondary,
// promote it to active, re-seal every row through the admin sweep, then retire the old key —
// with the platform serving throughout. See docs/RUNBOOK.md § "Rotating PLATFORM_KEK".
//
// `open` still fails CLOSED on a missing/unusable keyring, an unknown `kekId`, or any
// auth-tag mismatch — it NEVER returns a wrong or partial plaintext.

import type { Env } from "./env.js";

/** A sealed value: AES-256-GCM under a versioned platform KEK. `aad` is not stored; callers
 *  provide it again on open so ciphertext is bound to product/kind/name metadata.
 *
 *  `v` MUST NOT be bumped for a KEK rotation: every blob written before the keyring existed is
 *  a v2 blob and has to keep opening unchanged, and the AAD (below) deliberately excludes
 *  `kekId` so that re-sealing a value under a different KEK does not change its binding. */
export interface Sealed {
  v: 2;
  kekId: string;
  iv: string;
  ct: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function toArrayBuffer(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(
    b.byteOffset,
    b.byteOffset + b.byteLength,
  ) as ArrayBuffer;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Decode a standard base64 string (the KEK is base64, not base64url). */
function b64Decode(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The slot a sealed value is bound to; it becomes the AAD `pkey:v2:<product>:<kind>:<id>`.
 *
 * `kind` is what separates custody domains cryptographically, not only by table: a blob sealed
 * as an `outlet-credential` (P5-01 — a store's API key, held in `outlet_credentials`) cannot be
 * opened as a `product-secret` even if it is copied into `product_secrets` under the same name,
 * because the AAD differs and AES-GCM refuses it.
 */
export interface SealContext {
  product: string;
  kind: "signing-key" | "product-secret" | "outlet-credential";
  id: string;
}

/** The AAD binding a ciphertext to its slot. Deliberately DOES NOT include the KEK id: a
 *  re-seal under a new KEK must reuse the same AAD, or rotation would need a new envelope
 *  version and a second migration to escape the first one. */
function aad(ctx: SealContext): ArrayBuffer {
  return toArrayBuffer(
    enc.encode(`pkey:v2:${ctx.product}:${ctx.kind}:${ctx.id}`),
  );
}

/** The kid a pre-keyring deployment's blobs carry, i.e. what `seal` wrote when only
 *  `PLATFORM_KEK` existed and `PLATFORM_KEK_ID` was unset. */
const LEGACY_KEK_ID = "default";

interface Keyring {
  /** The kid every NEW seal is written under. */
  active: string;
  /** Every kid `open` will accept, active included. */
  keys: Map<string, CryptoKey>;
}

/**
 * Read the keyring out of the environment as raw base64, without importing anything.
 *
 * Two accepted shapes, and the legacy one is not deprecated-with-a-warning — it is a
 * first-class, exactly-equivalent single-key ring, which is what makes deploying this a NO-OP
 * against a production secret set that only has `PLATFORM_KEK`:
 *
 *   keyring: PLATFORM_KEK_KEYS = {"k1":"<base64>","k2":"<base64>"}, PLATFORM_KEK_ACTIVE = "k2"
 *   legacy:  PLATFORM_KEK = "<base64>"   (+ optional PLATFORM_KEK_ID, default "default")
 *
 * Fails CLOSED on every malformed shape rather than falling back to the other one: a keyring
 * that half-parses must never silently degrade into "seal under the legacy key".
 */
function resolveKeyring(env: Env): {
  active: string;
  raw: Record<string, string>;
  legacy: boolean;
} {
  const json = env.PLATFORM_KEK_KEYS;
  if (typeof json === "string" && json.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error("PLATFORM_KEK_KEYS is not valid JSON");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error(
        "PLATFORM_KEK_KEYS must be a JSON object of kid -> base64 KEK",
      );
    }
    const raw: Record<string, string> = {};
    for (const [kid, value] of Object.entries(parsed)) {
      if (kid.length === 0 || typeof value !== "string" || value.length === 0) {
        throw new Error(
          "PLATFORM_KEK_KEYS entries must be non-empty kid -> base64 pairs",
        );
      }
      raw[kid] = value;
    }
    if (Object.keys(raw).length === 0) {
      throw new Error("PLATFORM_KEK_KEYS is empty");
    }
    const active = env.PLATFORM_KEK_ACTIVE;
    if (typeof active !== "string" || !(active in raw)) {
      throw new Error("PLATFORM_KEK_ACTIVE is not in PLATFORM_KEK_KEYS");
    }
    return { active, raw, legacy: false };
  }

  // Legacy single-KEK shape. Keeps the "default" kid so blobs written before the keyring
  // existed keep opening, and honours PLATFORM_KEK_ID for a deployment that already set it.
  const single = env.PLATFORM_KEK;
  if (typeof single !== "string" || single.length === 0) {
    throw new Error("PLATFORM_KEK is not configured");
  }
  const kid =
    typeof env.PLATFORM_KEK_ID === "string" && env.PLATFORM_KEK_ID.length > 0
      ? env.PLATFORM_KEK_ID
      : LEGACY_KEK_ID;
  return { active: kid, raw: { [kid]: single }, legacy: true };
}

/** Per-isolate memo, keyed by the literal secret material, so a secret change picked up by a
 *  fresh isolate needs no restart hook and a stale ring can never outlive its configuration. */
let cachedRing: { fingerprint: string; ring: Keyring } | null = null;

/**
 * Import every KEK in the ring as a raw AES-256-GCM key. Each entry must be base64 of exactly
 * 32 bytes; anything else throws rather than silently deriving a different KEK from malformed
 * deployment input.
 */
async function loadKeyring(env: Env): Promise<Keyring> {
  const { active, raw, legacy } = resolveKeyring(env);
  const fingerprint = JSON.stringify([active, raw]);
  if (cachedRing?.fingerprint === fingerprint) return cachedRing.ring;

  const keys = new Map<string, CryptoKey>();
  for (const [kid, b64] of Object.entries(raw)) {
    const keyBytes = b64Decode(b64);
    if (keyBytes.length !== 32) {
      throw new Error(
        legacy
          ? "PLATFORM_KEK must decode to exactly 32 bytes"
          : `PLATFORM_KEK_KEYS entry ${kid} must decode to exactly 32 bytes`,
      );
    }
    keys.set(
      kid,
      await crypto.subtle.importKey(
        "raw",
        toArrayBuffer(keyBytes),
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"],
      ),
    );
  }
  const ring: Keyring = { active, keys };
  cachedRing = { fingerprint, ring };
  return ring;
}

/** The ring as an operator needs to see it: the kid new seals use, and every kid that can be
 *  opened. THROWS on an unusable keyring, so "what is configured?" can never be answered
 *  wrongly — a mid-rotation operator gets the parse error instead of a plausible fiction. */
export async function describeKeyring(
  env: Env,
): Promise<{ active: string; kids: string[] }> {
  const { active, keys } = await loadKeyring(env);
  return { active, kids: [...keys.keys()] };
}

/** Envelope-encrypt `plaintext` under the ACTIVE platform KEK. Returns `JSON.stringify(Sealed)`.
 *  THROWS if the keyring is missing or unusable (a product can never persist key material
 *  un-sealed), and never seals under a secondary key — secondaries are read-only by design. */
export async function seal(
  env: Env,
  plaintext: string,
  ctx: SealContext,
): Promise<string> {
  const { active, keys } = await loadKeyring(env);
  const key = keys.get(active);
  if (!key) throw new Error(`active KEK ${active} is not in the keyring`);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
      additionalData: aad(ctx),
    },
    key,
    toArrayBuffer(enc.encode(plaintext)),
  );
  const sealed: Sealed = {
    v: 2,
    kekId: active,
    iv: b64urlEncode(iv),
    ct: b64urlEncode(new Uint8Array(ct)),
  };
  return JSON.stringify(sealed);
}

/** Decrypt a `JSON.stringify(Sealed)` blob back to plaintext, under whichever KEK in the ring
 *  the blob names. THROWS on an unusable keyring, a kid the ring does not hold, or any
 *  auth-tag / format failure — callers MUST treat a throw as "no usable value" (fail closed). */
export async function open(
  env: Env,
  sealedJson: string,
  ctx: SealContext,
): Promise<string> {
  const { keys } = await loadKeyring(env);
  let sealed: Sealed;
  try {
    sealed = JSON.parse(sealedJson) as Sealed;
  } catch {
    throw new Error("sealed value is not valid JSON");
  }
  if (
    sealed.v !== 2 ||
    typeof sealed.kekId !== "string" ||
    typeof sealed.iv !== "string" ||
    typeof sealed.ct !== "string"
  ) {
    throw new Error("sealed value has an unexpected shape");
  }
  // The acceptance rule: the blob's OWN kid must be present in the ring. (It used to be
  // "the blob's kid equals the single configured kid", which is why setting a new KEK bricked
  // every blob on the platform — R2-09.) An unknown kid is still a hard failure: a secondary
  // that has been retired can never be silently substituted for.
  const key = keys.get(sealed.kekId);
  if (!key) {
    throw new Error(`sealed value uses unavailable KEK ${sealed.kekId}`);
  }
  // A bad auth tag (tampered ct, or the wrong AAD) makes subtle.decrypt reject — we propagate
  // the throw so a wrong/partial plaintext can never escape.
  const pt = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(b64urlDecode(sealed.iv)),
      additionalData: aad(ctx),
    },
    key,
    toArrayBuffer(b64urlDecode(sealed.ct)),
  );
  return dec.decode(pt);
}

function pkcs8ToPem(der: ArrayBuffer): string {
  let bin = "";
  const bytes = new Uint8Array(der);
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  const lines = b64.match(/.{1,64}/g) ?? [b64];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
}

/** Generate a fresh Ed25519 key in the exact wire format the JWS signer/jwks expect:
 *  private as a PKCS#8 PEM (for `signJws`), public as a raw 32-byte base64url (for JWKS /
 *  `verifyJws` trust sets). */
export async function generateEd25519(): Promise<{
  privatePkcs8Pem: string;
  publicRawB64url: string;
}> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey(
    "pkcs8",
    pair.privateKey,
  )) as ArrayBuffer;
  const rawPub = (await crypto.subtle.exportKey(
    "raw",
    pair.publicKey,
  )) as ArrayBuffer;
  return {
    privatePkcs8Pem: pkcs8ToPem(pkcs8),
    publicRawB64url: b64urlEncode(new Uint8Array(rawPub)),
  };
}
