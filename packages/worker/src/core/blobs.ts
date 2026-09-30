/// <reference types="@cloudflare/workers-types" />
/**
 * The Core blob store: content-addressed objects in R2 (P2-01, README §3.5).
 *
 * Substrate, like `keyvault.ts`: Release writes into it (publishing, P2-02/P2-04) and
 * Distribution serves from it (P2-05/P2b-04), and a service may not import a sibling
 * (`test/boundaries.test.ts`), so the store lives in Core and both bind to it.
 *
 * ── KEY LAYOUT (fixed here; P4-05 and P4-14 rely on it) ─────────────────────────────────────
 *
 *   blobs/sha256/<hex>                 one file, named by its own SHA-256
 *   bundles/sha256/<hex>               one chunk bundle, named by its own SHA-256
 *   deltas/<fromHex>/<toHex>.<method>  a patch from one blob to another
 *   gated/<any of the three above>     entitlement-gated content; never shares a key with free
 *   staging/<product>/<ticketId>/<hex> CI uploads — the ONLY prefix CI credentials reach
 *
 * `<hex>` is 64 lowercase hex characters. `blobs/`, `bundles/`, `deltas/` and `gated/` sit
 * under a 180-day AGE lock (not indefinite: P4-14's collector has to be able to delete an
 * unreferenced object eventually); `staging/` is unlocked and expires after one day.
 *
 * ── THE INVARIANTS ──────────────────────────────────────────────────────────────────────────
 *
 * 1. Verify before lock. A wrong object stored under a hash name would be locked in place for
 *    180 days, so nothing lands under a locked prefix except through `putVerified`, which hands
 *    R2 the expected SHA-256 (R2 refuses the write on mismatch) and refuses to overwrite.
 *    `promote` additionally verifies the staged object first and pins the copy to the exact
 *    object version it verified.
 * 2. Every read goes through the Worker. No R2 public domain and no r2.dev: only this module's
 *    `blobResponse` can set the ETag to the SHA-256, add `Repr-Digest`, and enforce the
 *    per-product reference check (`hasRef`).
 * 3. Never buffer an object. The isolate has 128 MB; a fallback re-hash streams through
 *    `crypto.DigestStream`, and a promote streams `get` into `put`.
 *
 * `env.BLOBS` is optional: until the buckets exist every caller treats its absence as "no blob
 * store" and answers not-found. Nothing in this file reads `env`.
 */

import type { Db } from "../db/types.js";
import { notFound } from "./errors.js";

// ── Key builders ────────────────────────────────────────────────────────────────────────────

/** A lowercase SHA-256 in hex. Uppercase is refused, not folded: a key has one spelling. */
const HEX64 = /^[0-9a-f]{64}$/;
/** A delta method name (`bsdiff`, `hdiffpatch`, `zstd-patch`, …). */
const METHOD = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** A product slug, as the router accepts it. */
const PRODUCT = /^[a-z0-9-]{1,64}$/;
/** An upload-ticket id (P2-02 mints these). */
const TICKET = /^[A-Za-z0-9_-]{1,128}$/;

export class BlobKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlobKeyError";
  }
}

function hex(value: string, what: string): string {
  if (!HEX64.test(value))
    throw new BlobKeyError(`${what} must be 64 lowercase hex characters`);
  return value;
}

export interface GatedOption {
  /** Gated content lives under `gated/` so free and paid objects never share a key. */
  gated?: boolean;
}

function prefix(opts?: GatedOption): string {
  return opts?.gated ? "gated/" : "";
}

/** `blobs/sha256/<hex>` (or `gated/blobs/sha256/<hex>`). */
export function blobKey(sha256: string, opts?: GatedOption): string {
  return `${prefix(opts)}blobs/sha256/${hex(sha256, "sha256")}`;
}

/** `bundles/sha256/<hex>` (or `gated/bundles/sha256/<hex>`). */
export function bundleKey(sha256: string, opts?: GatedOption): string {
  return `${prefix(opts)}bundles/sha256/${hex(sha256, "sha256")}`;
}

/** `deltas/<from>/<to>.<method>` (or under `gated/`). */
export function deltaKey(
  fromSha256: string,
  toSha256: string,
  method: string,
  opts?: GatedOption,
): string {
  if (!METHOD.test(method))
    throw new BlobKeyError("delta method must match [a-z0-9][a-z0-9-]{0,31}");
  return `${prefix(opts)}deltas/${hex(fromSha256, "fromSha256")}/${hex(toSha256, "toSha256")}.${method}`;
}

/** `staging/<product>/<ticketId>/<hex>` — the only prefix CI credentials can write (P2-02). */
export function stagingKey(
  product: string,
  ticketId: string,
  sha256: string,
): string {
  if (!PRODUCT.test(product))
    throw new BlobKeyError("product must be a product slug");
  if (!TICKET.test(ticketId))
    throw new BlobKeyError("ticketId must match [A-Za-z0-9_-]{1,128}");
  return `staging/${product}/${ticketId}/${hex(sha256, "sha256")}`;
}

export type BlobKind = "blob" | "bundle" | "delta";

export type ParsedKey =
  | { area: "locked"; kind: "blob" | "bundle"; gated: boolean; sha256: string }
  | {
      area: "locked";
      kind: "delta";
      gated: boolean;
      fromSha256: string;
      toSha256: string;
      method: string;
    }
  | { area: "staging"; product: string; ticketId: string; sha256: string };

const LOCKED_RE =
  /^(gated\/)?(blobs|bundles)\/sha256\/([0-9a-f]{64})$|^(gated\/)?deltas\/([0-9a-f]{64})\/([0-9a-f]{64})\.([a-z0-9][a-z0-9-]{0,31})$/;
const STAGING_RE =
  /^staging\/([a-z0-9-]{1,64})\/([A-Za-z0-9_-]{1,128})\/([0-9a-f]{64})$/;

/** Parse a storage key back into its parts; `null` for anything outside the layout. */
export function parseKey(key: string): ParsedKey | null {
  const s = STAGING_RE.exec(key);
  if (s)
    return { area: "staging", product: s[1]!, ticketId: s[2]!, sha256: s[3]! };
  const m = LOCKED_RE.exec(key);
  if (!m) return null;
  if (m[2])
    return {
      area: "locked",
      kind: m[2] === "blobs" ? "blob" : "bundle",
      gated: m[1] !== undefined,
      sha256: m[3]!,
    };
  return {
    area: "locked",
    kind: "delta",
    gated: m[4] !== undefined,
    fromSha256: m[5]!,
    toSha256: m[6]!,
    method: m[7]!,
  };
}

/** The SHA-256 a key is NAMED by, when it is named by one (blobs, bundles, staging). A delta
 *  is named by the two blobs it connects, not by its own hash. */
function namedHash(parsed: ParsedKey): string | null {
  if (parsed.area === "staging") return parsed.sha256;
  return parsed.kind === "delta" ? null : parsed.sha256;
}

// ── Digests ─────────────────────────────────────────────────────────────────────────────────

export interface Expected {
  /** Lowercase hex SHA-256 of the whole object. */
  sha256: string;
  /** Exact byte length. */
  size: number;
}

function hexOf(buf: ArrayBuffer): string {
  let out = "";
  for (const b of new Uint8Array(buf)) out += b.toString(16).padStart(2, "0");
  return out;
}

function base64OfHex(h: string): string {
  let bin = "";
  for (let i = 0; i < h.length; i += 2)
    bin += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
  return btoa(bin);
}

/** `Repr-Digest` (RFC 9530): a Structured Field byte sequence over the WHOLE representation. */
export function reprDigest(sha256: string): string {
  return `sha-256=:${base64OfHex(hex(sha256, "sha256"))}:`;
}

type DigestStreamCtor = new (algorithm: string) => WritableStream<
  ArrayBuffer | ArrayBufferView
> & {
  readonly digest: Promise<ArrayBuffer>;
  readonly bytesWritten: number | bigint;
};

/**
 * Hash a stream without buffering it. workerd provides `crypto.DigestStream`; the Node lane
 * installs an equivalent (`test/r2Mock.ts`), and there is deliberately no in-memory fallback
 * here — a fallback that buffered would be the exact isolate-OOM this module exists to avoid.
 */
export async function streamSha256(
  body: ReadableStream,
): Promise<{ sha256: string; bytes: number }> {
  const Ctor = (crypto as unknown as { DigestStream?: DigestStreamCtor })
    .DigestStream;
  if (!Ctor) throw new Error("crypto.DigestStream is unavailable");
  const sink = new Ctor("SHA-256");
  await body.pipeTo(sink);
  return {
    sha256: hexOf(await sink.digest),
    bytes: Number(sink.bytesWritten),
  };
}

function checksumHex(obj: R2Object): string | null {
  const c = obj.checksums?.sha256;
  return c ? hexOf(c) : null;
}

// ── Writes ──────────────────────────────────────────────────────────────────────────────────

export type PutRefusal =
  /** The key is named by a hash other than `expected.sha256`, or is outside the layout. */
  | "key_mismatch"
  /** The body is a buffer whose length is not `expected.size`. */
  | "size_mismatch"
  /** An object already exists at the key; nothing was written. */
  | "exists"
  /** R2 refused the write — for a well-formed call, the bytes did not hash to `sha256`. */
  | "rejected";

export type PutResult =
  | { ok: true; object: R2Object }
  | { ok: false; reason: PutRefusal; detail?: string };

type PutBody = ReadableStream | ArrayBuffer | ArrayBufferView;

/**
 * Write `body` at `key` only if its SHA-256 is `expected.sha256` and nothing is stored there.
 *
 * - The hash goes to R2 as the `sha256` put option, so R2 itself refuses bytes that do not
 *   match — the check happens on the bytes as received, not on a claim.
 * - `onlyIf: If-None-Match: *` makes the write create-only: a second put to an existing key
 *   returns `exists` instead of replacing it (the bucket lock enforces the same at rest).
 * - A key named by a hash (blobs, bundles, staging) must be named by THIS hash.
 * - A stream is wrapped in a `FixedLengthStream` where the runtime has one, so R2 knows the
 *   length up front and a short or long stream errors instead of being stored.
 */
export async function putVerified(
  bucket: R2Bucket,
  key: string,
  body: PutBody,
  expected: Expected,
): Promise<PutResult> {
  const parsed = parseKey(key);
  if (!parsed) return { ok: false, reason: "key_mismatch", detail: "layout" };
  if (!HEX64.test(expected.sha256))
    return { ok: false, reason: "key_mismatch", detail: "sha256" };
  const named = namedHash(parsed);
  if (named !== null && named !== expected.sha256)
    return { ok: false, reason: "key_mismatch" };
  if (!Number.isSafeInteger(expected.size) || expected.size < 0)
    return { ok: false, reason: "size_mismatch" };

  let value: PutBody = body;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    if (body.byteLength !== expected.size)
      return { ok: false, reason: "size_mismatch" };
  } else {
    const Fixed = (
      globalThis as { FixedLengthStream?: typeof FixedLengthStream }
    ).FixedLengthStream;
    if (Fixed) value = body.pipeThrough(new Fixed(expected.size));
  }

  let object: R2Object | null;
  try {
    object = await bucket.put(key, value, {
      sha256: expected.sha256,
      onlyIf: new Headers({ "If-None-Match": "*" }),
    });
  } catch (err) {
    return {
      ok: false,
      reason: "rejected",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (object === null) return { ok: false, reason: "exists" };
  return { ok: true, object };
}

export type VerifyRefusal = "missing" | "size_mismatch" | "digest_mismatch";

export type VerifyResult =
  | {
      ok: true;
      /** R2's etag of the exact object version that was verified; `promote` pins its copy to it. */
      etag: string;
      /** `stored-checksum`: R2 already held a SHA-256 for the object (the uploader sent
       *  `x-amz-checksum-sha256`). `streamed`: the object was re-hashed through DigestStream. */
      method: "stored-checksum" | "streamed";
    }
  | { ok: false; reason: VerifyRefusal };

/**
 * Check a staged object against the hash and size it claims.
 *
 * Uses R2's stored `checksums.sha256` when present — R2 verified it against the bytes at
 * upload, so it is the bytes' hash, not the uploader's claim. Otherwise streams the object
 * through `crypto.DigestStream` (never buffering it) and compares. The streamed read is pinned
 * to the etag `head` saw, so the object cannot be swapped between the two calls unnoticed.
 */
export async function verifyStaged(
  bucket: R2Bucket,
  key: string,
  expected: Expected,
): Promise<VerifyResult> {
  const head = await bucket.head(key);
  if (!head) return { ok: false, reason: "missing" };
  if (head.size !== expected.size)
    return { ok: false, reason: "size_mismatch" };

  const stored = checksumHex(head);
  if (stored !== null) {
    return stored === expected.sha256
      ? { ok: true, etag: head.etag, method: "stored-checksum" }
      : { ok: false, reason: "digest_mismatch" };
  }

  const obj = await bucket.get(key, { onlyIf: { etagMatches: head.etag } });
  if (!obj || !("body" in obj)) return { ok: false, reason: "missing" };
  const { sha256, bytes } = await streamSha256(obj.body);
  if (bytes !== expected.size) return { ok: false, reason: "size_mismatch" };
  if (sha256 !== expected.sha256)
    return { ok: false, reason: "digest_mismatch" };
  return { ok: true, etag: head.etag, method: "streamed" };
}

export type PromoteResult =
  | { ok: true; key: string; alreadyStored: boolean; verifiedBy: VerifyResult }
  | {
      ok: false;
      reason: VerifyRefusal | PutRefusal | "bad_key" | "changed" | "conflict";
    };

/**
 * Move a verified staged object to its locked key and record it in `blob_objects`.
 *
 * Order is the invariant: verify → copy (streamed, pinned to the verified version, with the
 * checksum so R2 re-checks it) → record. A failed verification writes nothing, anywhere. The
 * R2 binding has no server-side copy, so the copy is a stream from `get` into `put`; the
 * staging object is left for the one-day lifecycle rule (P2-02 may delete it sooner).
 *
 * Idempotent: promoting an object that is already stored succeeds with `alreadyStored` once
 * the stored object's own checksum is confirmed to be the expected one.
 */
export async function promote(
  bucket: R2Bucket,
  fromStagingKey: string,
  targetKey: string,
  expected: Expected,
  record: { db: Db; now: number },
): Promise<PromoteResult> {
  const from = parseKey(fromStagingKey);
  const to = parseKey(targetKey);
  if (!from || from.area !== "staging" || from.sha256 !== expected.sha256)
    return { ok: false, reason: "bad_key" };
  if (!to || to.area !== "locked") return { ok: false, reason: "bad_key" };
  const named = namedHash(to);
  if (named !== null && named !== expected.sha256)
    return { ok: false, reason: "bad_key" };

  const verified = await verifyStaged(bucket, fromStagingKey, expected);
  if (!verified.ok) return { ok: false, reason: verified.reason };

  const src = await bucket.get(fromStagingKey, {
    onlyIf: { etagMatches: verified.etag },
  });
  if (!src || !("body" in src)) return { ok: false, reason: "changed" };

  const put = await putVerified(bucket, targetKey, src.body, expected);
  let alreadyStored = false;
  if (!put.ok) {
    if (put.reason !== "exists") return { ok: false, reason: put.reason };
    // Something is already there. Everything under a locked prefix was written by this
    // function, with the checksum — but confirm rather than assume before calling it ours.
    await src.body.cancel().catch(() => undefined);
    const existing = await bucket.head(targetKey);
    if (
      !existing ||
      existing.size !== expected.size ||
      checksumHex(existing) !== expected.sha256
    )
      return { ok: false, reason: "conflict" };
    alreadyStored = true;
  }

  await recordObject(
    record.db,
    {
      storageKey: targetKey,
      sha256: expected.sha256,
      size: expected.size,
      kind: to.kind,
      gated: to.gated,
    },
    record.now,
  );
  return { ok: true, key: targetKey, alreadyStored, verifiedBy: verified };
}

// ── D1 bookkeeping: blob_objects + blob_refs (migration 0026) ───────────────────────────────

export interface BlobObjectRow {
  storageKey: string;
  sha256: string;
  size: number;
  kind: BlobKind;
  gated: boolean;
}

/** Record a stored, verified object. Written by `promote` only; a no-op if already recorded. */
export async function recordObject(
  db: Db,
  row: BlobObjectRow,
  now: number,
): Promise<void> {
  await db.run(
    `INSERT INTO blob_objects (storage_key, sha256, size, kind, gated, verified_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(storage_key) DO NOTHING`,
    row.storageKey,
    row.sha256,
    row.size,
    row.kind,
    row.gated ? 1 : 0,
    now,
    now,
  );
}

/** Is this object already stored (and verified)? One indexed lookup. */
export async function isStored(db: Db, storageKey: string): Promise<boolean> {
  const row = await db.first<{ one: number }>(
    "SELECT 1 AS one FROM blob_objects WHERE storage_key = ?",
    storageKey,
  );
  return row !== null;
}

/** D1 caps bound parameters per statement at 100. */
const IN_CHUNK = 90;

/**
 * The subset of `storageKeys` already stored — for upload tickets over thousands of pack file
 * blobs (P2-02/P4-03), where one query per key would be thousands of round trips.
 */
export async function storedKeys(
  db: Db,
  storageKeys: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  const unique = [...new Set(storageKeys)];
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const chunk = unique.slice(i, i + IN_CHUNK);
    const rows = await db.all<{ storage_key: string }>(
      `SELECT storage_key FROM blob_objects WHERE storage_key IN (${chunk.map(() => "?").join(", ")})`,
      ...chunk,
    );
    for (const r of rows) out.add(r.storage_key);
  }
  return out;
}

export interface BlobRef {
  product: string;
  storageKey: string;
  /** What holds the reference: `artifact` (P2-04), `pack-object` (P4-02), … */
  refKind: string;
  /** The holder's id within its kind. */
  refId: string;
}

/**
 * Record that `product` references a stored object. The object must already be recorded
 * (`blob_refs.storage_key` is a foreign key into `blob_objects`), so a ref can never point at
 * bytes that were not verified. Idempotent.
 */
export async function recordRef(
  db: Db,
  ref: BlobRef,
  now: number,
): Promise<void> {
  await db.run(
    `INSERT INTO blob_refs (product, storage_key, ref_kind, ref_id, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(product, storage_key, ref_kind, ref_id) DO NOTHING`,
    ref.product,
    ref.storageKey,
    ref.refKind,
    ref.refId,
    now,
  );
}

/**
 * Does THIS product hold a reference to the object? A byte route serves a key only if so —
 * another product's ref is not enough, which is what stops a product from serving (and so
 * paying for, or leaking) bytes it never published.
 */
export async function hasRef(
  db: Db,
  product: string,
  storageKey: string,
): Promise<boolean> {
  const row = await db.first<{ one: number }>(
    "SELECT 1 AS one FROM blob_refs WHERE product = ? AND storage_key = ? LIMIT 1",
    product,
    storageKey,
  );
  return row !== null;
}

// ── Serving ─────────────────────────────────────────────────────────────────────────────────

/**
 * The policy every blob response carries, on either host. `sandbox` puts a document into a
 * unique opaque origin with scripts disabled, so even a body a browser decided to render could
 * not act as `plrs.im` — load-bearing because the bytes host is same-site with the console
 * (see `docs/security/THREAT-MODEL.md` §3, "The bytes host").
 */
export const BLOB_CSP = "sandbox; default-src 'none'; frame-ancestors 'none'";

/**
 * The types a byte route may serve with their real `Content-Type` — on the BYTES host only.
 * Every one is inert: nothing here is HTML, XML, SVG, script, or a type a browser executes.
 * `test/blobs.test.ts` asserts that stays true. Anything not listed is served as
 * `application/octet-stream`.
 */
export const BYTES_HOST_TYPES: ReadonlySet<string> = new Set([
  "application/octet-stream",
  "application/vnd.android.package-archive",
  "application/wasm",
  "application/zip",
  "application/gzip",
  "application/x-tar",
  "application/x-xz",
  "application/zstd",
  "application/x-apple-diskimage",
  "application/vnd.debian.binary-package",
  "application/x-rpm",
  "application/x-msdownload",
  "application/x-msi",
  "application/vnd.microsoft.portable-executable",
]);

/** Refused even if someone adds it to the allowlist above: anything a browser may execute or
 *  render as an active document. */
const NEVER_SERVED = /html|xml|svg|script|ecmascript|json|text\/|multipart\//i;

export interface BlobResponseOptions {
  /** Lowercase hex SHA-256 of the object; becomes the ETag and `Repr-Digest`. */
  sha256: string;
  /** Gated responses are `private, no-store`; ungated ones immutable for a year. */
  gated: boolean;
  /**
   * Which host the request arrived on. On the console host (`key.plrs.im`) the type is ALWAYS
   * `application/octet-stream` with `attachment` (R6-04): that origin holds the admin and
   * portal sessions. Only on the bytes host may a route pass a real type or `inline`.
   */
  host: "console" | "bytes";
  /** Bytes host only; must be in `BYTES_HOST_TYPES`, else octet-stream. */
  contentType?: string;
  /** Bytes host only, and only with an allowlisted `contentType`; default `attachment`. */
  disposition?: "attachment" | "inline";
  /** Sanitised into `Content-Disposition`; defaults to the hash. */
  filename?: string;
}

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return cleaned.slice(0, 128) || "download";
}

function baseType(t: string): string {
  return (t.split(";")[0] ?? "").trim().toLowerCase();
}

function resolveType(opts: BlobResponseOptions): {
  type: string;
  inline: boolean;
} {
  if (opts.host !== "bytes" || !opts.contentType)
    return { type: "application/octet-stream", inline: false };
  const t = baseType(opts.contentType);
  if (!BYTES_HOST_TYPES.has(t) || NEVER_SERVED.test(t))
    return { type: "application/octet-stream", inline: false };
  return { type: t, inline: opts.disposition === "inline" };
}

type ByteRange = { offset: number; length: number };

/**
 * Parse a single-range `Range` header against a known size (RFC 9110 §14.1.2).
 *
 * `null` — no usable range: absent, malformed, a non-bytes unit or several ranges; the server
 * MAY ignore those and send the whole representation, and does. `"unsatisfiable"` — a
 * syntactically valid range that selects nothing (→ 416).
 */
export function parseRange(
  header: string | null,
  size: number,
): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return null;
  const [, a = "", b = ""] = m;
  if (a === "" && b === "") return null;
  if (a === "") {
    const suffix = Number(b);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(a);
  if (b !== "" && Number(b) < start) return null;
  if (start >= size) return "unsatisfiable";
  const end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  return { offset: start, length: end - start + 1 };
}

/** RFC 9110 §13.1.2: weak comparison, `*` matches anything that exists. */
function ifNoneMatchHits(header: string | null, etag: string): boolean {
  if (header === null) return false;
  const want = etag.replace(/^W\//, "");
  return header
    .split(",")
    .map((t) => t.trim())
    .some((t) => t === "*" || t.replace(/^W\//, "") === want);
}

/**
 * Serve one stored object: GET or HEAD, with Range, If-Range and If-None-Match.
 *
 * Takes the bucket and key rather than an already-fetched object: R2's own conditional
 * handling compares R2's etag, and this response's ETag is the SHA-256, so the conditionals
 * are evaluated here against the SHA-256 and R2 is asked only for the byte range that results.
 *
 * The caller has already decided the request may see this key (`hasRef`, and any gating). A
 * missing object, or one whose stored checksum is not `opts.sha256`, answers not-found.
 *
 * Headers on every 200/206/304: `ETag: "<hex>"`, `Repr-Digest` (the whole representation,
 * also on a 206), `Accept-Ranges: bytes`, `X-Content-Type-Options: nosniff`, `BLOB_CSP`, and
 * `Cache-Control` — `public, max-age=31536000, immutable, no-transform` ungated (no edge
 * recompression: hashes and ranges depend on the stored bytes), `private, no-store` gated.
 */
export async function blobResponse(
  req: Request,
  bucket: R2Bucket,
  key: string,
  opts: BlobResponseOptions,
): Promise<Response> {
  const parsed = parseKey(key);
  const named = parsed ? namedHash(parsed) : null;
  if (!parsed || (named !== null && named !== opts.sha256))
    throw new BlobKeyError("blobResponse: key is not named by opts.sha256");
  // Staged objects are unverified CI uploads: nothing may serve them.
  if (parsed.area === "staging")
    throw new BlobKeyError("blobResponse: staging/ objects are never served");
  // A key under gated/ is private whatever the caller passed: a gated object must never be
  // written into a shared cache by a route that forgot to say so.
  const gated = opts.gated || parsed.gated;

  if (req.method !== "GET" && req.method !== "HEAD")
    return new Response(null, {
      status: 405,
      headers: { allow: "GET, HEAD", "cache-control": "no-store" },
    });

  const head = await bucket.head(key);
  if (!head) return notFound();
  const stored = checksumHex(head);
  // A stored checksum that is not the expected hash means the record and the bytes disagree;
  // serving them would hand out bytes under the wrong name, so the answer is not-found.
  if (stored !== null && stored !== opts.sha256) return notFound();

  const etag = `"${opts.sha256}"`;
  const headers = new Headers({
    etag,
    "repr-digest": reprDigest(opts.sha256),
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    "content-security-policy": BLOB_CSP,
    "cache-control": gated
      ? "private, no-store"
      : "public, max-age=31536000, immutable, no-transform",
  });

  if (ifNoneMatchHits(req.headers.get("if-none-match"), etag))
    return new Response(null, { status: 304, headers });

  const { type, inline } = resolveType(opts);
  headers.set("content-type", type);
  headers.set(
    "content-disposition",
    `${inline ? "inline" : "attachment"}; filename="${sanitizeFilename(opts.filename ?? opts.sha256)}"`,
  );

  // If-Range: a validator that is not exactly this strong ETag (another version, a weak tag,
  // or a date) means "send the whole thing" — so a resumed download never splices versions.
  const ifRange = req.headers.get("if-range");
  const rangeHeader =
    ifRange === null || ifRange.trim() === etag
      ? req.headers.get("range")
      : null;
  const range = parseRange(rangeHeader, head.size);

  if (range === "unsatisfiable") {
    headers.set("content-range", `bytes */${head.size}`);
    headers.set("cache-control", "no-store");
    headers.delete("content-type");
    headers.delete("content-disposition");
    return new Response(null, { status: 416, headers });
  }

  const status = range ? 206 : 200;
  const length = range ? range.length : head.size;
  headers.set("content-length", String(length));
  if (range)
    headers.set(
      "content-range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`,
    );

  if (req.method === "HEAD") return new Response(null, { status, headers });

  const obj = await bucket.get(key, {
    onlyIf: { etagMatches: head.etag },
    ...(range ? { range } : {}),
  });
  if (!obj || !("body" in obj)) return notFound();
  return new Response(obj.body, { status, headers });
}
