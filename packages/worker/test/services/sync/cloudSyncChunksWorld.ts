/**
 * Harness for the delta-file routes (U-37.2 on): the file routes' world (`cloudSyncFilesWorld.ts`)
 * plus helpers for chunk objects. The server never reads a chunk, so the tests use the SHA-256 of
 * the plain bytes as the id (server mode) and a stored object of `0x00 0x00 ‖ plain`.
 */
import { createHash } from "node:crypto";
import type {
  BeginFileResponse,
  ChunkPlanResponse,
  FinalizeResponse,
} from "@polaris-key/protocol/sync";
import { expect } from "vitest";
import {
  begin,
  beginBody,
  bytesOf,
  call,
  digestHeader,
  filesPath,
  finalize,
  putBytes,
  SLUG,
  sha256Hex,
  uploadPath,
  type FilesWorld,
} from "./cloudSyncFilesWorld.js";

export const MIB = 1024 * 1024;

/** A manifest stand-in: the server stores it unread, so any bytes of a plausible length do. */
export const manifestOf = (seed = 1, n = 160): Uint8Array => bytesOf(n, seed);

export interface TestChunk {
  /** The id: the SHA-256 of the plain bytes (server mode). */
  id: string;
  /** The stored object: `0x00 ‖ codec 0 ‖ plain`. */
  object: Uint8Array;
}

/** A server-mode chunk of `plainLen` bytes from `seed`. */
export function chunkOf(seed: number, plainLen = 1000): TestChunk {
  const plain = bytesOf(plainLen, seed);
  const object = new Uint8Array(plain.length + 2);
  object.set(plain, 2);
  return { id: sha256Hex(plain), object };
}

/** `begin` for a `chunks` file whose stored manifest is `manifest`. */
export async function beginChunks(
  w: FilesWorld,
  collection: string,
  recordId: string,
  manifest: Uint8Array,
  over: Record<string, unknown> = {},
): Promise<BeginFileResponse> {
  const res = await begin(
    w,
    collection,
    recordId,
    beginBody(manifest, { format: "chunks", ...over }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as BeginFileResponse;
}

export const planPath = (c: string, id: string, uploadId: string) =>
  `${uploadPath(c, id, uploadId)}/chunks`;

export const chunkPath = (
  c: string,
  id: string,
  uploadId: string,
  chunkId: string,
) => `${planPath(c, id, uploadId)}/${chunkId}`;

/** The plan call. */
export const plan = (
  w: FilesWorld,
  c: string,
  id: string,
  uploadId: string,
  chunks: [string, number][],
): Promise<Response> =>
  call(w, "POST", planPath(c, id, uploadId), { json: { chunks } });

/** The plan call for chunk objects, answered as JSON. */
export async function planned(
  w: FilesWorld,
  c: string,
  id: string,
  uploadId: string,
  chunks: TestChunk[],
): Promise<ChunkPlanResponse> {
  const res = await plan(
    w,
    c,
    id,
    uploadId,
    chunks.map((k) => [k.id, k.object.length]),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as ChunkPlanResponse;
}

/** `PUT` of one chunk object with the headers an honest client sends. */
export const putChunk = (
  w: FilesWorld,
  c: string,
  id: string,
  uploadId: string,
  chunk: TestChunk,
  over: Record<string, string | undefined> = {},
): Promise<Response> =>
  putBytes(w, chunkPath(c, id, uploadId, chunk.id), chunk.object, over);

/** The manifest's `PUT`, to the single route. */
export const putManifest = (
  w: FilesWorld,
  c: string,
  id: string,
  uploadId: string,
  manifest: Uint8Array,
): Promise<Response> => putBytes(w, uploadPath(c, id, uploadId), manifest);

/**
 * A complete chunked write through the routes: begin, plan, put what is missing, the manifest,
 * finalize. Returns the upload id and the `finalize` answer.
 */
export async function writeChunked(
  w: FilesWorld,
  c: string,
  id: string,
  manifest: Uint8Array,
  chunks: TestChunk[],
  over: Record<string, unknown> = {},
): Promise<{ uploadId: string; done: FinalizeResponse }> {
  const up = await beginChunks(w, c, id, manifest, over);
  const lists = await planned(w, c, id, up.uploadId, chunks);
  for (const k of chunks)
    if (lists.missing.includes(k.id))
      expect((await putChunk(w, c, id, up.uploadId, k)).status).toBe(204);
  expect((await putManifest(w, c, id, up.uploadId, manifest)).status).toBe(204);
  const res = await finalize(w, c, id, up.uploadId);
  expect(res.status).toBe(200);
  return {
    uploadId: up.uploadId,
    done: (await res.json()) as FinalizeResponse,
  };
}

/** Runs SQL on the person's object (the test's, never a request's). */
export function exec(w: FilesWorld, sql: string): void {
  const inst = w.ns.instances.get(`${SLUG}:${w.subject}`);
  if (!inst) throw new Error("no object");
  (inst.storage.sql.db as unknown as { exec(q: string): void }).exec(sql);
}

export { call, digestHeader, filesPath };
export const hashOf = (b: Uint8Array): string =>
  createHash("sha256").update(b).digest("hex");
