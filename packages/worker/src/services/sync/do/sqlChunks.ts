/**
 * The chunk tables of the Durable Object's SQLite store (U-37.1; schema v5): `chunks`,
 * `file_chunks` and `upload_chunks`. Like `sqlFiles.ts`, this file only reads and writes rows
 * through the two query functions it is handed, so every statement stays parameterised and metered
 * in one place. The rules (reference counts, pins, the quota) are `engine/chunks.ts`'s.
 *
 * `chunks` has one row per (collection, chunk id): chunks are deduplicated per person and per
 * collection. `file_chunks` is which chunks a stored file version names. `upload_chunks` is what an
 * open upload planned: while a row exists the chunk is pinned against the collector.
 */

import type {
  FileChunkRef,
  StoredChunk,
  UploadChunk,
} from "../engine/types.js";
import type { Row, SqlQuery } from "./sqlRecords.js";

interface ChunkDbRow extends Row {
  collection: string;
  chunk_id: string;
  object_key: string;
  stored_bytes: number;
  refs: number;
  unref_at: number;
  ssec_kid: string | null;
}

interface UploadChunkDbRow extends Row {
  upload_id: string;
  chunk_id: string;
  stored_bytes: number;
  have: number;
  reserved: number;
}

const CHUNK_COLUMNS =
  "collection, chunk_id, object_key, stored_bytes, refs, unref_at, ssec_kid";

const toChunk = (r: ChunkDbRow): StoredChunk => ({
  collection: r.collection,
  chunkId: r.chunk_id,
  objectKey: r.object_key,
  storedBytes: r.stored_bytes,
  refs: r.refs,
  unrefAt: r.unref_at,
  ...(r.ssec_kid !== null ? { ssecKid: r.ssec_kid } : {}),
});

const toUploadChunk = (r: UploadChunkDbRow): UploadChunk => ({
  uploadId: r.upload_id,
  chunkId: r.chunk_id,
  storedBytes: r.stored_bytes,
  have: r.have === 1,
  reserved: r.reserved,
});

export class ChunkTables {
  constructor(private readonly q: SqlQuery) {}

  get(collection: string, chunkId: string): StoredChunk | undefined {
    const r = this.q.all<ChunkDbRow>(
      `SELECT ${CHUNK_COLUMNS} FROM chunks WHERE collection = ? AND chunk_id = ?`,
      collection,
      chunkId,
    )[0];
    return r ? toChunk(r) : undefined;
  }

  put(c: StoredChunk): void {
    this.q.run(
      `INSERT INTO chunks (${CHUNK_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (collection, chunk_id) DO UPDATE SET
         object_key = excluded.object_key, stored_bytes = excluded.stored_bytes,
         refs = excluded.refs, unref_at = excluded.unref_at, ssec_kid = excluded.ssec_kid`,
      c.collection,
      c.chunkId,
      c.objectKey,
      c.storedBytes,
      c.refs,
      c.unrefAt,
      c.ssecKid ?? null,
    );
  }

  remove(collection: string, chunkId: string): void {
    this.q.run(
      `DELETE FROM chunks WHERE collection = ? AND chunk_id = ?`,
      collection,
      chunkId,
    );
  }

  all(): StoredChunk[] {
    return this.q
      .all<ChunkDbRow>(
        `SELECT ${CHUNK_COLUMNS} FROM chunks ORDER BY collection, chunk_id`,
      )
      .map(toChunk);
  }

  unreferenced(limit: number): StoredChunk[] {
    return this.q
      .all<ChunkDbRow>(
        `SELECT ${CHUNK_COLUMNS} FROM chunks WHERE refs = 0
           ORDER BY unref_at, collection, chunk_id LIMIT ?`,
        limit,
      )
      .map(toChunk);
  }

  pinned(collection: string, chunkId: string): boolean {
    return (
      this.q.all(
        `SELECT 1 AS x FROM upload_chunks uc
           JOIN uploads u ON u.upload_id = uc.upload_id
          WHERE uc.chunk_id = ? AND u.collection = ? LIMIT 1`,
        chunkId,
        collection,
      ).length > 0
    );
  }

  // ---- file_chunks ---------------------------------------------------------------------------

  fileChunkIds(
    collection: string,
    recordId: string,
    version: number,
  ): string[] {
    return this.q
      .all<{ chunk_id: string } & Row>(
        `SELECT chunk_id FROM file_chunks
           WHERE collection = ? AND record_id = ? AND version = ? ORDER BY chunk_id`,
        collection,
        recordId,
        version,
      )
      .map((r) => r.chunk_id);
  }

  putFileChunks(
    collection: string,
    recordId: string,
    version: number,
    chunkIds: readonly string[],
  ): void {
    for (const id of chunkIds)
      this.q.run(
        `INSERT OR IGNORE INTO file_chunks (collection, record_id, version, chunk_id)
         VALUES (?, ?, ?, ?)`,
        collection,
        recordId,
        version,
        id,
      );
  }

  removeFileChunks(
    collection: string,
    recordId: string,
    version: number,
  ): void {
    this.q.run(
      `DELETE FROM file_chunks WHERE collection = ? AND record_id = ? AND version = ?`,
      collection,
      recordId,
      version,
    );
  }

  allFileChunks(): FileChunkRef[] {
    return this.q
      .all<
        { collection: string; record_id: string; version: number } & {
          chunk_id: string;
        } & Row
      >(
        `SELECT collection, record_id, version, chunk_id FROM file_chunks
           ORDER BY collection, record_id, version, chunk_id`,
      )
      .map((r) => ({
        collection: r.collection,
        recordId: r.record_id,
        version: r.version,
        chunkId: r.chunk_id,
      }));
  }

  // ---- upload_chunks -------------------------------------------------------------------------

  uploadChunk(uploadId: string, chunkId: string): UploadChunk | undefined {
    const r = this.q.all<UploadChunkDbRow>(
      `SELECT upload_id, chunk_id, stored_bytes, have, reserved FROM upload_chunks
         WHERE upload_id = ? AND chunk_id = ?`,
      uploadId,
      chunkId,
    )[0];
    return r ? toUploadChunk(r) : undefined;
  }

  putUploadChunk(c: UploadChunk): void {
    this.q.run(
      `INSERT INTO upload_chunks (upload_id, chunk_id, stored_bytes, have, reserved)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (upload_id, chunk_id) DO UPDATE SET
         stored_bytes = excluded.stored_bytes, have = excluded.have, reserved = excluded.reserved`,
      c.uploadId,
      c.chunkId,
      c.storedBytes,
      c.have ? 1 : 0,
      c.reserved,
    );
  }

  uploadChunks(uploadId: string): UploadChunk[] {
    return this.q
      .all<UploadChunkDbRow>(
        `SELECT upload_id, chunk_id, stored_bytes, have, reserved FROM upload_chunks
           WHERE upload_id = ? ORDER BY chunk_id`,
        uploadId,
      )
      .map(toUploadChunk);
  }

  removeUploadChunks(uploadId: string): void {
    this.q.run(`DELETE FROM upload_chunks WHERE upload_id = ?`, uploadId);
  }
}
