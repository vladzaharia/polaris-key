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

/**
 * The `k` a value envelope is bound to (§13.10.4): a merge member's is `setting ‖ U+0000 ‖ member`,
 * so one setting's member cannot be served as another's; an open key's `k` is the key itself.
 */
export function refMemberName(setting: string, member: string): string {
  return `${setting}\u0000${member}`;
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
  const r = refOpenValueAnyName(root, collection, env);
  if (r.ok && r.name !== expectName && !aliases.includes(r.name))
    return { ok: false, reason: "name" };
  return r;
}

/**
 * The same open with the `k` check left to the caller: a record's `k` is split and its blinded
 * forms recomputed (`refOpenRecord`), so the expected name is not known up front.
 */
export function refOpenValueAnyName(
  root: Uint8Array,
  collection: string,
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
  return { ok: true, name: k, value: (doc as { v: unknown }).v };
}

/** The `k` of a sealed record field or union element: `id ‖ U+0000 ‖ x` (§13.10.4, U-09). */
export const refRecordName = (id: string, x: string): string =>
  `${id}\u0000${x}`;

/** The blinded names a record envelope arrived under (§13.10.4): `name` is absent for a value. */
export interface RefRecordWire {
  kind: "value" | "field" | "element";
  id: string;
  name?: string;
}

/** True when `canonicalJson(v)` is the name part of an element's `k`. */
function refElementIsName(v: unknown, rest: string | null): boolean {
  try {
    return refCanonicalJson(v) === rest;
  } catch {
    return false;
  }
}

/**
 * The reader of a sealed record value, field or element (§13.10.4, U-09): open the envelope,
 * split `k` at its first U+0000, recompute the blinded forms with `blind` and compare them with
 * the names on the wire; any difference is `invalid` (`name`). The container fixes the kind: a
 * `fields` entry is read as a field and an `elements` entry as an element, whatever `k` looks like,
 * and an element's `v` must be the element its `k` names (`canonicalJson(v)` is the name part).
 */
export function refOpenRecord(
  root: Uint8Array,
  collection: string,
  wire: RefRecordWire,
  env: Uint8Array,
): RefOpen {
  const r = refOpenValueAnyName(root, collection, env);
  if (!r.ok) return r;
  const kn = refKNames(root);
  const cut = r.name.indexOf("\u0000");
  const id = wire.kind === "value" ? r.name : r.name.slice(0, cut);
  const rest = wire.kind === "value" ? null : r.name.slice(cut + 1);
  const match =
    (wire.kind === "value" || cut >= 0) &&
    refBlind(kn, "record", collection, id) === wire.id &&
    (rest === null ||
      refBlind(kn, wire.kind, collection, rest) === wire.name) &&
    (wire.kind !== "element" || refElementIsName(r.value, rest));
  return match ? r : { ok: false, reason: "name" };
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

// ── Content-defined chunking, chunk objects and the chunk manifest (§13.8.3) ─────────────────
// `fastcdc-2016-nc1` restated from the spec as a whole-buffer scan (the client implementation
// streams): xorshift32 gear table from seed 0x9e3779b9, min = avg / 4, max = avg * 4, the hash
// starts at 0 at offset `min` of every chunk, the strict mask up to `avg` and the loose mask
// after it, a remainder of at most `min` bytes is one chunk.

export const REF_CDC = { avg: 262144, min: 65536, max: 1048576 } as const;
export const REF_CHUNK_VERSION = 0x01;
export const REF_CODEC_RAW = 0;
export const REF_CODEC_ZSTD = 1;

function refGear(): number[] {
  const step = (x: number): number => {
    const a = (x ^ (x << 13)) >>> 0;
    const b = (a ^ (a >>> 17)) >>> 0;
    return (b ^ (b << 5)) >>> 0;
  };
  const table: number[] = [step(0x9e3779b9)];
  while (table.length < 256) table.push(step(table[table.length - 1]!));
  return table;
}
const REF_GEAR = refGear();

/** The cut length of the chunk that starts at `buf[0]`; `buf` is everything that remains. */
function refCutLength(buf: Uint8Array, avg: number): number {
  const min = avg / 4;
  const max = avg * 4;
  if (buf.length <= min) return buf.length;
  const bits = Math.round(Math.log2(avg));
  const top = (n: number): number => (~(0xffffffff >>> n) & 0xffffffff) >>> 0;
  const strict = top(bits + 1);
  const loose = top(bits - 1);
  const limit = Math.min(buf.length, max);
  const mid = Math.min(limit, avg);
  let h = 0;
  for (let i = min; i < limit; i++) {
    h = ((h << 1) + REF_GEAR[buf[i]!]!) >>> 0;
    if ((h & (i < mid ? strict : loose)) === 0) return i + 1;
  }
  return limit;
}

/** The chunk lengths of `buf`; they tile it. */
export function refCdc(buf: Uint8Array, avg: number): number[] {
  const lens: number[] = [];
  for (let at = 0; at < buf.length; ) {
    const n = refCutLength(buf.subarray(at), avg);
    lens.push(n);
    at += n;
  }
  return lens;
}

/** Deterministic input: SHA-256(label ‖ u32be(counter)) blocks, cut to `length`. */
export function refStream(label: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let at = 0, i = 0; at < length; i++, at += 32) {
    const block = createHash("sha256")
      .update(utf8(label))
      .update(refBe32(i))
      .digest();
    out.set(block.subarray(0, Math.min(32, length - at)), at);
  }
  return out;
}

/** A chunk id: HMAC-SHA256(K_cid(c), chunk) in E2E mode, SHA-256(chunk) in server mode. */
export function refChunkId(
  root: Uint8Array | null,
  collection: string,
  plain: Uint8Array,
): Uint8Array {
  return root === null
    ? new Uint8Array(createHash("sha256").update(plain).digest())
    : hmac(refKCid(root, collection), plain);
}

/** The synthetic nonce: `HMAC-SHA256(K_chunk, 0x01 ‖ codec ‖ body)[0:12]`. */
export function refChunkNonce(
  key: Uint8Array,
  codec: number,
  body: Uint8Array,
): Uint8Array {
  return hmac(key, cat(Uint8Array.of(0x01, codec), body)).subarray(0, 12);
}

/** `0x01 ‖ codec ‖ nonce(12) ‖ AES-256-GCM(K_chunk, nonce, aad = 0x01 ‖ codec ‖ id, body)`. */
export function refSealChunk(
  root: Uint8Array,
  collection: string,
  id: Uint8Array,
  codec: number,
  body: Uint8Array,
): Uint8Array {
  const aad = cat(Uint8Array.of(REF_CHUNK_VERSION, codec), id);
  const key = refKChunk(refKColl(root, collection), id);
  const nonce = refChunkNonce(key, codec, body);
  return cat(aad.subarray(0, 2), nonce, gcmSeal(key, nonce, aad, body));
}

/** A chunk object under a chosen nonce: only for the vectors that a reader must refuse. */
export function refSealChunkWithNonce(
  root: Uint8Array,
  collection: string,
  id: Uint8Array,
  codec: number,
  body: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  const aad = cat(Uint8Array.of(REF_CHUNK_VERSION, codec), id);
  const key = refKChunk(refKColl(root, collection), id);
  return cat(aad.subarray(0, 2), nonce, gcmSeal(key, nonce, aad, body));
}

/** One zstd frame that stores `data` in raw blocks, with its content size in the header. */
export function refZstdRawFrame(data: Uint8Array): Uint8Array {
  const n = data.length;
  const fcs =
    n < 256
      ? Uint8Array.of(n)
      : n < 65792
        ? Uint8Array.of((n - 256) & 255, (n - 256) >>> 8)
        : cat(refBe32(n).reverse());
  const flag = n < 256 ? 0 : n < 65792 ? 1 : 2;
  const parts: Uint8Array[] = [
    Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, (flag << 6) | 0x20),
    fcs,
  ];
  const BLOCK = 131072;
  for (let at = 0; at === 0 || at < n; at += BLOCK) {
    const len = Math.min(BLOCK, n - at);
    const last = at + BLOCK >= n ? 1 : 0;
    const head = (len << 3) | last;
    parts.push(
      Uint8Array.of(head & 255, (head >>> 8) & 255, (head >>> 16) & 255),
    );
    parts.push(data.subarray(at, at + len));
  }
  return cat(...parts);
}

/** The content size a zstd frame header declares, or null when it declares none. */
function refZstdContentSize(f: Uint8Array): number | null {
  if (f.length < 6 || toHex(f.subarray(0, 4)) !== "28b52ffd") return null;
  const d = f[4]!;
  const flag = d >>> 6;
  const single = (d >>> 5) & 1;
  const dictLen = [0, 1, 2, 4][d & 3]!;
  const at = 5 + (single === 1 ? 0 : 1) + dictLen;
  if (flag === 0) return single === 1 && f.length > at ? f[at]! : null;
  const size = [0, 2, 4, 8][flag]!;
  if (f.length < at + size) return null;
  if (flag === 1) return 256 + readLe(f, at, 2);
  return readLe(f, at, size);
}

/** Decodes a frame made of raw blocks only (what `refZstdRawFrame` writes); null for anything else. */
function refZstdUnraw(f: Uint8Array, max: number): Uint8Array | "size" | null {
  const size = refZstdContentSize(f);
  if (size === null) return null;
  if (size > max) return "size";
  const d = f[4]!;
  const flag = d >>> 6;
  let at =
    5 +
    ((d >>> 5) & 1 ? 0 : 1) +
    [0, 1, 2, 4][d & 3]! +
    [(d >>> 5) & 1 ? 1 : 0, 2, 4, 8][flag]!;
  const out: Uint8Array[] = [];
  for (;;) {
    if (f.length < at + 3) return null;
    const head = f[at]! | (f[at + 1]! << 8) | (f[at + 2]! << 16);
    if (((head >>> 1) & 3) !== 0) return null;
    const len = head >>> 3;
    at += 3;
    if (f.length < at + len) return null;
    out.push(f.subarray(at, at + len));
    at += len;
    if ((head & 1) === 1) break;
  }
  const plain = cat(...out);
  return at === f.length && plain.length === size ? plain : null;
}

export type ChunkInvalid =
  | "shape"
  | "version"
  | "codec"
  | "auth"
  | "nonce"
  | "decode"
  | "size"
  | "id";

export type RefChunkOpen =
  | { ok: true; plain: Uint8Array; codec: number }
  | { ok: false; reason: ChunkInvalid };

/** Opens a chunk object under its id; the checks run in the order of `ChunkInvalid`. */
export function refOpenChunk(
  root: Uint8Array,
  collection: string,
  id: Uint8Array,
  obj: Uint8Array,
): RefChunkOpen {
  const fail = (reason: ChunkInvalid): RefChunkOpen => ({ ok: false, reason });
  if (obj.length < 2 + 12 + REF_TAG) return fail("shape");
  if (obj[0] !== REF_CHUNK_VERSION) return fail("version");
  const codec = obj[1]!;
  if (codec !== REF_CODEC_RAW && codec !== REF_CODEC_ZSTD) return fail("codec");
  const aad = cat(obj.subarray(0, 2), id);
  const key = refKChunk(refKColl(root, collection), id);
  const nonce = obj.subarray(2, 14);
  const body = gcmOpen(key, nonce, aad, obj.subarray(14));
  if (body === null) return fail("auth");
  if (toHex(refChunkNonce(key, codec, body)) !== toHex(nonce))
    return fail("nonce");
  let plain: Uint8Array;
  if (codec === REF_CODEC_RAW) {
    plain = body;
  } else {
    const z = refZstdUnraw(body, REF_CDC.max);
    if (z === "size") return fail("size");
    if (z === null) return fail("decode");
    plain = z;
  }
  if (plain.length > REF_CDC.max) return fail("size");
  if (toHex(refChunkId(root, collection, plain)) !== toHex(id))
    return fail("id");
  return { ok: true, plain, codec };
}

/** `pkey-sync-chunks/1` (§13.8.3). */
export const REF_MANIFEST = {
  magic: "PKSYNCCH",
  headerBytes: 64,
  recordBytes: 48,
  maxChunks: 16384,
  maxFileBytes: 1024 * 1024 * 1024,
} as const;

const le = (n: number, bytes: number): Uint8Array => {
  const out = new Uint8Array(bytes);
  let v = n;
  for (let i = 0; i < bytes; i++) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
};
const readLe = (b: Uint8Array, at: number, bytes: number): number => {
  let v = 0;
  for (let i = bytes - 1; i >= 0; i--) v = v * 256 + b[at + i]!;
  return v;
};

export interface RefManifest {
  plainSize: number;
  plainSha256: Uint8Array;
  records: { id: Uint8Array; plainLen: number }[];
}

export function refEncodeManifest(m: RefManifest): Uint8Array {
  return cat(
    utf8(REF_MANIFEST.magic),
    le(1, 2),
    le(48, 2),
    le(0, 4),
    le(m.records.length, 4),
    le(0, 4),
    le(m.plainSize, 8),
    m.plainSha256,
    ...m.records.map((r) => cat(r.id, le(r.plainLen, 4), le(0, 4), le(0, 8))),
  );
}

export type ManifestInvalid =
  | "shape"
  | "magic"
  | "version"
  | "recordSize"
  | "flags"
  | "reserved"
  | "count"
  | "length"
  | "size"
  | "record"
  | "chunkLen";

export type RefManifestParse =
  | { ok: true; manifest: RefManifest }
  | { ok: false; reason: ManifestInvalid };

/** Refuses the first violation, in the order of `ManifestInvalid`; a final `size` is the sum. */
export function refParseManifest(b: Uint8Array): RefManifestParse {
  const fail = (reason: ManifestInvalid): RefManifestParse => ({
    ok: false,
    reason,
  });
  if (b.length < 64) return fail("shape");
  if (Buffer.from(b.subarray(0, 8)).toString("latin1") !== REF_MANIFEST.magic)
    return fail("magic");
  if (readLe(b, 8, 2) !== 1) return fail("version");
  if (readLe(b, 10, 2) !== 48) return fail("recordSize");
  if (readLe(b, 12, 4) !== 0) return fail("flags");
  if (readLe(b, 20, 4) !== 0) return fail("reserved");
  const count = readLe(b, 16, 4);
  if (count > REF_MANIFEST.maxChunks) return fail("count");
  if (b.length !== 64 + 48 * count) return fail("length");
  const plainSize = readLe(b, 24, 8);
  if (plainSize > REF_MANIFEST.maxFileBytes) return fail("size");
  const records: RefManifest["records"] = [];
  for (let i = 0; i < count; i++) {
    const at = 64 + 48 * i;
    if (readLe(b, at + 36, 4) !== 0 || readLe(b, at + 40, 8) !== 0)
      return fail("record");
    const plainLen = readLe(b, at + 32, 4);
    if (plainLen === 0 || plainLen > REF_CDC.max) return fail("chunkLen");
    records.push({ id: b.slice(at, at + 32), plainLen });
  }
  if (records.reduce((s, r) => s + r.plainLen, 0) !== plainSize)
    return fail("size");
  return {
    ok: true,
    manifest: { plainSize, plainSha256: b.slice(32, 64), records },
  };
}

// ── `pkey-sync-file/1` (§13.10.4) ────────────────────────────────────────────────────────────
// Restated from the spec as whole-buffer functions (the client streams). The 64-byte header is
// little-endian (`PKSYNCF1`, version u16 1, flags u16 0, segmentBytes u32 1 MiB, kid, salt); only
// the segment counter in the nonce is big-endian. A file of n >= 1 segments: the first n - 1 hold
// exactly 1 MiB of plaintext, the last 1..1 MiB (an empty file is one empty last segment).

export const REF_FILE = {
  magic: "PKSYNCF1",
  headerBytes: 64,
  segmentBytes: 1048576,
  tag: 16,
} as const;

export function refFileHeader(
  kid: Uint8Array,
  salt: Uint8Array,
  over: { segmentBytes?: number; flags?: number; version?: number } = {},
): Uint8Array {
  const h = new Uint8Array(64);
  const v = new DataView(h.buffer);
  h.set(utf8(REF_FILE.magic), 0);
  v.setUint16(8, over.version ?? 1, true);
  v.setUint16(10, over.flags ?? 0, true);
  v.setUint32(12, over.segmentBytes ?? REF_FILE.segmentBytes, true);
  h.set(kid, 16);
  h.set(salt, 32);
  return h;
}

function refFileNonce(index: number, last: boolean): Uint8Array {
  const n = new Uint8Array(12);
  n[0] = last ? 1 : 0;
  new DataView(n.buffer).setBigUint64(4, BigInt(index), false);
  return n;
}

/** The sealed stream of `plain` under `root`/`collection` with a 32-byte `salt`. */
export function refSealFile(
  root: Uint8Array,
  collection: string,
  salt: Uint8Array,
  plain: Uint8Array,
): Uint8Array {
  const header = refFileHeader(refKid(root), salt);
  const key = refKFile(refKColl(root, collection), salt);
  const n = Math.max(1, Math.ceil(plain.length / REF_FILE.segmentBytes));
  const out: Uint8Array[] = [header];
  for (let i = 0; i < n; i++) {
    const seg = plain.subarray(
      i * REF_FILE.segmentBytes,
      (i + 1) * REF_FILE.segmentBytes,
    );
    out.push(gcmSeal(key, refFileNonce(i, i === n - 1), header, seg));
  }
  return cat(...out);
}

/** The plaintext size a sealed size implies, or null when no stream has that size. */
export function refFilePlainSize(sealed: number): number | null {
  const body = sealed - REF_FILE.headerBytes;
  const seg = REF_FILE.segmentBytes + REF_FILE.tag;
  if (body < REF_FILE.tag) return null;
  const n = Math.ceil(body / seg);
  const lastLen = body - (n - 1) * seg; // tag + 0..1 MiB of the last segment
  if (lastLen < REF_FILE.tag) return null;
  if (n > 1 && lastLen === REF_FILE.tag) return null;
  return body - n * REF_FILE.tag;
}

export type FileInvalid =
  | "shape"
  | "magic"
  | "version"
  | "flags"
  | "segmentSize"
  | "kid"
  | "size"
  | "auth"
  | "range";

export type RefFileOpen =
  | { ok: true; plain: Uint8Array }
  | { ok: false; reason: FileInvalid };

function refFileHeaderCheck(
  s: Uint8Array,
  expectKid: Uint8Array,
): FileInvalid | null {
  if (s.length < REF_FILE.headerBytes) return "shape";
  const v = new DataView(s.buffer, s.byteOffset, s.length);
  if (Buffer.from(s.subarray(0, 8)).toString("latin1") !== REF_FILE.magic)
    return "magic";
  if (v.getUint16(8, true) !== 1) return "version";
  if (v.getUint16(10, true) !== 0) return "flags";
  if (v.getUint32(12, true) !== REF_FILE.segmentBytes) return "segmentSize";
  if (toHex(s.subarray(16, 32)) !== toHex(expectKid)) return "kid";
  return null;
}

/** Opens a whole stream; the checks run in the order of `FileInvalid`. */
export function refOpenFile(
  root: Uint8Array,
  collection: string,
  expectKid: Uint8Array,
  s: Uint8Array,
): RefFileOpen {
  const bad = refFileHeaderCheck(s, expectKid);
  if (bad !== null) return { ok: false, reason: bad };
  const header = s.subarray(0, 64);
  const key = refKFile(refKColl(root, collection), s.subarray(32, 64));
  const body = s.subarray(64);
  const seg = REF_FILE.segmentBytes + REF_FILE.tag;
  if (body.length < REF_FILE.tag) return { ok: false, reason: "shape" };
  const n = Math.ceil(body.length / seg);
  const lastLen = body.length - (n - 1) * seg;
  if (lastLen < REF_FILE.tag) return { ok: false, reason: "shape" };
  if (n > 1 && lastLen === REF_FILE.tag) return { ok: false, reason: "size" };
  const out: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const p = gcmOpen(
      key,
      refFileNonce(i, i === n - 1),
      header,
      body.subarray(i * seg, Math.min(body.length, (i + 1) * seg)),
    );
    if (p === null) return { ok: false, reason: "auth" };
    out.push(p);
  }
  return { ok: true, plain: cat(...out) };
}

export type RefFileRange =
  | { ok: true; plain: Uint8Array; reads: Array<[number, number]> }
  | { ok: false; reason: FileInvalid };

/**
 * Bytes `[start, end)` of the plaintext of a stored stream: the header read, then one read per
 * overlapping segment. Only those segments are authenticated; the size alone says which is last.
 */
export function refOpenFileRange(
  root: Uint8Array,
  collection: string,
  expectKid: Uint8Array,
  stored: Uint8Array,
  start: number,
  end: number,
): RefFileRange {
  const plainSize = refFilePlainSize(stored.length);
  if (plainSize === null) return { ok: false, reason: "shape" };
  if (start < 0 || start > end || end > plainSize)
    return { ok: false, reason: "range" };
  const reads: Array<[number, number]> = [[0, 64]];
  const bad = refFileHeaderCheck(stored.subarray(0, 64), expectKid);
  if (bad !== null) return { ok: false, reason: bad };
  if (start === end) return { ok: true, plain: new Uint8Array(0), reads };
  const header = stored.subarray(0, 64);
  const key = refKFile(refKColl(root, collection), stored.subarray(32, 64));
  const n = Math.max(1, Math.ceil(plainSize / REF_FILE.segmentBytes));
  const S = REF_FILE.segmentBytes;
  const out: Uint8Array[] = [];
  for (let i = Math.floor(start / S); i <= Math.floor((end - 1) / S); i++) {
    const last = i === n - 1;
    const len = (last ? plainSize - i * S : S) + REF_FILE.tag;
    const off = 64 + i * (S + REF_FILE.tag);
    reads.push([off, len]);
    const p = gcmOpen(
      key,
      refFileNonce(i, last),
      header,
      stored.subarray(off, off + len),
    );
    if (p === null) return { ok: false, reason: "auth" };
    out.push(
      p.subarray(
        Math.max(start, i * S) - i * S,
        Math.min(end, i * S + p.length) - i * S,
      ),
    );
  }
  return { ok: true, plain: cat(...out), reads };
}
