/// <reference types="@cloudflare/workers-types" />

/**
 * Release records (`pkey-release+jws`, WIRE-CONTRACT-V4 §2.4; P3-03, plans/P3-01.md §6).
 *
 * A release record is what CI signs, with a release key the Worker never holds, to say that a
 * release exists: its version, `seq` and builds, each payload's SHA-256 and size. The Worker
 * signs WHICH and WHEN (the channel feed); CI signs WHAT EXISTS. This module is the Worker's half
 * of the record:
 *
 *   - the declared release keys (`.pkey/release` `releaseKeys`, persisted to
 *     `release_config.release_keys_json` by link and resync), with the one check the manifest
 *     validator cannot make: a release key is never one of the product's signing keys
 *     (`release_key_is_product_key`);
 *   - the ingest check P2-02's submit runs before anything is stored (`checkReleaseRecord`): one
 *     code, `release_record_rejected`, with the reasons `typ`, `kid`, `product-key`, `signature`,
 *     `claims`, `scheme`, `descriptor-mismatch` and `seq`;
 *   - storage that never rewrites a record (`release_records`), and the reads behind
 *     `GET /<p>/release/records/<sha256>` and the feed composer.
 *
 * NEVER HOLD OR ACCEPT A PRIVATE RELEASE KEY. Ingest verification is defence in depth: clients
 * trust only the release keys pinned in their binaries. A record that failed ingest is never
 * stored, so never served, and the Worker never mints one.
 */

import {
  canonicalDescriptorJson,
  descriptorToRecord,
  normalizeReleaseKeys,
  releaseKeyBytes,
  sameKeyBytes,
  type ManifestAppDeliverable,
  type ManifestReleaseKey,
  type ReleaseDescriptor,
} from "@polaris-key/manifest";
import { base64UrlDecode, verifyJws } from "@polaris-key/jws";
import { MAX_RECORD_JWS_BYTES } from "@polaris-key/protocol/core";
import type { ReleaseRecordDoc } from "@polaris-key/protocol/release";
import { releaseRecordClaims } from "@polaris-key/client-core/record";
import { parseVersion } from "@polaris-key/client-core/version";
import type { Db, DbStatement } from "../../core/platform.js";
import type { ReleaseConfigRow } from "./config.js";

/** The one ingest refusal code (registered in `conformance/parity/errors.json`). */
export const RELEASE_RECORD_REJECTED = "release_record_rejected";

/** Why a record was refused, in the order the checks run. */
export type RecordRefusalReason =
  | "typ"
  | "kid"
  | "product-key"
  | "signature"
  | "claims"
  | "scheme"
  | "descriptor-mismatch"
  | "seq";

export type RecordCheck =
  | {
      ok: true;
      record: ReleaseRecordDoc;
      /** Lowercase hex SHA-256 of the exact compact JWS bytes. */
      sha256: string;
      kid: string;
      jws: string;
    }
  | { ok: false; reason: RecordRefusalReason; message: string };

/** One stored record row (`release_records`). */
export interface ReleaseRecordRow {
  product: string;
  deliverable_id: string;
  release_id: string;
  seq: number;
  kind: string;
  record_sha256: string;
  kid: string;
  jws: string;
  ingested_at: number;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** Is `s` a well-formed record hash (the record route's path segment)? */
export function isRecordHash(s: string): boolean {
  return SHA256_HEX_RE.test(s);
}

export async function sha256HexOfAscii(text: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Declared release keys ────────────────────────────────────────────────────

/** `release_config.release_keys_json` read back; malformed JSON or entries are dropped. */
export function parseReleaseKeysJson(
  json: string | null | undefined,
): ManifestReleaseKey[] {
  if (!json) return [];
  try {
    return normalizeReleaseKeys(JSON.parse(json));
  } catch {
    return [];
  }
}

/** The product's declared release keys as a trust set (`kid` → raw base64url). */
export function releaseKeyTrustSet(
  cfg: Pick<ReleaseConfigRow, "release_keys_json"> | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of parseReleaseKeysJson(cfg?.release_keys_json))
    out[k.kid] = k.publicKey;
  return out;
}

/**
 * Lowercase hex SHA-256 of each declared release key's raw 32 bytes: discovery's
 * `release.releaseKeyFingerprints`, for tooling (`pkey release keys check`). No SDK reads it.
 */
export async function releaseKeyFingerprints(
  cfg: Pick<ReleaseConfigRow, "release_keys_json"> | null,
): Promise<string[]> {
  const out: string[] = [];
  for (const k of parseReleaseKeysJson(cfg?.release_keys_json)) {
    const bytes = releaseKeyBytes(k.publicKey);
    if (bytes) out.push(await sha256HexOfBytes(bytes));
  }
  return out;
}

/**
 * Every signing key the product has ever had — `products.signing_pub` and every
 * `product_keys.public_b64url` whatever its status (active, retired, revoked) — as raw bytes. A
 * release key must equal none of them: the Worker holds each one's private half.
 */
export async function productSigningKeyBytes(
  db: Db,
  product: string,
): Promise<Uint8Array[]> {
  const rows = await db.all<{ k: string | null }>(
    `SELECT signing_pub AS k FROM products WHERE slug = ?
     UNION ALL
     SELECT public_b64url AS k FROM product_keys WHERE product = ?`,
    product,
    product,
  );
  const out: Uint8Array[] = [];
  for (const r of rows) {
    if (!r.k) continue;
    try {
      const bytes = base64UrlDecode(r.k);
      if (bytes.length === 32) out.push(bytes);
    } catch {
      // Not a raw key: it cannot collide with one.
    }
  }
  return out;
}

/** The sync's refusal code for a release key that is a product key (a console code, reported
 *  in the resync result and `product_sync_state`; no SDK sees it). */
export const RELEASE_KEY_IS_PRODUCT_KEY = "release_key_is_product_key";

/** A declared release key the sync refused. */
export interface ReleaseKeyRefusal {
  kid: string;
  code: typeof RELEASE_KEY_IS_PRODUCT_KEY;
  message: string;
}

/**
 * The `release_keys_json` a link or resync writes, or the refusal that keeps the previous value.
 * A declared key whose raw bytes equal any of the product's signing keys refuses the WHOLE set
 * (`release_key_is_product_key`), and the sync keeps whatever it stored before: a partial set
 * would silently drop a key CI may already sign with. `extraSigningKeys` are signing keys the
 * same batch is about to write (a link mints the first one).
 */
export async function releaseKeysForSync(
  db: Db,
  product: string,
  declared: readonly ManifestReleaseKey[],
  extraSigningKeys: readonly string[] = [],
): Promise<
  | { ok: true; json: string | null }
  | { ok: false; refused: ReleaseKeyRefusal[] }
> {
  if (declared.length === 0) return { ok: true, json: null };
  const signing = await productSigningKeyBytes(db, product);
  for (const k of extraSigningKeys) {
    try {
      const bytes = base64UrlDecode(k);
      if (bytes.length === 32) signing.push(bytes);
    } catch {
      // ignore
    }
  }
  const refused: ReleaseKeyRefusal[] = [];
  for (const key of declared) {
    const bytes = releaseKeyBytes(key.publicKey);
    if (bytes && signing.some((s) => sameKeyBytes(s, bytes)))
      refused.push({
        kid: key.kid,
        code: RELEASE_KEY_IS_PRODUCT_KEY,
        message: `release key ${key.kid} is one of ${product}'s signing keys; a release key must never be a key the Worker holds. The previous releaseKeys are kept.`,
      });
  }
  if (refused.length > 0) return { ok: false, refused };
  return {
    ok: true,
    json: JSON.stringify(
      declared.map((k) => ({ kid: k.kid, publicKey: k.publicKey })),
    ),
  };
}

// ── The ingest check ─────────────────────────────────────────────────────────

/** The compact JWS's protected header, decoded leniently (only to name `typ` and `kid`). */
function peekHeader(jws: string): { typ?: unknown; kid?: unknown } | null {
  const first = jws.split(".")[0];
  if (!first) return null;
  try {
    const value: unknown = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(first)),
    );
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as { typ?: unknown; kid?: unknown })
      : null;
  } catch {
    return null;
  }
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7e) return false;
  return true;
}

export interface RecordCheckInput {
  product: string;
  /** What the submit carried as `record`. */
  jws: unknown;
  /** The validated descriptor the record arrived with. */
  descriptor: ReleaseDescriptor;
  cfg: Pick<ReleaseConfigRow, "release_keys_json"> | null;
  /** The deliverable's declaration; `null` = the implicit app (scheme `semver`). */
  app: ManifestAppDeliverable | null;
  /** The `seq` the release holds, or takes when the descriptor's rows are written. */
  seq: number;
}

function refuse(reason: RecordRefusalReason, message: string): RecordCheck {
  return { ok: false, reason, message };
}

/**
 * Every check of the record ingest, in the plan's order (§6), reading only: `typ`, then the
 * `kid` among the declared release keys, then that key is not a product signing key, then the
 * signature through `shared-jws` (V4 §1.1–§1.2's strictness), then `releaseRecordClaims` given
 * the verifier's non-wire-integer pointers (the claims every v4 SDK runs), then the version
 * under the deliverable's scheme (SemVer 2.0's grammar for `semver`), then the record equals the
 * descriptor under §2.4's mapping, then the record's `seq` is the release's.
 */
export async function checkReleaseRecord(
  db: Db,
  input: RecordCheckInput,
): Promise<RecordCheck> {
  const { product, descriptor } = input;
  const jws = input.jws;
  if (typeof jws !== "string" || jws.split(".").length !== 3)
    return refuse("typ", "record must be a compact JWS (pkey-release+jws).");
  const header = peekHeader(jws);
  if (!header || header.typ !== "pkey-release+jws")
    return refuse("typ", "the record's typ must be pkey-release+jws.");

  const keys = releaseKeyTrustSet(input.cfg);
  if (typeof header.kid !== "string" || !Object.hasOwn(keys, header.kid))
    return refuse(
      "kid",
      Object.keys(keys).length === 0
        ? `${product} declares no releaseKeys in .pkey/release, so no record can be accepted.`
        : `the record's kid is not one of ${product}'s declared releaseKeys.`,
    );
  const kid = header.kid;
  const publicKey = keys[kid] as string;
  const keyBytes = releaseKeyBytes(publicKey);
  const signing = await productSigningKeyBytes(db, product);
  if (!keyBytes || signing.some((s) => sameKeyBytes(s, keyBytes)))
    return refuse(
      "product-key",
      `release key ${kid} is one of ${product}'s signing keys; a record signed with it proves nothing.`,
    );

  if (jws.length > MAX_RECORD_JWS_BYTES || !isAscii(jws))
    return refuse(
      "signature",
      `a record is ASCII and at most ${MAX_RECORD_JWS_BYTES} bytes.`,
    );
  const verified = await verifyJws<unknown>(
    jws,
    { [kid]: publicKey },
    {
      typ: "pkey-release+jws",
    },
  );
  if (!verified)
    return refuse(
      "signature",
      `the record does not verify against release key ${kid} (WIRE-CONTRACT-V4 §1).`,
    );

  if (
    !releaseRecordClaims(verified.payload, {
      expectedAud: product,
      nonWire: verified.nonWireIntegers,
    })
  )
    return refuse(
      "claims",
      "the record's claims do not hold (WIRE-CONTRACT-V4 §2.4).",
    );
  const record = verified.payload as ReleaseRecordDoc;

  const scheme = input.app?.versioning.scheme ?? "semver";
  if (parseVersion(scheme, record.version) === null)
    return refuse(
      "scheme",
      `the record's version ${record.version} does not parse under the deliverable's ${scheme} scheme.`,
    );

  const fields = {
    seq: record.seq,
    issuedAt: record.issuedAt,
    ...(record.minSupportedSeq !== undefined
      ? { minSupportedSeq: record.minSupportedSeq }
      : {}),
  };
  // The descriptor must carry the record's `seq` explicitly. Without it the ingest numbers the
  // release itself, and a concurrent publish taking the planned seq would store the release
  // under the next one while the record's guarded insert writes nothing — a stored publish
  // answered as a refusal. With it, P2-04's explicit-seq guard writes nothing on that race and
  // answers its own retryable refusal, the ticket given back.
  if (descriptor.seq === undefined)
    return refuse(
      "descriptor-mismatch",
      "a descriptor submitted with a record must carry the record's seq (the upload route's answer).",
    );
  if (
    descriptor.seq !== record.seq ||
    canonicalDescriptorJson(descriptorToRecord(descriptor, fields)) !==
      canonicalDescriptorJson(record)
  )
    return refuse(
      "descriptor-mismatch",
      "the record is not the descriptor it was submitted with (plans/P3-01.md §2.4's mapping).",
    );

  if (record.seq !== input.seq)
    return refuse(
      "seq",
      `the record says seq ${record.seq}; ${descriptor.deliverable} ${descriptor.version} has seq ${input.seq}. Ask the upload route for the release's seq and sign again.`,
    );

  return { ok: true, record, sha256: await sha256HexOfAscii(jws), kid, jws };
}

// ── Storage ──────────────────────────────────────────────────────────────────

/**
 * Store an accepted record, never over another. Written only while the release row holds the
 * record's `seq` and THIS descriptor (so a lost race stores nothing), and only while the release
 * has no record yet: a record is evidence, never rewritten. A conflict on the hash or on
 * (deliverable, seq) writes nothing.
 */
export function stmtInsertReleaseRecord(r: {
  product: string;
  releaseId: string;
  deliverableId: string;
  descriptorSha256: string;
  check: Extract<RecordCheck, { ok: true }>;
  now: number;
}): DbStatement {
  return {
    sql: `INSERT INTO release_records
            (product, deliverable_id, release_id, seq, kind, record_sha256, kid, jws, ingested_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM release_metadata
                          WHERE product = ? AND release_id = ? AND seq = ?
                            AND json_extract(metadata_json, '$.descriptor.sha256') = ?)
             AND NOT EXISTS (SELECT 1 FROM release_records
                              WHERE product = ? AND release_id = ?)
          ON CONFLICT DO NOTHING`,
    params: [
      r.product,
      r.deliverableId,
      r.releaseId,
      r.check.record.seq,
      r.check.record.kind,
      r.check.sha256,
      r.check.kid,
      r.check.jws,
      r.now,
      r.product,
      r.releaseId,
      r.check.record.seq,
      r.descriptorSha256,
      r.product,
      r.releaseId,
    ],
  };
}

/** The record stored under a hash, or null. */
export async function getRecordByHash(
  db: Db,
  product: string,
  sha256: string,
): Promise<ReleaseRecordRow | null> {
  return db.first<ReleaseRecordRow>(
    "SELECT * FROM release_records WHERE product = ? AND record_sha256 = ?",
    product,
    sha256,
  );
}

/** A release's record, or null (a release published before v4, or without a record). */
export async function getRecordForRelease(
  db: Db,
  product: string,
  releaseId: string,
): Promise<ReleaseRecordRow | null> {
  return db.first<ReleaseRecordRow>(
    "SELECT * FROM release_records WHERE product = ? AND release_id = ?",
    product,
    releaseId,
  );
}

/** Every record of a deliverable, by release id (the composer reads them in one query). */
export async function recordsByRelease(
  db: Db,
  product: string,
  deliverableId: string,
): Promise<Map<string, ReleaseRecordRow>> {
  const rows = await db.all<ReleaseRecordRow>(
    "SELECT * FROM release_records WHERE product = ? AND deliverable_id = ?",
    product,
    deliverableId,
  );
  return new Map(rows.map((r) => [r.release_id, r]));
}
