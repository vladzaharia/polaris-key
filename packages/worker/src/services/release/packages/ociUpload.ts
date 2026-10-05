/// <reference types="@cloudflare/workers-types" />
/*
 * Portions of this file are adapted from cloudflare/serverless-registry
 * (https://github.com/cloudflare/serverless-registry, `src/registry/r2.ts` and `src/chunk.ts`):
 * the blob upload state machine over R2 multipart uploads, and its rule for fitting a client's
 * chunks to R2's part sizes.
 *
 * Copyright Cloudflare, Inc. and the serverless-registry contributors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file
 * except in compliance with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under the
 * License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
 * either express or implied. See the License for the specific language governing permissions
 * and limitations under the License.
 *
 * Modified for Polaris Key (F-23): the state is one R2 object compared-and-swapped by its etag
 * instead of a JWT, every object lives under the product's own `staging/` prefix, a chunk that
 * does not fit R2's part rule is carried as a "tail" object and re-split (streamed, never
 * buffered) instead of being refused or copied in memory, and the finished object is handed to
 * Core's `landUpload`, which verifies its SHA-256 before anything reaches a locked key.
 */

/**
 * The OCI blob upload (F-23, distribution-spec "Pushing blobs"), as state over R2:
 *
 *   staging/<product>/oci-upload-<uuid>/state      the upload's JSON state (etag-guarded)
 *   staging/<product>/oci-upload-<uuid>/data       the R2 multipart object, once a part exists
 *   staging/<product>/oci-upload-<uuid>/tail-<n>   bytes received but not yet a part
 *
 * R2's multipart rule: every part but the last is the SAME size, at least 5 MiB and at most
 * 5 GiB; the last may be smaller; at most 10,000 parts. A registry client chooses its own chunk
 * sizes (docker sends a whole layer in one `PATCH`, containerd and crane stream, some clients
 * send fixed chunks), and every request is bounded by the zone's body limit (100 MB on Free and
 * Pro). So each `PATCH` appends to a byte sequence `tail + chunk`, cut into parts of the upload's
 * part size (fixed by the first part: the first `tail + chunk` of at least 5 MiB), and whatever
 * is left, always smaller than a part, becomes the new tail. Finishing uploads the tail as the
 * last part (or, with no part at all, the tail IS the object) and completes the multipart upload.
 *
 * Nothing here decides who may upload, or where the bytes land: the routes (`ociPush.ts`) do the
 * first, and Core's `landUpload` the second, after verifying the digest the client claims.
 */

/** R2's smallest part but the last (5 MiB). */
export const MIN_PART_BYTES = 5 * 1024 * 1024;

/** The most bytes one request may carry (the zone's body limit on Free and Pro, 100 MB). */
export const MAX_CHUNK_BYTES = 100 * 1000 * 1000;

/** R2's most parts per multipart upload. */
export const MAX_PARTS = 10_000;

/** How long an upload may sit unfinished before it is unknown (the staging rule is one day). */
export const UPLOAD_TTL_SECONDS = 86_400;

/** An upload id: a v4 UUID, lower case (the `Location` carries it). */
export const UPLOAD_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** One upload's state, stored as JSON. */
export interface UploadState {
  readonly v: 1;
  readonly id: string;
  readonly owner: string;
  readonly repository: string;
  readonly deliverableId: string;
  /** The push token's subject that started it (audit only). */
  readonly sub: string;
  readonly createdAt: number;
  /** Bytes received so far. */
  size: number;
  /** Every part's size but the last, fixed by the first part; `null` before it. */
  partSize: number | null;
  /** The R2 multipart upload's id, once a part exists. */
  multipartId: string | null;
  parts: { partNumber: number; etag: string }[];
  /** Bytes received but not yet a part. */
  tail: { key: string; size: number } | null;
}

/** A state read with the etag a write must match. */
export interface LoadedUpload {
  readonly state: UploadState;
  readonly etag: string;
}

/** A request body of known length. */
export interface Chunk {
  readonly body: ReadableStream<Uint8Array> | Uint8Array;
  readonly length: number;
}

export type UploadRefusal =
  /** The chunk does not start where the upload ends (`416`, with the current range). */
  | "range"
  /** Over the feed's per-blob ceiling. */
  | "too_large"
  /** Over R2's part count. */
  | "too_many_parts"
  /** Another request changed the upload first, or one of its objects is gone. */
  | "changed"
  /** The body carried a different number of bytes than it declared. */
  | "size_invalid";

function prefix(owner: string, id: string): string {
  return `staging/${owner}/oci-upload-${id}`;
}

export function stateKey(owner: string, id: string): string {
  return `${prefix(owner, id)}/state`;
}

function dataKey(s: UploadState): string {
  return `${prefix(s.owner, s.id)}/data`;
}

function tailKey(s: UploadState, parts: number, size: number): string {
  return `${prefix(s.owner, s.id)}/tail-${parts}-${size}`;
}

/** Start an upload: its state, written create-only. */
export async function startUpload(
  bucket: R2Bucket,
  init: Pick<
    UploadState,
    "owner" | "repository" | "deliverableId" | "sub" | "createdAt"
  >,
): Promise<LoadedUpload | null> {
  const state: UploadState = {
    v: 1,
    id: crypto.randomUUID(),
    ...init,
    size: 0,
    partSize: null,
    multipartId: null,
    parts: [],
    tail: null,
  };
  const obj = await bucket.put(
    stateKey(state.owner, state.id),
    JSON.stringify(state),
    { onlyIf: new Headers({ "If-None-Match": "*" }) },
  );
  return obj ? { state, etag: obj.etag } : null;
}

/** One upload of `owner`'s `repository`, or `null` (unknown, expired, another repository's). */
export async function readUpload(
  bucket: R2Bucket,
  owner: string,
  repository: string,
  id: string,
  now: number,
): Promise<LoadedUpload | null> {
  if (!UPLOAD_ID_RE.test(id)) return null;
  const obj = await bucket.get(stateKey(owner, id));
  if (!obj || !("body" in obj)) return null;
  let state: UploadState;
  try {
    state = JSON.parse(await obj.text()) as UploadState;
  } catch {
    return null;
  }
  if (
    state?.v !== 1 ||
    state.id !== id ||
    state.owner !== owner ||
    state.repository !== repository ||
    typeof state.size !== "number" ||
    !Array.isArray(state.parts) ||
    now - state.createdAt > UPLOAD_TTL_SECONDS
  )
    return null;
  return { state, etag: obj.etag };
}

async function writeState(
  bucket: R2Bucket,
  state: UploadState,
  etag: string,
): Promise<LoadedUpload | null> {
  const obj = await bucket.put(
    stateKey(state.owner, state.id),
    JSON.stringify(state),
    { onlyIf: { etagMatches: etag } },
  );
  return obj ? { state, etag: obj.etag } : null;
}

/** Wrap a stream of `n` bytes so R2 knows its length (workerd's `FixedLengthStream`). */
function sized(stream: ReadableStream<Uint8Array>, n: number): ReadableStream {
  const Fixed = (globalThis as { FixedLengthStream?: typeof FixedLengthStream })
    .FixedLengthStream;
  return Fixed ? stream.pipeThrough(new Fixed(n)) : stream;
}

/**
 * Several streams read as one byte sequence, cut into consecutive sub-streams of exact lengths
 * (serverless-registry's `split`, generalised to a sequence of sources). Each `take` must be
 * consumed before the next; a source that ends early errors the sub-stream being read.
 */
class ByteSource {
  private readonly readers: ReadableStreamDefaultReader<Uint8Array>[];
  private index = 0;
  private leftover: Uint8Array | null = null;

  constructor(sources: (ReadableStream<Uint8Array> | Uint8Array)[]) {
    this.readers = sources.map((s) =>
      (s instanceof Uint8Array
        ? new ReadableStream<Uint8Array>({
            start(c) {
              if (s.byteLength) c.enqueue(s);
              c.close();
            },
          })
        : s
      ).getReader(),
    );
  }

  private async next(): Promise<Uint8Array | null> {
    if (this.leftover) {
      const l = this.leftover;
      this.leftover = null;
      return l;
    }
    while (this.index < this.readers.length) {
      const { done, value } = await this.readers[this.index]!.read();
      if (done) {
        this.index++;
        continue;
      }
      const chunk =
        value instanceof Uint8Array
          ? value
          : new Uint8Array(value as ArrayBufferLike);
      if (chunk.byteLength) return chunk;
    }
    return null;
  }

  /** The next `n` bytes, as a stream of known length. */
  take(n: number): ReadableStream {
    let remaining = n;
    const inner = new ReadableStream<Uint8Array>({
      pull: async (c) => {
        if (remaining === 0) {
          c.close();
          return;
        }
        const chunk = await this.next();
        if (chunk === null) {
          c.error(new Error("upload: the body ended early"));
          return;
        }
        if (chunk.byteLength > remaining) {
          this.leftover = chunk.subarray(remaining);
          c.enqueue(chunk.subarray(0, remaining));
          remaining = 0;
        } else {
          c.enqueue(chunk);
          remaining -= chunk.byteLength;
        }
        if (remaining === 0) c.close();
      },
    });
    return sized(inner, n);
  }

  /** Does nothing remain? (Reads at most one more chunk.) */
  async exhausted(): Promise<boolean> {
    const extra = await this.next();
    if (extra === null) return true;
    this.leftover = extra;
    return false;
  }

  async cancel(): Promise<void> {
    for (const r of this.readers.slice(this.index))
      await r.cancel().catch(() => undefined);
  }
}

/**
 * Append one chunk (a `PATCH`, or a `PUT`'s final body): parts of the upload's part size, and a
 * new tail. `start`, when the client sent `Content-Range`, must be where the upload ends. The
 * state is written only if no other request changed it since it was read.
 */
export async function appendChunk(
  bucket: R2Bucket,
  loaded: LoadedUpload,
  chunk: Chunk,
  opts: { ceiling: number; start?: number },
): Promise<LoadedUpload | UploadRefusal> {
  const st: UploadState = {
    ...loaded.state,
    parts: [...loaded.state.parts],
  };
  if (opts.start !== undefined && opts.start !== st.size) return "range";
  if (st.size + chunk.length > opts.ceiling) return "too_large";
  if (chunk.length === 0) return loaded;
  const sources: (ReadableStream<Uint8Array> | Uint8Array)[] = [];
  let total = chunk.length;
  const oldTail = st.tail;
  if (oldTail) {
    const t = await bucket.get(oldTail.key);
    if (!t || !("body" in t) || t.size !== oldTail.size) return "changed";
    sources.push(t.body as ReadableStream<Uint8Array>);
    total += oldTail.size;
  }
  sources.push(chunk.body);
  const src = new ByteSource(sources);
  try {
    let partSize = st.partSize;
    if (partSize === null && total >= MIN_PART_BYTES) partSize = total;
    const full = partSize === null ? 0 : Math.floor(total / partSize);
    // One part is always left for the tail at the finish.
    if (st.parts.length + full > MAX_PARTS - 1) return "too_many_parts";
    if (full > 0) {
      if (st.multipartId === null)
        st.multipartId = (
          await bucket.createMultipartUpload(dataKey(st))
        ).uploadId;
      const mp = bucket.resumeMultipartUpload(dataKey(st), st.multipartId);
      for (let i = 0; i < full; i++) {
        const part = await mp.uploadPart(
          st.parts.length + 1,
          src.take(partSize!),
        );
        st.parts.push({ partNumber: part.partNumber, etag: part.etag });
      }
    }
    const rest = total - full * (partSize ?? 0);
    const newSize = st.size + chunk.length;
    if (rest > 0) {
      const key = tailKey(st, st.parts.length, newSize);
      await bucket.put(key, src.take(rest));
      st.tail = { key, size: rest };
    } else st.tail = null;
    if (!(await src.exhausted())) return "size_invalid";
    st.size = newSize;
    st.partSize = partSize;
  } catch {
    // A body shorter than it declared errors the part or the tail being written.
    return "size_invalid";
  } finally {
    await src.cancel();
  }
  const written = await writeState(bucket, st, loaded.etag);
  if (!written) return "changed";
  if (oldTail && oldTail.key !== st.tail?.key)
    await bucket.delete(oldTail.key).catch(() => undefined);
  return written;
}

/**
 * Finish the upload's bytes: the staged object `landUpload` verifies and copies (the tail when
 * no part exists, else the completed multipart object). The state is left for `discardUpload`.
 */
export async function completeUpload(
  bucket: R2Bucket,
  loaded: LoadedUpload,
): Promise<{ stagingKey: string } | "changed"> {
  const st = loaded.state;
  if (st.parts.length === 0 || st.multipartId === null) {
    if (st.tail) return { stagingKey: st.tail.key };
    // An empty blob: OCI allows it (a zero-length layer or config).
    const key = tailKey(st, 0, 0);
    await bucket.put(key, new Uint8Array(0));
    return { stagingKey: key };
  }
  const mp = bucket.resumeMultipartUpload(dataKey(st), st.multipartId);
  const parts: R2UploadedPart[] = st.parts.map((p) => ({
    partNumber: p.partNumber,
    etag: p.etag,
  }));
  try {
    if (st.tail) {
      const t = await bucket.get(st.tail.key);
      if (!t || !("body" in t) || t.size !== st.tail.size) return "changed";
      parts.push(
        await mp.uploadPart(
          parts.length + 1,
          sized(t.body as ReadableStream<Uint8Array>, st.tail.size),
        ),
      );
    }
    await mp.complete(parts);
  } catch {
    return "changed";
  }
  return { stagingKey: dataKey(st) };
}

/**
 * Forget an upload: abort its multipart upload when one is open and remove its staging objects
 * (its state, tail and data). Best effort: the staging prefix's one-day rule takes anything left.
 * Only ever this upload's own `staging/` objects; nothing under a locked prefix.
 */
export async function discardUpload(
  bucket: R2Bucket,
  state: UploadState,
  opts: { completed?: boolean } = {},
): Promise<void> {
  if (state.multipartId !== null && !opts.completed)
    await bucket
      .resumeMultipartUpload(dataKey(state), state.multipartId)
      .abort()
      .catch(() => undefined);
  const keys = [stateKey(state.owner, state.id), dataKey(state)];
  if (state.tail) keys.push(state.tail.key);
  keys.push(tailKey(state, 0, 0));
  await bucket.delete(keys).catch(() => undefined);
}

/** The `Range` header of an upload's progress (`0-<last byte>`; `0-0` before any byte). */
export function uploadRange(state: UploadState): string {
  return `0-${state.size > 0 ? state.size - 1 : 0}`;
}
