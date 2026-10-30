/**
 * The file tables of the Durable Object's SQLite store (U-10.4; schema v4): `files`, `uploads`,
 * `upload_parts` and `ssec_keys`. `SqlStore` owns the schema, the guards (lazy schema, the write
 * check) and the meta; this file only reads and writes the rows, through the two query functions
 * it is handed, so every statement stays parameterised and metered in one place.
 *
 * `files` has one row per (collection, record, version): the version is the store sequence of the
 * `finalize` that stored the file. `uploads` is one row per session, from `begin` to the end of
 * its retention; `upload_parts` has one row per part received (a single `PUT` is part 1).
 * `ssec_keys` holds the SSE-C key of a server-mode file, referenced by `files.ssec_kid`.
 */

import type { SyncFileEnc, SyncFileFormat } from "@polaris-key/protocol/sync";
import type {
  FileStatus,
  StoredFile,
  UploadPart,
  UploadRow,
  UploadState,
} from "../engine/types.js";
import type { Row, SqlQuery } from "./sqlRecords.js";

/** `uploads.base_version` for a create-only (`"*"`) `begin`. NULL is an unconditional one. */
const CREATE_ONLY = -1;

interface FileRow extends Row {
  collection: string;
  record_id: string;
  version: number;
  object_key: string;
  format: string;
  enc: string;
  size: number;
  sha256: string;
  status: string;
  ssec_kid: string | null;
  created_at: number;
  client_id: string;
}

interface UploadDbRow extends Row {
  upload_id: string;
  collection: string;
  record_id: string;
  base_version: number | null;
  mode: string;
  format: string;
  enc: string;
  size: number;
  sha256: string;
  part_bytes: number | null;
  multipart_id: string | null;
  reserved_bytes: number;
  device_id: string;
  created_at: number;
  expires_at: number;
  state: string;
  result_json: string | null;
}

interface PartRow extends Row {
  upload_id: string;
  n: number;
  etag: string;
  bytes: number;
}

const FILE_COLUMNS = `collection, record_id, version, object_key, format, enc, size, sha256,
  status, ssec_kid, created_at, client_id`;

const toFile = (r: FileRow): StoredFile => ({
  collection: r.collection,
  recordId: r.record_id,
  version: r.version,
  objectKey: r.object_key,
  format: r.format as SyncFileFormat,
  enc: r.enc as SyncFileEnc,
  size: r.size,
  sha256: r.sha256,
  status: r.status as FileStatus,
  ...(r.ssec_kid !== null ? { ssecKid: r.ssec_kid } : {}),
  createdAt: r.created_at,
  clientId: r.client_id,
});

const toUpload = (r: UploadDbRow): UploadRow => ({
  uploadId: r.upload_id,
  collection: r.collection,
  recordId: r.record_id,
  baseVersion:
    r.base_version === null
      ? null
      : r.base_version === CREATE_ONLY
        ? "*"
        : r.base_version,
  mode: r.mode as UploadRow["mode"],
  format: r.format as SyncFileFormat,
  enc: r.enc as SyncFileEnc,
  size: r.size,
  sha256: r.sha256,
  partBytes: r.part_bytes,
  multipartId: r.multipart_id,
  reservedBytes: r.reserved_bytes,
  deviceId: r.device_id,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  state: r.state as UploadState,
  resultJson: r.result_json,
});

/** A BLOB as the runtime returns it (an ArrayBuffer; a Node test double returns a Buffer). */
const toBytes = (v: SqlStorageValue): Uint8Array =>
  v instanceof ArrayBuffer
    ? new Uint8Array(v.slice(0))
    : new Uint8Array(v as unknown as ArrayLike<number>);

export class FileTables {
  constructor(private readonly q: SqlQuery) {}

  get(collection: string, recordId: string, version: number) {
    const r = this.q.all<FileRow>(
      `SELECT ${FILE_COLUMNS} FROM files
         WHERE collection = ? AND record_id = ? AND version = ?`,
      collection,
      recordId,
      version,
    )[0];
    return r ? toFile(r) : undefined;
  }

  live(collection: string, recordId: string): StoredFile | undefined {
    const r = this.q.all<FileRow>(
      `SELECT ${FILE_COLUMNS} FROM files
         WHERE collection = ? AND record_id = ? AND status = 'live'
         ORDER BY version DESC LIMIT 1`,
      collection,
      recordId,
    )[0];
    return r ? toFile(r) : undefined;
  }

  put(f: StoredFile): void {
    this.q.run(
      `INSERT INTO files (${FILE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (collection, record_id, version) DO UPDATE SET
         object_key = excluded.object_key, format = excluded.format, enc = excluded.enc,
         size = excluded.size, sha256 = excluded.sha256, status = excluded.status,
         ssec_kid = excluded.ssec_kid, created_at = excluded.created_at,
         client_id = excluded.client_id`,
      f.collection,
      f.recordId,
      f.version,
      f.objectKey,
      f.format,
      f.enc,
      f.size,
      f.sha256,
      f.status,
      f.ssecKid ?? null,
      f.createdAt,
      f.clientId,
    );
  }

  remove(collection: string, recordId: string, version: number): void {
    this.q.run(
      `DELETE FROM files WHERE collection = ? AND record_id = ? AND version = ?`,
      collection,
      recordId,
      version,
    );
  }

  of(collection: string, recordId: string): StoredFile[] {
    return this.q
      .all<FileRow>(
        `SELECT ${FILE_COLUMNS} FROM files
           WHERE collection = ? AND record_id = ? ORDER BY version`,
        collection,
        recordId,
      )
      .map(toFile);
  }

  all(): StoredFile[] {
    return this.q
      .all<FileRow>(
        `SELECT ${FILE_COLUMNS} FROM files ORDER BY collection, record_id, version`,
      )
      .map(toFile);
  }

  // ---- uploads -------------------------------------------------------------------------------

  upload(uploadId: string): UploadRow | undefined {
    const r = this.q.all<UploadDbRow>(
      `SELECT * FROM uploads WHERE upload_id = ?`,
      uploadId,
    )[0];
    return r ? toUpload(r) : undefined;
  }

  putUpload(u: UploadRow): void {
    this.q.run(
      `INSERT INTO uploads
         (upload_id, collection, record_id, base_version, mode, format, enc, size, sha256,
          part_bytes, multipart_id, reserved_bytes, device_id, created_at, expires_at, state,
          result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (upload_id) DO UPDATE SET
         collection = excluded.collection, record_id = excluded.record_id,
         base_version = excluded.base_version, mode = excluded.mode, format = excluded.format,
         enc = excluded.enc, size = excluded.size, sha256 = excluded.sha256,
         part_bytes = excluded.part_bytes, multipart_id = excluded.multipart_id,
         reserved_bytes = excluded.reserved_bytes, device_id = excluded.device_id,
         created_at = excluded.created_at, expires_at = excluded.expires_at,
         state = excluded.state, result_json = excluded.result_json`,
      u.uploadId,
      u.collection,
      u.recordId,
      u.baseVersion === null
        ? null
        : u.baseVersion === "*"
          ? CREATE_ONLY
          : u.baseVersion,
      u.mode,
      u.format,
      u.enc,
      u.size,
      u.sha256,
      u.partBytes,
      u.multipartId,
      u.reservedBytes,
      u.deviceId,
      u.createdAt,
      u.expiresAt,
      u.state,
      u.resultJson,
    );
  }

  removeUpload(uploadId: string): void {
    this.q.run(`DELETE FROM upload_parts WHERE upload_id = ?`, uploadId);
    this.q.run(`DELETE FROM uploads WHERE upload_id = ?`, uploadId);
  }

  open(nowMs: number): UploadRow[] {
    return this.q
      .all<UploadDbRow>(
        `SELECT * FROM uploads
           WHERE state IN ('open', 'finalizing') AND expires_at > ?
           ORDER BY created_at, upload_id`,
        nowMs,
      )
      .map(toUpload);
  }

  expired(nowMs: number, limit: number): UploadRow[] {
    return this.q
      .all<UploadDbRow>(
        `SELECT * FROM uploads WHERE expires_at <= ?
           ORDER BY expires_at, upload_id LIMIT ?`,
        nowMs,
        limit,
      )
      .map(toUpload);
  }

  parts(uploadId: string): UploadPart[] {
    return this.q
      .all<PartRow>(
        `SELECT upload_id, n, etag, bytes FROM upload_parts WHERE upload_id = ? ORDER BY n`,
        uploadId,
      )
      .map((r) => ({
        uploadId: r.upload_id,
        n: r.n,
        etag: r.etag,
        bytes: r.bytes,
      }));
  }

  putPart(p: UploadPart): void {
    this.q.run(
      `INSERT INTO upload_parts (upload_id, n, etag, bytes) VALUES (?, ?, ?, ?)
       ON CONFLICT (upload_id, n) DO UPDATE SET etag = excluded.etag, bytes = excluded.bytes`,
      p.uploadId,
      p.n,
      p.etag,
      p.bytes,
    );
  }

  // ---- SSE-C keys ----------------------------------------------------------------------------

  ssecKey(kid: string): Uint8Array | undefined {
    const r = this.q.all<{ key: SqlStorageValue } & Row>(
      `SELECT key FROM ssec_keys WHERE kid = ?`,
      kid,
    )[0];
    return r ? toBytes(r.key) : undefined;
  }

  putSsecKey(kid: string, key: Uint8Array): void {
    const copy = new ArrayBuffer(key.byteLength);
    new Uint8Array(copy).set(key);
    this.q.run(
      `INSERT OR REPLACE INTO ssec_keys (kid, key) VALUES (?, ?)`,
      kid,
      copy,
    );
  }

  removeSsecKey(kid: string): void {
    this.q.run(`DELETE FROM ssec_keys WHERE kid = ?`, kid);
  }

  allSsecKeys(): [string, Uint8Array][] {
    return this.q
      .all<
        { kid: string; key: SqlStorageValue } & Row
      >(`SELECT kid, key FROM ssec_keys ORDER BY kid`)
      .map((r): [string, Uint8Array] => [r.kid, toBytes(r.key)]);
  }
}
