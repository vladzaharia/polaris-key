// Reference: Cloud Sync end-to-end encryption (WIRE-CONTRACT-V5 §13.10; plans/CC-01-cloud-sync.md
// §1.4, §2.4).
//
// The generator's independent reference implementation, restated from the spec over `node:crypto`
// and nothing else: it imports nothing from client-core, shared-protocol or an SDK, so a golden
// corpus built through it cannot share a bug with the implementations it checks. The family module
// recomputes every row through it.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
} from "node:crypto";
import { refHkdf as noiseHkdf } from "./noise.js";

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

export const utf8 = (s: string): Uint8Array => enc.encode(s);
export const cat = (...p: Uint8Array[]): Uint8Array =>
  new Uint8Array(Buffer.concat(p));
export const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
export const fromHex = (h: string): Uint8Array =>
  new Uint8Array(Buffer.from(h, "hex"));
export const b64url = (b: Uint8Array): string =>
  Buffer.from(b).toString("base64url");

/** The sizes of §13.10.4. */
export const REF_VALUE_VERSION = 0x01;
export const REF_VALUE_HEADER = 33;
export const REF_TAG = 16;
export const REF_PAD_BLOCK = 64;
export const REF_ENVELOPE_FIXED = 49;
export const REF_E2E_OVERHEAD = 113;

const hmac = (key: Uint8Array, data: Uint8Array): Uint8Array =>
  new Uint8Array(createHmac("sha256", key).update(data).digest());

/** HKDF-SHA256 (RFC 5869) from the Noise reference (node:crypto HMAC); this file's argument order. */
export const refHkdf = (
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Uint8Array => noiseHkdf(salt, ikm, info, length);

const NONE = new Uint8Array(0);
const label = (s: string): Uint8Array => utf8(`pkey-sync/1 ${s}`);

export const refKid = (root: Uint8Array): Uint8Array =>
  refHkdf(root, NONE, label("kid"), 16);
export const refKColl = (root: Uint8Array, c: string): Uint8Array =>
  refHkdf(root, NONE, cat(label("coll\0"), utf8(c)), 32);
export const refKNames = (root: Uint8Array): Uint8Array =>
  refHkdf(root, NONE, label("names"), 32);
export const refKCid = (root: Uint8Array, c: string): Uint8Array =>
  refHkdf(root, NONE, cat(label("chunk-id\0"), utf8(c)), 32);
export const refKMsg = (kColl: Uint8Array, salt16: Uint8Array): Uint8Array =>
  refHkdf(kColl, salt16, label("value"), 32);
export const refKFile = (kColl: Uint8Array, salt32: Uint8Array): Uint8Array =>
  refHkdf(kColl, salt32, label("file"), 32);
export const refKChunk = (kColl: Uint8Array, chunkId: Uint8Array): Uint8Array =>
  refHkdf(kColl, chunkId, label("chunk"), 32);
export const refKRec = (code16: Uint8Array, ringId: string): Uint8Array =>
  refHkdf(code16, utf8(ringId), label("recovery"), 32);
export const refKAdopt = (root: Uint8Array): Uint8Array =>
  refHkdf(root, NONE, label("adopt"), 32);

/** `blind(kind, ctx, n)` (§13.10.3). */
export function refBlind(
  kNames: Uint8Array,
  kind: string,
  ctx: string,
  n: string,
): string {
  const mac = hmac(
    kNames,
    cat(utf8(kind), Uint8Array.of(0), utf8(ctx), Uint8Array.of(0), utf8(n)),
  );
  return `x:${b64url(mac)}`;
}

/** Canonical JSON for the corpus values: object keys sorted, no whitespace, integers only. */
export function refCanonicalJson(v: unknown): string {
  if (v === null || typeof v === "boolean" || typeof v === "string")
    return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v))
      throw new Error("refCanonicalJson: integers only");
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(refCanonicalJson).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${refCanonicalJson(o[k])}`)
      .join(",")}}`;
  }
  throw new Error("refCanonicalJson: unsupported value");
}

/** Pad with 0x80 then zeros to a multiple of 64: always 1..64 bytes (never zero). */
export function refPad(p: Uint8Array): Uint8Array {
  const add = REF_PAD_BLOCK - (p.length % REF_PAD_BLOCK);
  const out = new Uint8Array(p.length + add);
  out.set(p);
  out[p.length] = 0x80;
  return out;
}

function gcmSeal(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  pt: Uint8Array,
): Uint8Array {
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(aad);
  return new Uint8Array(
    Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]),
  );
}

function gcmOpen(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  ct: Uint8Array,
): Uint8Array | null {
  try {
    const d = createDecipheriv("aes-256-gcm", key, nonce);
    d.setAAD(aad);
    d.setAuthTag(ct.subarray(ct.length - REF_TAG));
    return new Uint8Array(
      Buffer.concat([d.update(ct.subarray(0, ct.length - REF_TAG)), d.final()]),
    );
  } catch {
    return null;
  }
}

/** `pkey-sync-value/1` seal with a given salt (§13.10.4). */
export function refSealValue(
  root: Uint8Array,
  collection: string,
  name: string,
  value: unknown,
  salt16: Uint8Array,
): Uint8Array {
  const header = cat(Uint8Array.of(REF_VALUE_VERSION), refKid(root), salt16);
  const key = refKMsg(refKColl(root, collection), salt16);
  const p = refPad(utf8(refCanonicalJson({ k: name, v: value })));
  return cat(header, gcmSeal(key, new Uint8Array(12), header, p));
}

export type RefOpen =
  | { ok: true; name: string; value: unknown }
  | { ok: false; reason: ValueInvalid };

/** Why a value envelope is `invalid`, in the order the reader checks. */
export type ValueInvalid =
  | "shape"
  | "version"
  | "kid"
  | "auth"
  | "padding"
  | "json"
  | "name";

/** `pkey-sync-value/1` open: the checks run in this order and the first failure is the answer. */
export function refOpenValue(
  root: Uint8Array,
  collection: string,
  expectName: string,
  aliases: readonly string[],
  env: Uint8Array,
): RefOpen {
  const fail = (reason: ValueInvalid): RefOpen => ({ ok: false, reason });
  if (
    env.length < REF_E2E_OVERHEAD ||
    (env.length - REF_ENVELOPE_FIXED) % REF_PAD_BLOCK !== 0
  )
    return fail("shape");
  if (env[0] !== REF_VALUE_VERSION) return fail("version");
  const kid = refKid(root);
  if (toHex(env.subarray(1, 17)) !== toHex(kid)) return fail("kid");
  const header = env.subarray(0, REF_VALUE_HEADER);
  const key = refKMsg(
    refKColl(root, collection),
    env.subarray(17, REF_VALUE_HEADER),
  );
  const p = gcmOpen(
    key,
    new Uint8Array(12),
    header,
    env.subarray(REF_VALUE_HEADER),
  );
  if (p === null) return fail("auth");
  let end = p.length;
  while (end > 0 && p[end - 1] === 0) end--;
  if (end === 0 || p[end - 1] !== 0x80) return fail("padding");
  let doc: unknown;
  try {
    doc = JSON.parse(dec.decode(p.subarray(0, end - 1)));
  } catch {
    return fail("json");
  }
  if (
    doc === null ||
    typeof doc !== "object" ||
    Array.isArray(doc) ||
    Object.keys(doc).sort().join(",") !== "k,v" ||
    typeof (doc as { k: unknown }).k !== "string"
  )
    return fail("json");
  const k = (doc as { k: string }).k;
  if (k !== expectName && !aliases.includes(k)) return fail("name");
  return { ok: true, name: k, value: (doc as { v: unknown }).v };
}

// ── HPKE and the wrap (§13.11.1) ─────────────────────────────────────────────────────────────
// RFC 9180 mode_base, KEM 0x0020 / KDF 0x0001 / AEAD 0x0002, restated over node:crypto's X25519,
// HMAC and AES-GCM. The RFC's own vector (tools/corpus/inputs/hpke-anchors.json) anchors it.

const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");

/** The X25519 public key of a 32-byte private scalar. */
export function refX25519Public(sk: Uint8Array): Uint8Array {
  const k = createPrivateKey({
    key: Buffer.concat([PKCS8_X25519, sk]),
    format: "der",
    type: "pkcs8",
  });
  const der = createPublicKey(k).export({ format: "der", type: "spki" });
  return new Uint8Array(der.subarray(der.length - 32));
}

/** X25519(sk, pk); node:crypto throws for a low-order point, which is `null` here. */
export function refX25519Dh(sk: Uint8Array, pk: Uint8Array): Uint8Array | null {
  try {
    const out = diffieHellman({
      privateKey: createPrivateKey({
        key: Buffer.concat([PKCS8_X25519, sk]),
        format: "der",
        type: "pkcs8",
      }),
      publicKey: createPublicKey({
        key: Buffer.concat([SPKI_X25519, pk]),
        format: "der",
        type: "spki",
      }),
    });
    const o = new Uint8Array(out);
    return o.every((b) => b === 0) ? null : o;
  } catch {
    return null;
  }
}

const be16 = (n: number): Uint8Array => Uint8Array.of(n >> 8, n & 255);
export const refBe32 = (n: number): Uint8Array =>
  Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const KEM_ID = utf8("KEM\x00\x20");
const HPKE_ID = cat(utf8("HPKE"), be16(0x0020), be16(0x0001), be16(0x0002));

function lExtract(
  suite: Uint8Array,
  salt: Uint8Array,
  lbl: string,
  ikm: Uint8Array,
): Uint8Array {
  return hmac(
    salt.length === 0 ? new Uint8Array(32) : salt,
    cat(utf8("HPKE-v1"), suite, utf8(lbl), ikm),
  );
}

/** LabeledExpand for lengths up to 32 bytes: one HMAC block. */
function lExpand(
  suite: Uint8Array,
  prk: Uint8Array,
  lbl: string,
  info: Uint8Array,
  length: number,
): Uint8Array {
  if (length > 32) throw new Error("refHpke: one block only");
  const labeled = cat(
    be16(length),
    utf8("HPKE-v1"),
    suite,
    utf8(lbl),
    info,
    Uint8Array.of(1),
  );
  return hmac(prk, labeled).slice(0, length);
}

export interface RefHpke {
  enc: Uint8Array;
  sharedSecret: Uint8Array;
  key: Uint8Array;
  baseNonce: Uint8Array;
}

/** The KEM's shared secret from a DH output and the two public keys. */
function refShared(
  dh: Uint8Array,
  enc: Uint8Array,
  pkR: Uint8Array,
): Uint8Array {
  return lExpand(
    KEM_ID,
    lExtract(KEM_ID, NONE, "eae_prk", dh),
    "shared_secret",
    cat(enc, pkR),
    32,
  );
}

/** The key schedule of mode_base (RFC 9180 section 5.1). */
function refSchedule(
  ss: Uint8Array,
  info: Uint8Array,
): { key: Uint8Array; baseNonce: Uint8Array } {
  const ctx = cat(
    Uint8Array.of(0),
    lExtract(HPKE_ID, NONE, "psk_id_hash", NONE),
    lExtract(HPKE_ID, NONE, "info_hash", info),
  );
  const secret = lExtract(HPKE_ID, ss, "secret", NONE);
  return {
    key: lExpand(HPKE_ID, secret, "key", ctx, 32),
    baseNonce: lExpand(HPKE_ID, secret, "base_nonce", ctx, 12),
  };
}

/** Encap plus the key schedule; `null` when the recipient key is a low-order point. */
export function refHpkeContext(
  pkR: Uint8Array,
  skE: Uint8Array,
  info: Uint8Array,
): RefHpke | null {
  const enc = refX25519Public(skE);
  const dh = refX25519Dh(skE, pkR);
  if (dh === null) return null;
  const sharedSecret = refShared(dh, enc, pkR);
  return { enc, sharedSecret, ...refSchedule(sharedSecret, info) };
}

/** `info` of a wrap. */
export const refWrapInfo = (
  product: string,
  deviceId: string,
  ringId: string,
  epoch: number,
): Uint8Array =>
  cat(
    utf8("pkey-sync/1 wrap\0"),
    utf8(product),
    Uint8Array.of(0),
    utf8(deviceId),
    Uint8Array.of(0),
    utf8(ringId),
    Uint8Array.of(0),
    refBe32(epoch),
  );

/** `SealBase`: the ephemeral private scalar is an input so a vector is reproducible. */
export function refHpkeSeal(
  pkR: Uint8Array,
  skE: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  pt: Uint8Array,
): { enc: Uint8Array; ct: Uint8Array } {
  const c = refHpkeContext(pkR, skE, info);
  if (c === null) throw new Error("refHpkeSeal: low-order recipient key");
  return { enc: c.enc, ct: gcmSeal(c.key, c.baseNonce, aad, pt) };
}

/** `OpenBase`, or null on any failure. */
export function refHpkeOpen(
  skR: Uint8Array,
  enc: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  ct: Uint8Array,
): Uint8Array | null {
  if (enc.length !== 32) return null;
  const dh = refX25519Dh(skR, enc);
  if (dh === null) return null;
  const k = refSchedule(refShared(dh, enc, refX25519Public(skR)), info);
  return gcmOpen(k.key, k.baseNonce, aad, ct);
}

/** Open a wrap: the 32-byte root, or null. `kem` other than 32 is refused. */
export function refUnwrap(
  skR: Uint8Array,
  product: string,
  deviceId: string,
  ringId: string,
  epoch: number,
  kid: Uint8Array,
  wrap: { kem: number; enc: Uint8Array; ct: Uint8Array },
): Uint8Array | null {
  if (wrap.kem !== 0x0020) return null;
  const r = refHpkeOpen(
    skR,
    wrap.enc,
    refWrapInfo(product, deviceId, ringId, epoch),
    kid,
    wrap.ct,
  );
  return r !== null && r.length === 32 ? r : null;
}

// ── The recovery code and the adopt blob (§13.11.4) ──────────────────────────────────────────
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 16 code bytes, then the first 4 bytes of their SHA-256, as 32 Crockford characters. */
export function refEncodeCode(code16: Uint8Array): string {
  const all = cat(
    code16,
    new Uint8Array(createHash("sha256").update(code16).digest()).subarray(0, 4),
  );
  let n = 0n;
  for (const b of all) n = (n << 8n) | BigInt(b);
  let s = "";
  for (let i = 31; i >= 0; i--)
    s += CROCKFORD[Number((n >> BigInt(i * 5)) & 31n)];
  return s.match(/.{4}/g)!.join("-");
}

/** The code bytes of a typed code, or null (length, alphabet or checksum). */
export function refParseCode(text: string): Uint8Array | null {
  let t = "";
  for (const ch of text.toUpperCase()) {
    if (ch === " " || ch === "-" || ch === "\t" || ch === "\n") continue;
    t += ch === "I" || ch === "L" ? "1" : ch === "O" ? "0" : ch;
  }
  if (t.length !== 32) return null;
  let n = 0n;
  for (const ch of t) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) return null;
    n = (n << 5n) | BigInt(v);
  }
  const hex = n.toString(16).padStart(40, "0");
  const all = fromHex(hex);
  const code = all.slice(0, 16);
  const sum = new Uint8Array(createHash("sha256").update(code).digest());
  return toHex(all.subarray(16)) === toHex(sum.subarray(0, 4)) ? code : null;
}

const blobAad = (
  lbl: string,
  ringId: string,
  epoch: number,
  kid: Uint8Array,
): Uint8Array => cat(utf8(`${lbl}${ringId}`), refBe32(epoch), kid);

/** `0x01 | n12 | AES-256-GCM(key, n, aad, root)`. */
export function refSealBlob(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  root: Uint8Array,
): Uint8Array {
  return cat(Uint8Array.of(1), nonce, gcmSeal(key, nonce, aad, root));
}

export function refOpenBlob(
  key: Uint8Array,
  aad: Uint8Array,
  blob: Uint8Array,
): Uint8Array | null {
  if (blob.length !== 61 || blob[0] !== 1) return null;
  return gcmOpen(key, blob.subarray(1, 13), aad, blob.subarray(13));
}

export const refRecoveryAad = (
  ringId: string,
  epoch: number,
  kid: Uint8Array,
): Uint8Array => blobAad("pkey-sync/1 recovery", ringId, epoch, kid);
export const refAdoptAad = (
  fromRingId: string,
  epoch: number,
  kid: Uint8Array,
): Uint8Array => blobAad("pkey-sync/1 adopt", fromRingId, epoch, kid);

// ── The transfer planner (§13.8.1) ───────────────────────────────────────────────────────────
const MIB = 1024 * 1024;
export interface RefPlan {
  mode: "single" | "multipart" | "chunks" | "too_large";
  partBytes: number | null;
  parts: number | null;
}

/** Mode, `partBytes` and the part count from the stored size and the collection's `files.delta`. */
export function refTransferPlan(size: number, delta: boolean): RefPlan {
  if (size > 1024 * MIB)
    return { mode: "too_large", partBytes: null, parts: null };
  if (delta && size >= MIB)
    return { mode: "chunks", partBytes: null, parts: null };
  if (size <= 16 * MIB) return { mode: "single", partBytes: null, parts: null };
  const raw = Math.ceil(size / 9999);
  const rounded = Math.ceil(raw / MIB) * MIB;
  const partBytes = Math.min(Math.max(8 * MIB, rounded), 64 * MIB);
  return { mode: "multipart", partBytes, parts: Math.ceil(size / partBytes) };
}
