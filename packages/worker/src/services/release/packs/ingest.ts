/**
 * Pack record ingest (P4-02, plans/P4-01.md §6): the checks a CI-signed `kind: pack` record
 * passes before it is stored, and the rows it writes.
 *
 * A pack release IS its record: there is no descriptor (the record is the whole truth, and every
 * pack object is a blob of the product's store). After the checks every record shares
 * (`../records.ts` `verifyRecordJws`: `typ`, `kid`, `product-key`, `signature`, `claims`), a pack
 * record is refused with `release_record_rejected` and one of these reasons, in this order:
 *
 *   pack-unknown      the deliverable is not a declared pack (checked before `scheme`, because
 *                     the scheme is the pack's declaration);
 *   scheme            the version does not parse under the pack's `versioning.scheme`;
 *   seq               a new release's `seq` is not above the deliverable's last, or an existing
 *                     release's differs;
 *   pack-type         `type` differs from the declaration;
 *   pack-variant      a variant names an axis or a value the declaration does not;
 *   pack-requires     (P4-12) a variant's signed `requires.contentApi`, `requires.packs` or
 *                     `conflicts` disagrees with the pack's binding or names what the product
 *                     does not declare: a `compatible` pack signs a `requires.contentApi.app`
 *                     range in every variant, a `standalone` one never does, `requires.packs`
 *                     names declared compatible or standalone packs with a version range, and
 *                     `conflicts` names other declared packs;
 *   pack-channel      (P4-12) the record's `channel` is not `stable`, `beta` or one of the
 *                     channels the pack declares;
 *   pack-entitlement  `entitlement` (absent = none) differs from the delivery gate
 *                     `delivery.entitlement` answers now, or from the declaration's assertion;
 *   pack-index        a variant's `files.size` or `files.bytes` is above
 *                     `MAX_PUBLISHED_INDEX_BYTES`, or the indexes total more than
 *                     `MAX_INGEST_INDEX_BYTES` decoded (both before anything is read); or an
 *                     index fails `parseFilesIndex` (client-core's, decision 33);
 *   pack-object       a variant's `full.size` differs from its `payload.size`, or an object the
 *                     record or an index names is not stored with that length under the pack's
 *                     prefix (`gated/` exactly when the record carries an `entitlement`), or the
 *                     product holds no ref to it (P2-01's possession rule).
 *
 * ONE INDEX AT A TIME (decision 36). Each index is read from the blob store (bounded by its
 * recorded bytes, never a size from the request), decoded with `@polaris-key/zstd-wasm` (a fresh
 * WASM instance per decode on workerd), parsed, its file blobs checked, and dropped before the
 * next is read. 8 MiB decoded costs about 37 MiB to hold and parse, under a third of an isolate.
 *
 * Object checks run as batched `json_each` queries of at most `OBJECT_CHECK_BATCH` `[key, bytes]`
 * pairs (one bound JSON value, inside D1's value limit), because D1's 100-parameter limit would
 * make an `IN` list cost one query per 89 keys.
 */

import {
  APP_DELIVERABLE_ID,
  BUILT_IN_CHANNELS,
  CONTENT_API_RANGE_PATTERN,
  MAX_INGEST_INDEX_BYTES,
  MAX_PACK_CONFLICTS,
  MAX_PUBLISHED_INDEX_BYTES,
  PACK_VERSION_RANGE_PATTERN,
  isDeliverableId,
  packVariantKeys,
  type ManifestPackDeliverable,
  type PackObjectRole,
} from "@polaris-key/manifest";
import {
  dataOnlyPathRefusal,
  parseFilesIndex,
  variantKey,
} from "@polaris-key/client-core/packs";
import { parseVersion } from "@polaris-key/client-core/version";
import type {
  FilesDelta,
  PackRecordDoc,
  PayloadDelta,
} from "@polaris-key/protocol/packs";
import { decode as zstdDecode } from "@polaris-key/zstd-wasm";
import type { Db, DbParam, DbStatement } from "../../../core/platform.js";
import { blobKey } from "../../../core/blobs.js";
import type { RecordRefusalReason } from "../records.js";

/** At most this many `[storageKey, bytes]` pairs per `json_each` object check (≈ 750 KB). */
export const OBJECT_CHECK_BATCH = 10000;

export type PackRefusal = {
  ok: false;
  reason: RecordRefusalReason;
  message: string;
};

function refuse(reason: RecordRefusalReason, message: string): PackRefusal {
  return { ok: false, reason, message };
}

/** The `build_id` of a variant: its variant key, `default` for none (plans/P4-01.md §6). */
export function variantBuildId(
  variant: Readonly<Record<string, string>>,
): string {
  return variantKey(variant) || "default";
}

/** The release id of a pack release: `<packId>@<version>`, never the record's `tag`. Git allows
 *  `@` in a tag, so a GitHub release CAN carry the same id; the truth-store sync skips such a
 *  release and reports it (`packTagConflicts`), and its writes are guarded so they never touch a
 *  non-app row (`RELEASE_NOT_FOREIGN_DELIVERABLE_SQL`). */
export function packReleaseId(
  record: Pick<PackRecordDoc, "deliverable" | "version">,
): string {
  return `${record.deliverable}@${record.version}`;
}

// ── The record against the declaration (no I/O) ──────────────────────────────

/**
 * `pack-type`, `pack-variant`, `pack-entitlement`, then the two bounds checked before anything is
 * read: `pack-object` for a `full` whose size is not the payload's, `pack-index` for an index
 * over `MAX_PUBLISHED_INDEX_BYTES` or a record over `MAX_INGEST_INDEX_BYTES` in all.
 */
export function checkPackAgainstDeclaration(
  record: PackRecordDoc,
  pack: ManifestPackDeliverable,
  gate: string | null,
): PackRefusal | null {
  if (record.type !== pack.type)
    return refuse(
      "pack-type",
      `${record.deliverable} is declared type ${pack.type}; the record says ${record.type}.`,
    );
  for (const [i, v] of record.variants.entries()) {
    for (const [axis, value] of Object.entries(v.variant)) {
      // Own keys only: an axis named `constructor` or `__proto__` is not declared.
      const declared = Object.hasOwn(pack.variants, axis)
        ? (pack.variants as Record<string, string[] | undefined>)[axis]
        : undefined;
      if (!Array.isArray(declared) || !declared.includes(value))
        return refuse(
          "pack-variant",
          `variants[${i}] (${variantKey(v.variant) || "default"}) is outside ${record.deliverable}'s declared variants (${packVariantKeys(pack).join(", ") || "default"}).`,
        );
    }
  }
  const signed = record.entitlement ?? null;
  if (signed !== gate)
    return refuse(
      "pack-entitlement",
      gate === null
        ? `the record carries entitlement ${signed}, but ${record.deliverable} is ungated; an operator gates a pack under Distribution → Access.`
        : `${record.deliverable}'s delivery gate is ${gate}; the record carries ${signed ?? "none"}. Sign the gate the uploads preflight reports.`,
    );
  if (pack.entitlement !== null && pack.entitlement !== signed)
    return refuse(
      "pack-entitlement",
      `.pkey/release asserts ${record.deliverable} is gated by ${pack.entitlement}; the record carries ${signed ?? "none"}.`,
    );
  for (const [i, v] of record.variants.entries()) {
    if (v.full.size !== v.payload.size)
      return refuse(
        "pack-object",
        `variants[${i}].full decodes to ${v.full.size} bytes, not the payload's ${v.payload.size}.`,
      );
  }
  let total = 0;
  for (const [i, v] of record.variants.entries()) {
    if (
      v.files.size > MAX_PUBLISHED_INDEX_BYTES ||
      v.files.bytes > MAX_PUBLISHED_INDEX_BYTES
    )
      return refuse(
        "pack-index",
        `variants[${i}]'s files index is ${Math.max(v.files.size, v.files.bytes)} bytes; the Worker reads at most ${MAX_PUBLISHED_INDEX_BYTES} per index.`,
      );
    total += v.files.size;
  }
  if (total > MAX_INGEST_INDEX_BYTES)
    return refuse(
      "pack-index",
      `the record's files indexes decode to ${total} bytes in all; one ingest decodes at most ${MAX_INGEST_INDEX_BYTES}.`,
    );
  return null;
}

/** A variant's signed `conflicts` (a reserved member the claims ignore, P4-12), or undefined. */
export function variantConflicts(v: object): unknown {
  return (v as { conflicts?: unknown }).conflicts;
}

/**
 * `pack-requires` and `pack-channel` (P4-12): the record's per-variant requirements against the
 * pack's binding and the product's declared packs, and its channel against the pack's channels.
 * `declared` maps every declared pack id to its binding.
 */
export function checkPackRequires(
  record: PackRecordDoc,
  pack: ManifestPackDeliverable,
  declared: ReadonlyMap<string, string>,
): PackRefusal | null {
  const channel = record.channel;
  if (
    channel !== undefined &&
    !BUILT_IN_CHANNELS.includes(channel) &&
    !pack.channels.includes(channel)
  )
    return refuse(
      "pack-channel",
      `the record is on channel ${channel}; ${record.deliverable} publishes to stable, beta${pack.channels.length > 0 ? ` and ${pack.channels.join(", ")}` : ""} (declare more in the pack's channels).`,
    );
  for (const [i, v] of record.variants.entries()) {
    const at = `variants[${i}]`;
    const req = (v.requires ?? {}) as Record<string, unknown>;
    const contentApi = req.contentApi;
    if (pack.binding === "standalone" && contentApi !== undefined)
      return refuse(
        "pack-requires",
        `${at} signs requires.contentApi, but ${record.deliverable} is standalone: it depends on no contentApi.`,
      );
    if (contentApi !== undefined || pack.binding === "compatible") {
      const ok =
        contentApi !== null &&
        typeof contentApi === "object" &&
        !Array.isArray(contentApi) &&
        Object.keys(contentApi).length > 0 &&
        Object.entries(contentApi as Record<string, unknown>).every(
          ([k, r]) =>
            k === APP_DELIVERABLE_ID &&
            typeof r === "string" &&
            CONTENT_API_RANGE_PATTERN.test(r),
        );
      if (!ok)
        return refuse(
          "pack-requires",
          `${at}'s requires.contentApi must be { ${APP_DELIVERABLE_ID}: a range such as ">=3 <5" }${pack.binding === "compatible" ? `; ${record.deliverable} is compatible, so every variant signs one` : ""}.`,
        );
    }
    const packs = req.packs;
    if (packs !== undefined) {
      if (
        packs === null ||
        typeof packs !== "object" ||
        Array.isArray(packs) ||
        Object.keys(packs).length === 0
      )
        return refuse(
          "pack-requires",
          `${at}'s requires.packs must be an object of pack id → version range.`,
        );
      for (const [target, range] of Object.entries(
        packs as Record<string, unknown>,
      )) {
        const b = declared.get(target);
        if (
          target === record.deliverable ||
          (b !== "compatible" && b !== "standalone") ||
          typeof range !== "string" ||
          !PACK_VERSION_RANGE_PATTERN.test(range)
        )
          return refuse(
            "pack-requires",
            `${at}'s requires.packs.${target} must name another declared compatible or standalone pack with a version range such as ">=1.2.0 <2.0.0".`,
          );
      }
    }
    const conflicts = variantConflicts(v);
    if (conflicts !== undefined) {
      if (
        !Array.isArray(conflicts) ||
        conflicts.length > MAX_PACK_CONFLICTS ||
        new Set(conflicts).size !== conflicts.length ||
        !conflicts.every(
          (c) =>
            isDeliverableId(c) &&
            c !== record.deliverable &&
            declared.has(c as string),
        )
      )
        return refuse(
          "pack-requires",
          `${at}'s conflicts must list at most ${MAX_PACK_CONFLICTS} distinct other declared packs.`,
        );
    }
  }
  return null;
}

/** `scheme`: the version parses under the pack's version scheme. */
export function checkPackScheme(
  record: PackRecordDoc,
  pack: ManifestPackDeliverable,
): PackRefusal | null {
  return parseVersion(pack.versioning.scheme, record.version) === null
    ? refuse(
        "scheme",
        `the record's version ${record.version} does not parse under ${record.deliverable}'s ${pack.versioning.scheme} scheme.`,
      )
    : null;
}

// ── The objects a record names ───────────────────────────────────────────────

/** One object a pack record names, as its `release_artifacts` row will hold it. */
export interface PackObject {
  buildId: string;
  role: PackObjectRole;
  /** The ordinal of this role within its variant (several deltas). */
  ordinal: number;
  sha256: string;
  /** The stored length. */
  bytes: number;
  /** `blobs/sha256/<sha>`, or under `gated/` for a gated pack. */
  key: string;
  /** The ref's facts beyond the stored bytes (decoded size, codec, a delta's base). */
  meta: Record<string, unknown>;
}

/**
 * Every object the record names, variant by variant: `full` (role `payload`), the files index,
 * its gaps, a `payload` delta's frame (`delta`) and a `files` delta's descriptor and data
 * (`patch`, `patch-data`). A delta of another scope names nothing v1 knows. File blobs are not
 * here: they are named by the indexes, not the record.
 */
export function packObjects(record: PackRecordDoc): PackObject[] {
  const gated = record.entitlement !== undefined;
  const out: PackObject[] = [];
  for (const v of record.variants) {
    const buildId = variantBuildId(v.variant);
    const push = (
      role: PackObjectRole,
      ordinal: number,
      o: { sha256: string; bytes: number },
      meta: Record<string, unknown>,
    ) =>
      out.push({
        buildId,
        role,
        ordinal,
        sha256: o.sha256,
        bytes: o.bytes,
        key: blobKey(o.sha256, { gated }),
        meta,
      });
    push("payload", 0, v.full, { size: v.full.size, codec: v.full.codec });
    push("files-index", 0, v.files, {
      size: v.files.size,
      codec: v.files.codec,
      format: v.files.format,
      layout: v.files.layout,
    });
    if (v.files.gaps)
      push("files-gaps", 0, v.files.gaps, {
        size: v.files.gaps.size,
        codec: v.files.gaps.codec,
      });
    let deltas = 0;
    let patches = 0;
    for (const d of v.deltas ?? []) {
      if (d.scope === "payload") {
        const p = d as PayloadDelta;
        push("delta", deltas++, p.artifact, {
          method: p.method,
          from: p.from,
          memBytes: p.memBytes,
        });
      } else if (d.scope === "files") {
        const f = d as FilesDelta;
        const ordinal = patches++;
        push("patch", ordinal, f.patch, {
          size: f.patch.size,
          codec: f.patch.codec,
          method: f.method,
          from: f.from,
          memBytes: f.memBytes,
        });
        push("patch-data", ordinal, f.data, { from: f.from });
      }
    }
  }
  return out;
}

// ── Possession (P2-01's rule), in batched json_each queries ──────────────────

/**
 * The first of `pairs` (`[storageKey, bytes]`) that is not stored with that length or that
 * `product` holds no ref to, or null when every one is. One query per `batch` pairs.
 */
export async function firstMissingObject(
  db: Db,
  product: string,
  pairs: readonly (readonly [string, number])[],
  batch = OBJECT_CHECK_BATCH,
): Promise<string | null> {
  for (let i = 0; i < pairs.length; i += batch) {
    const chunk = pairs.slice(i, i + batch);
    const row = await db.first<{ k: string }>(
      `SELECT json_extract(j.value, '$[0]') AS k FROM json_each(?) AS j
        WHERE NOT EXISTS (SELECT 1 FROM blob_objects o
                           WHERE o.storage_key = json_extract(j.value, '$[0]')
                             AND o.size = json_extract(j.value, '$[1]'))
           OR NOT EXISTS (SELECT 1 FROM blob_refs r
                           WHERE r.product = ? AND r.storage_key = json_extract(j.value, '$[0]'))
        LIMIT 1`,
      JSON.stringify(chunk),
      product,
    );
    if (row) return row.k;
  }
  return null;
}

/** An object not yet promoted but judged as if it were: a dry run's verified staged copy. */
export interface PendingObject {
  sha256: string;
  size: number;
  /** Where its bytes can be read meanwhile (the staging key). */
  staging: string;
}

export interface ObjectCheckOptions {
  /** Objects a dry run would promote, by target key. */
  pending?: ReadonlyMap<string, PendingObject>;
  /** Ticket objects not yet uploaded, by target key: a dry run lists them as unverified. */
  unverified?: ReadonlySet<string>;
  /** P4-19: a delegated release; note the first index path the data-only rule refuses. */
  dataOnly?: boolean;
}

/** `pack-object` for `pairs`, honouring a dry run's pending and unverified objects. */
async function checkPairs(
  db: Db,
  product: string,
  pairs: readonly (readonly [string, number])[],
  opts: ObjectCheckOptions,
  label: (key: string) => string,
): Promise<PackRefusal | null> {
  const stored: [string, number][] = [];
  for (const [key, bytes] of pairs) {
    const p = opts.pending?.get(key);
    if (p) {
      if (p.size !== bytes)
        return refuse(
          "pack-object",
          `${label(key)} is staged with ${p.size} bytes, not ${bytes}.`,
        );
      continue;
    }
    if (opts.unverified?.has(key)) continue;
    stored.push([key, bytes]);
  }
  const missing = await firstMissingObject(db, product, stored);
  return missing === null
    ? null
    : refuse(
        "pack-object",
        `${label(missing)} is not stored with its recorded length under this product's refs (upload it in a stage round first).`,
      );
}

// ── The objects and indexes, against the store ───────────────────────────────

export interface PackStoreCheck {
  ok: true;
  /** How many file blobs the indexes named (each checked). */
  files: number;
  /** Index keys a dry run could not read yet (not uploaded), so their files went unchecked. */
  unreadIndexes: string[];
  /** With `dataOnly` (P4-19): the first index path the data-only extension rule refuses. */
  dataOnlyRefused?: string;
}

/**
 * Every object the record names, then each variant's files index (read, decoded, parsed and its
 * file blobs checked, one index at a time).
 */
export async function checkPackStore(
  db: Db,
  bucket: R2Bucket,
  product: string,
  record: PackRecordDoc,
  opts: ObjectCheckOptions = {},
): Promise<PackStoreCheck | PackRefusal> {
  const objects = packObjects(record);
  const byKey = new Map(objects.map((o) => [o.key, o]));
  const named = await checkPairs(
    db,
    product,
    [...byKey.values()].map((o) => [o.key, o.bytes] as const),
    opts,
    (key) => {
      const o = byKey.get(key);
      return o ? `${o.buildId}'s ${o.role} object ${o.sha256}` : key;
    },
  );
  if (named) return named;

  const gated = record.entitlement !== undefined;
  let files = 0;
  const unreadIndexes: string[] = [];
  let dataOnlyRefused: string | undefined;
  for (const [i, v] of record.variants.entries()) {
    const key = blobKey(v.files.sha256, { gated });
    const pending = opts.pending?.get(key);
    if (!pending && opts.unverified?.has(key)) {
      unreadIndexes.push(key);
      continue;
    }
    const stored = await readObject(
      bucket,
      pending?.staging ?? key,
      v.files.bytes,
    );
    if (!stored)
      return refuse(
        "pack-object",
        `variants[${i}]'s files index ${v.files.sha256} could not be read from the blob store.`,
      );
    const parsed = await parseFilesIndex(stored, v.files, v, {
      decode: (frame, size) => zstdDecode(frame, size),
      maxBytes: MAX_PUBLISHED_INDEX_BYTES,
    });
    if (!parsed.ok)
      return refuse(
        "pack-index",
        `variants[${i}]'s files index fails ${parsed.error}${parsed.path ? ` at ${parsed.path}` : ""}.`,
      );
    // The index's file blobs: each once, then the index is dropped before the next is read.
    const blobs = new Map<string, number>();
    for (const e of parsed.index.files) {
      blobs.set(blobKey(e.blob.sha256, { gated }), e.blob.bytes);
      if (
        opts.dataOnly &&
        dataOnlyRefused === undefined &&
        dataOnlyPathRefusal(e.path) !== null
      )
        dataOnlyRefused = e.path;
    }
    const fileCheck = await checkPairs(
      db,
      product,
      [...blobs.entries()],
      opts,
      (k) => `a file blob of variants[${i}] (${k})`,
    );
    if (fileCheck) return fileCheck;
    files += blobs.size;
  }
  return {
    ok: true,
    files,
    unreadIndexes,
    ...(dataOnlyRefused !== undefined ? { dataOnlyRefused } : {}),
  };
}

/** An object's bytes, or null when it is not there or not exactly `bytes` long. */
async function readObject(
  bucket: R2Bucket,
  key: string,
  bytes: number,
): Promise<Uint8Array | null> {
  const obj = await bucket.get(key);
  if (!obj || !("arrayBuffer" in obj)) return null;
  if (obj.size !== bytes) {
    await obj.body?.cancel().catch(() => undefined);
    return null;
  }
  const buf = new Uint8Array(await obj.arrayBuffer());
  return buf.byteLength === bytes ? buf : null;
}

// ── The rows ─────────────────────────────────────────────────────────────────

/** True while the pack release row holds THIS record. Params: product, release id, sha256. */
export const PACK_RELEASE_RECORD_SQL = `EXISTS (
  SELECT 1 FROM release_metadata
   WHERE product = ? AND release_id = ?
     AND json_extract(metadata_json, '$.record.sha256') = ?)`;

function chunks<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * A guarded multi-row insert: `INSERT … SELECT column1, … FROM (VALUES (…), …) WHERE <guard>`,
 * at most 100 parameters per statement (D1's limit) with the guard's own.
 */
function guardedInserts(
  table: string,
  columns: readonly string[],
  rows: readonly DbParam[][],
  guard: { sql: string; params: readonly DbParam[] },
  conflict = "",
): DbStatement[] {
  const perRow = columns.length;
  const per = Math.max(1, Math.floor((100 - guard.params.length) / perRow));
  return chunks(rows, per).map((rs) => ({
    sql: `INSERT INTO ${table} (${columns.join(", ")})
          SELECT ${columns.map((_, i) => `column${i + 1}`).join(", ")}
            FROM (VALUES ${rs.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ")})
           WHERE ${guard.sql}
          ${conflict}`,
    params: [...rs.flat(), ...guard.params],
  }));
}

export interface PackRowsInput {
  product: string;
  record: PackRecordDoc;
  recordSha256: string;
  kid: string;
  jws: string;
  metadataAccess: string;
  artifactsAccess: string;
  now: number;
}

/**
 * Every row of one pack release, in one batch: the release row (`release_metadata`, inserted only
 * while no release of this version exists and the `seq` is still above the deliverable's last),
 * then — each guarded on that row holding THIS record — the record, one `release_builds` row per
 * variant, one `release_artifacts` row per object the record names (with its pack role) and a
 * `pack-object` blob ref with the release id for each. File blobs get no row: their `pack-upload`
 * refs hold them, and a release's files are read from its index (the hook's `packFiles`).
 */
export function packReleaseStatements(r: PackRowsInput): DbStatement[] {
  const { product, record, now } = r;
  const releaseId = packReleaseId(record);
  const marker = JSON.stringify({
    record: { sha256: r.recordSha256, kind: "pack" },
  });
  const guard = {
    sql: PACK_RELEASE_RECORD_SQL,
    params: [product, releaseId, r.recordSha256] as DbParam[],
  };
  const head: DbStatement = {
    sql: `INSERT INTO release_metadata
            (product, release_id, version, title, notes, commit_sha, source_url,
             metadata_access, artifacts_access, published_at, metadata_json,
             created_at, modified_at, deliverable_id, seq, channel)
          SELECT ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, json(?), ?, ?, ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM release_metadata
                              WHERE product = ? AND (release_id = ?
                                    OR (deliverable_id = ? AND version = ?)))
             AND (SELECT COALESCE(MAX(seq), 0) FROM release_metadata
                   WHERE product = ? AND deliverable_id = ?) < ?`,
    params: [
      product,
      releaseId,
      record.version,
      record.title ?? null,
      record.notes ?? null,
      record.provenance?.commit ?? null,
      r.metadataAccess,
      r.artifactsAccess,
      record.issuedAt,
      marker,
      now,
      now,
      record.deliverable,
      record.seq,
      record.channel ?? null,
      product,
      releaseId,
      record.deliverable,
      record.version,
      product,
      record.deliverable,
      record.seq,
    ],
  };
  const recordRow = guardedInserts(
    "release_records",
    [
      "product",
      "deliverable_id",
      "release_id",
      "seq",
      "kind",
      "record_sha256",
      "kid",
      "jws",
      "ingested_at",
    ],
    [
      [
        product,
        record.deliverable,
        releaseId,
        record.seq,
        "pack",
        r.recordSha256,
        r.kid,
        r.jws,
        now,
      ],
    ],
    guard,
    "ON CONFLICT DO NOTHING",
  );
  const builds = guardedInserts(
    "release_builds",
    [
      "product",
      "release_id",
      "build_id",
      "platform",
      "arch",
      "format",
      "variant_json",
      "requires_json",
      "conflicts_json",
      "created_at",
      "modified_at",
    ],
    record.variants.map((v) => {
      const conflicts = variantConflicts(v);
      return [
        product,
        releaseId,
        variantBuildId(v.variant),
        null,
        "any",
        record.type,
        JSON.stringify(v.variant),
        v.requires ? JSON.stringify(v.requires) : null,
        Array.isArray(conflicts) ? JSON.stringify(conflicts) : null,
        now,
        now,
      ];
    }),
    guard,
    "ON CONFLICT DO NOTHING",
  );
  const objects = packObjects(record);
  const artifacts = guardedInserts(
    "release_artifacts",
    [
      "product",
      "release_id",
      "artifact_id",
      "name",
      "kind",
      "platform",
      "arch",
      "content_type",
      "size_bytes",
      "sha256",
      "storage_key",
      "access",
      "metadata_json",
      "created_at",
      "build_id",
      "role",
      "locations_json",
    ],
    objects.map((o) => {
      const id = `${o.buildId}/${o.role}${o.ordinal > 0 ? `-${o.ordinal}` : ""}`;
      return [
        product,
        releaseId,
        id,
        id,
        "pack-object",
        null,
        "any",
        "application/octet-stream",
        o.bytes,
        o.sha256,
        o.key,
        r.artifactsAccess,
        JSON.stringify(o.meta),
        now,
        o.buildId,
        o.role,
        JSON.stringify([{ provider: "r2", key: o.key }]),
      ];
    }),
    guard,
    "ON CONFLICT DO NOTHING",
  );
  const keys = [...new Set(objects.map((o) => o.key))];
  const refs = guardedInserts(
    "blob_refs",
    ["product", "storage_key", "ref_kind", "ref_id", "created_at"],
    keys.map((k) => [product, k, "pack-object", releaseId, now]),
    guard,
    "ON CONFLICT DO NOTHING",
  );
  return [head, ...recordRow, ...builds, ...artifacts, ...refs];
}

/** The decoded payload of a stored compact JWS (no verification: it was verified at ingest). */
export function storedRecordPayload(
  jws: string,
): Record<string, unknown> | null {
  const middle = jws.split(".")[1];
  if (!middle) return null;
  try {
    const b64 = middle.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const v: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
