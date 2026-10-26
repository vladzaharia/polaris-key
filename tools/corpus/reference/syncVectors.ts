// Reference: Cloud Sync end-to-end encryption (WIRE-CONTRACT-V5 §13.10; plans/CC-01-cloud-sync.md
// §1.4, §2.4).
//
// The generator's independent reference implementation, restated from the spec over `node:crypto`
// and nothing else: it imports nothing from client-core, shared-protocol or an SDK, so a golden
// corpus built through it cannot share a bug with the implementations it checks. The family module
// recomputes every row through it.

import { createCipheriv, createDecipheriv, createHmac } from "node:crypto";
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
