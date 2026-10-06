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
// A deployment whose current KEK nobody holds (Worker secrets are write-only) can still rotate:
// with PLATFORM_KEK_KEYS set, a PLATFORM_KEK left in place joins the ring as the LEGACY key,
// open-only, under its own kid. New seals use the active key; the sweep moves every legacy
// blob across; then PLATFORM_KEK is deleted. See docs/RUNBOOK.md § "Rotating when the old KEK
// is unknown".
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
 * because the AAD differs and AES-GCM refuses it. A `platform-credential` (A-16 — a team-level
 * store key held in `platform_credentials`) is sealed with the product slot `_platform`, which no
 * product slug can spell, under its own kind. A `signin-provider-secret` (I-06 — the login card's
 * Google client secret, Apple `.p8` and Steam Web API key, held as sealed Worker secrets) uses the
 * same `_platform` slot under its own kind.
 */
export interface SealContext {
  product: string;
  kind:
    | "signing-key"
    | "product-secret"
    | "outlet-credential"
    | "platform-credential"
    | "signin-provider-secret";
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
  /** Set only when BOTH shapes are configured: see `LegacyKey`. */
  legacy: LegacyKey | null;
}

/**
 * The legacy `PLATFORM_KEK` as it sits inside a `PLATFORM_KEK_KEYS` ring. Present only when both
 * are set; absent (not `null`-valued) in either single shape, so those describe exactly as they
 * always have.
 *
 *  - `openOnly: true`  — the kid exists in the ring ONLY because of `PLATFORM_KEK`. It opens the
 *                        blobs that carry it and is never sealed under (it is imported without
 *                        the `encrypt` usage, on top of `PLATFORM_KEK_ACTIVE` having to name a
 *                        `PLATFORM_KEK_KEYS` entry). Delete `PLATFORM_KEK` once nothing is
 *                        sealed under the kid.
 *  - `openOnly: false` — `PLATFORM_KEK_KEYS` holds the same kid with the same bytes, so
 *                        `PLATFORM_KEK` is a redundant copy; deleting it changes nothing.
 */
export interface LegacyKey {
  kid: string;
  openOnly: boolean;
}

/** What `resolveKeyring` reads out of the environment, still as raw base64. */
interface RawKeyring {
  active: string;
  /** The ring `seal` may use: `PLATFORM_KEK_KEYS`, or the legacy single key on its own. */
  raw: Record<string, string>;
  /** True when `raw` IS the legacy single key (only `PLATFORM_KEK` is configured). */
  single: boolean;
  /** Both shapes configured: `PLATFORM_KEK` and its kid, to be added for opening only. */
  openOnly: { kid: string; b64: string } | null;
}

/** The kid blobs sealed under the legacy `PLATFORM_KEK` carry: `PLATFORM_KEK_ID`, else
 *  `"default"`. A kid NAME, never key material. */
export function legacyKekId(env: Env): string {
  return typeof env.PLATFORM_KEK_ID === "string" &&
    env.PLATFORM_KEK_ID.length > 0
    ? env.PLATFORM_KEK_ID
    : LEGACY_KEK_ID;
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
 * With BOTH set, the ring is `PLATFORM_KEK_KEYS` plus `PLATFORM_KEK` under its legacy kid for
 * opening only (`LegacyKey`). That is the rotation path for a deployment whose current KEK nobody
 * holds: the new key goes in the ring, the unknown one stays where it is, and the sweep moves
 * every blob across.
 *
 * Fails CLOSED on every malformed shape rather than falling back to the other one: a keyring
 * that half-parses must never silently degrade into "seal under the legacy key".
 */
function resolveKeyring(env: Env): RawKeyring {
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
    // Null-prototype, and every lookup below is an own-property check: a kid such as
    // `constructor`, `toString` or `__proto__` must never resolve to something inherited.
    const raw: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
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
    // Checked against PLATFORM_KEK_KEYS alone, BEFORE the legacy key joins: the active kid must
    // be a ring entry, so naming the legacy kid here fails closed instead of sealing under it.
    const active = env.PLATFORM_KEK_ACTIVE;
    if (typeof active !== "string" || !Object.hasOwn(raw, active)) {
      throw new Error("PLATFORM_KEK_ACTIVE is not in PLATFORM_KEK_KEYS");
    }
    const legacy = env.PLATFORM_KEK;
    const openOnly =
      typeof legacy === "string" && legacy.length > 0
        ? { kid: legacyKekId(env), b64: legacy }
        : null;
    return { active, raw, single: false, openOnly };
  }

  // Legacy single-KEK shape. Keeps the "default" kid so blobs written before the keyring
  // existed keep opening, and honours PLATFORM_KEK_ID for a deployment that already set it.
  const single = env.PLATFORM_KEK;
  if (typeof single !== "string" || single.length === 0) {
    throw new Error("PLATFORM_KEK is not configured");
  }
  const kid = legacyKekId(env);
  return { active: kid, raw: { [kid]: single }, single: true, openOnly: null };
}

/** Per-isolate memo, keyed by the literal secret material, so a secret change picked up by a
 *  fresh isolate needs no restart hook and a stale ring can never outlive its configuration. */
let cachedRing: { fingerprint: string; ring: Keyring } | null = null;

/** Equal key bytes, compared without an early exit. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function importKek(
  keyBytes: Uint8Array,
  usages: ("encrypt" | "decrypt")[],
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(keyBytes),
    { name: "AES-GCM" },
    false,
    usages,
  );
}

/**
 * Import every KEK in the ring as a raw AES-256-GCM key. Each entry must be base64 of exactly
 * 32 bytes; anything else throws rather than silently deriving a different KEK from malformed
 * deployment input.
 *
 * With both shapes set, `PLATFORM_KEK` joins under its legacy kid with the `decrypt` usage only.
 * If `PLATFORM_KEK_KEYS` already holds that kid, the bytes must match: two different keys under
 * one kid is a configuration error, and the ring refuses to load rather than pick one. The error
 * names the kid and never the key material.
 */
async function loadKeyring(env: Env): Promise<Keyring> {
  const { active, raw, single, openOnly } = resolveKeyring(env);
  const fingerprint = JSON.stringify([active, raw, openOnly]);
  if (cachedRing?.fingerprint === fingerprint) return cachedRing.ring;

  const keys = new Map<string, CryptoKey>();
  for (const [kid, b64] of Object.entries(raw)) {
    const keyBytes = b64Decode(b64);
    if (keyBytes.length !== 32) {
      throw new Error(
        single
          ? "PLATFORM_KEK must decode to exactly 32 bytes"
          : `PLATFORM_KEK_KEYS entry ${kid} must decode to exactly 32 bytes`,
      );
    }
    keys.set(kid, await importKek(keyBytes, ["encrypt", "decrypt"]));
  }

  let legacy: LegacyKey | null = null;
  if (openOnly) {
    const keyBytes = b64Decode(openOnly.b64);
    if (keyBytes.length !== 32) {
      throw new Error("PLATFORM_KEK must decode to exactly 32 bytes");
    }
    const inRing = Object.hasOwn(raw, openOnly.kid)
      ? raw[openOnly.kid]
      : undefined;
    if (inRing !== undefined) {
      if (!sameBytes(keyBytes, b64Decode(inRing))) {
        throw new Error(
          `PLATFORM_KEK and PLATFORM_KEK_KEYS both define kid ${openOnly.kid} with different keys; ` +
            `refusing to choose. Give the new key in PLATFORM_KEK_KEYS a kid of its own ` +
            `(blobs sealed under PLATFORM_KEK carry ${openOnly.kid}), or delete PLATFORM_KEK ` +
            `if PLATFORM_KEK_KEYS already holds the right key`,
        );
      }
      legacy = { kid: openOnly.kid, openOnly: false };
    } else {
      keys.set(openOnly.kid, await importKek(keyBytes, ["decrypt"]));
      legacy = { kid: openOnly.kid, openOnly: true };
    }
  }

  const ring: Keyring = { active, keys, legacy };
  cachedRing = { fingerprint, ring };
  return ring;
}

/** The ring as an operator needs to see it: the kid new seals use, every kid that can be
 *  opened, and — only when `PLATFORM_KEK` sits alongside `PLATFORM_KEK_KEYS` — the legacy key.
 *  THROWS on an unusable keyring, so "what is configured?" can never be answered wrongly — a
 *  mid-rotation operator gets the parse error instead of a plausible fiction. */
export async function describeKeyring(
  env: Env,
): Promise<{ active: string; kids: string[]; legacy?: LegacyKey }> {
  const { active, keys, legacy } = await loadKeyring(env);
  return {
    active,
    kids: [...keys.keys()],
    ...(legacy ? { legacy } : {}),
  };
}

/** Envelope-encrypt `plaintext` under the ACTIVE platform KEK. Returns `JSON.stringify(Sealed)`.
 *  THROWS if the keyring is missing or unusable (a product can never persist key material
 *  un-sealed), and never seals under a secondary key — secondaries are read-only by design, and
 *  the legacy `PLATFORM_KEK` in a `PLATFORM_KEK_KEYS` ring cannot even encrypt. */
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
