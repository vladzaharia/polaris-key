// `pkey-sync-value/1` (WIRE-CONTRACT-V5 §13.10.4): one sealed setting, record, member, field or
// element value.
//
//   0x01 | kid(16) | salt(16) | AES-256-GCM(K_msg, nonce 0x00*12, aad = the first 33 bytes, P)
//
// `P` is the UTF-8 canonical JSON `{"k": name, "v": value}` padded with 0x80 then zeros to a
// multiple of 64 bytes (at least one byte of padding).

import {
  SYNC_KID_BYTES,
  SYNC_VALUE_SALT_BYTES,
  deriveCollKey,
  deriveKid,
  deriveValueKey,
  type SyncCryptoPort,
} from "./crypto.js";

export const ENVELOPE_VERSION = 0x01;
/** Version, kid and salt: the associated data. */
export const ENVELOPE_HEADER_BYTES = 33;
/** Header and tag. */
export const ENVELOPE_FIXED_BYTES = 49;
export const ENVELOPE_PAD_BLOCK = 64;
/** Fixed bytes and at most one block of padding (`SYNC_E2E_OVERHEAD_BYTES`). */
export const ENVELOPE_OVERHEAD_BYTES = 113;

export type SyncJson =
  | null
  | boolean
  | number
  | string
  | SyncJson[]
  | { [k: string]: SyncJson };

/** Why a reader refuses an envelope, in the order it checks. */
export type EnvelopeInvalid =
  | "shape"
  | "version"
  | "kid"
  | "auth"
  | "padding"
  | "json"
  | "name";

export type OpenedValue =
  | { ok: true; name: string; value: SyncJson }
  | { ok: false; reason: EnvelopeInvalid };

const NONCE = new Uint8Array(12);
const utf8 = new TextEncoder();

// No lookbehind (runtime floor): a low surrogate is lone unless a high one directly precedes it.
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/;

/**
 * Canonical JSON (WIRE-CONTRACT-V5 §13.10.3): sorted keys at every level (UTF-16 code-unit
 * order), no whitespace, non-ASCII text as itself, numbers as ECMAScript `Number::toString`.
 * A number that is not finite and a string or key with a lone surrogate are refused with a
 * `RangeError`, so every SDK refuses what it cannot spell identically.
 */
export function canonicalJson(v: SyncJson): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${canonicalJson(k)}:${canonicalJson(v[k] as SyncJson)}`)
      .join(",")}}`;
  }
  if (typeof v === "number" && !Number.isFinite(v))
    throw new RangeError("canonical json: number is not finite");
  if (typeof v === "string" && LONE_SURROGATE.test(v))
    throw new RangeError("canonical json: lone surrogate");
  return JSON.stringify(v);
}

function pad(p: Uint8Array): Uint8Array {
  const total =
    Math.floor(p.length / ENVELOPE_PAD_BLOCK) * ENVELOPE_PAD_BLOCK +
    ENVELOPE_PAD_BLOCK;
  const out = new Uint8Array(total);
  out.set(p);
  out[p.length] = 0x80;
  return out;
}

/** The bytes before the padding, or null when the padding is not `0x80` and zeros. */
function unpad(p: Uint8Array): Uint8Array | null {
  let end = p.length;
  while (end > 0 && p[end - 1] === 0) end--;
  if (end === 0 || p[end - 1] !== 0x80) return null;
  return p.subarray(0, end - 1);
}

/**
 * Seals `value` under `name` in `collection`. `salt` (16 bytes) is fresh randomness from the
 * port unless a test fixes it.
 */
export async function sealValue(
  port: SyncCryptoPort,
  root: Uint8Array,
  collection: string,
  name: string,
  value: SyncJson,
  salt: Uint8Array = port.random(SYNC_VALUE_SALT_BYTES),
): Promise<Uint8Array> {
  if (salt.length !== SYNC_VALUE_SALT_BYTES)
    throw new RangeError("salt length");
  const kid = await deriveKid(port, root);
  const collKey = await deriveCollKey(port, root, collection);
  const key = await deriveValueKey(port, collKey, salt);
  const header = new Uint8Array(ENVELOPE_HEADER_BYTES);
  header[0] = ENVELOPE_VERSION;
  header.set(kid, 1);
  header.set(salt, 1 + SYNC_KID_BYTES);
  const p = pad(utf8.encode(canonicalJson({ k: name, v: value })));
  const ct = await port.aesGcmSeal(key, NONCE, header, p);
  const out = new Uint8Array(header.length + ct.length);
  out.set(header);
  out.set(ct, header.length);
  return out;
}

/**
 * Opens an envelope for `name` (or one of its `aliases` sources) in `collection`. The checks run
 * in the order of `EnvelopeInvalid`; `kid` is checked before any decryption so a caller can look
 * for another root. A match on an alias answers that alias as `name`.
 */
export function openValue(
  port: SyncCryptoPort,
  root: Uint8Array,
  collection: string,
  name: string,
  envelope: Uint8Array,
  aliases: readonly string[] = [],
): Promise<OpenedValue> {
  return openEnvelope(
    port,
    root,
    collection,
    envelope,
    (k) => k === name || aliases.includes(k),
  );
}

/**
 * Opens an envelope whose name the caller does not know yet (a blinded open key or merge member:
 * the name is inside). It answers the envelope's own `k`. The caller MUST check that `k` is the
 * name it expected (for a blinded one, that `blind(k)` equals the served name) before it trusts
 * the value; the same checks as `openValue` run first.
 */
export function openValueAnyName(
  port: SyncCryptoPort,
  root: Uint8Array,
  collection: string,
  envelope: Uint8Array,
): Promise<OpenedValue> {
  return openEnvelope(port, root, collection, envelope, () => true);
}

async function openEnvelope(
  port: SyncCryptoPort,
  root: Uint8Array,
  collection: string,
  envelope: Uint8Array,
  accepts: (k: string) => boolean,
): Promise<OpenedValue> {
  const n = envelope.length;
  if (
    n < ENVELOPE_FIXED_BYTES + ENVELOPE_PAD_BLOCK ||
    (n - ENVELOPE_FIXED_BYTES) % ENVELOPE_PAD_BLOCK !== 0
  ) {
    return { ok: false, reason: "shape" };
  }
  if (envelope[0] !== ENVELOPE_VERSION) return { ok: false, reason: "version" };
  const kid = await deriveKid(port, root);
  const got = envelope.subarray(1, 1 + SYNC_KID_BYTES);
  let diff = 0;
  for (let i = 0; i < SYNC_KID_BYTES; i++) diff |= kid[i]! ^ got[i]!;
  if (diff !== 0) return { ok: false, reason: "kid" };

  const header = envelope.subarray(0, ENVELOPE_HEADER_BYTES);
  const salt = envelope.subarray(1 + SYNC_KID_BYTES, ENVELOPE_HEADER_BYTES);
  const collKey = await deriveCollKey(port, root, collection);
  const key = await deriveValueKey(port, collKey, salt);
  const padded = await port.aesGcmOpen(
    key,
    NONCE,
    header,
    envelope.subarray(ENVELOPE_HEADER_BYTES),
  );
  if (padded === null) return { ok: false, reason: "auth" };
  const body = unpad(padded);
  if (body === null) return { ok: false, reason: "padding" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return { ok: false, reason: "json" };
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 2 ||
    !("k" in parsed) ||
    !("v" in parsed) ||
    typeof parsed.k !== "string"
  ) {
    return { ok: false, reason: "json" };
  }
  const k = parsed.k;
  if (!accepts(k)) return { ok: false, reason: "name" };
  return { ok: true, name: k, value: parsed.v as SyncJson };
}
