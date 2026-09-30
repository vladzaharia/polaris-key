/// <reference types="@cloudflare/workers-types" />
import { createHash, randomBytes } from "node:crypto";

/**
 * An in-memory R2Bucket fake covering exactly the surface `core/blobs.ts` uses: `head`, `get`
 * with `range` + `onlyIf`, `put` with a `sha256` checksum + `onlyIf`, `delete` and `list`.
 *
 * It mirrors the R2 behaviours the store's invariants depend on:
 *   - a `sha256` put option is checked against the bytes received and a mismatch THROWS (R2
 *     rejects the upload); a matching one is stored as `checksums.sha256`, and an object put
 *     without one has none — which is what drives `verifyStaged`'s streamed fallback;
 *   - a failed `onlyIf` on `put` returns `null` and writes nothing; on `get` it returns the
 *     object's metadata without a body;
 *   - `body` is a stream delivered in small chunks, so a consumer that assumes one chunk fails.
 *
 * The workerd lane (`test-workerd/blobs.test.ts`) runs the same flows against miniflare's R2,
 * which is the check that this fake has not drifted from the real binding.
 */

interface Stored {
  bytes: Uint8Array;
  etag: string;
  uploaded: Date;
  sha256?: ArrayBuffer;
  md5: ArrayBuffer;
  customMetadata: Record<string, string>;
}

const CHUNK = 7_919; // an odd prime, so chunk boundaries never align with anything meaningful

function ab(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}

function toHexOrBuf(v: unknown): Buffer {
  if (typeof v === "string") return Buffer.from(v, "hex");
  if (v instanceof ArrayBuffer) return Buffer.from(v);
  if (ArrayBuffer.isView(v))
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  throw new TypeError("checksum must be hex string or buffer");
}

async function readAll(value: unknown): Promise<Uint8Array> {
  if (value === null || value === undefined) return new Uint8Array(0);
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value))
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
  if (value instanceof ReadableStream) {
    const parts: Uint8Array[] = [];
    const reader = value.getReader();
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      parts.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    }
    return new Uint8Array(Buffer.concat(parts));
  }
  throw new TypeError("unsupported put body");
}

function chunkedStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let pos = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pos >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(pos, pos + CHUNK));
      pos += CHUNK;
    },
  });
}

/** Evaluate an R2 `onlyIf` (object form or conditional Headers) against the current object. */
function conditionHolds(
  current: Stored | undefined,
  onlyIf: R2Conditional | Headers | undefined,
): boolean {
  if (!onlyIf) return true;
  let matches: string | undefined;
  let doesNotMatch: string | undefined;
  if (onlyIf instanceof Headers) {
    matches = onlyIf.get("if-match")?.replace(/"/g, "") ?? undefined;
    doesNotMatch = onlyIf.get("if-none-match")?.replace(/"/g, "") ?? undefined;
  } else {
    matches = onlyIf.etagMatches;
    doesNotMatch = onlyIf.etagDoesNotMatch;
  }
  if (matches !== undefined) {
    if (!current) return false;
    if (matches !== "*" && matches !== current.etag) return false;
  }
  if (doesNotMatch !== undefined && current) {
    if (doesNotMatch === "*" || doesNotMatch === current.etag) return false;
  }
  return true;
}

export class R2Mock {
  private store = new Map<string, Stored>();
  /** Every key a `put` call was ATTEMPTED on, in order (test introspection). */
  readonly putAttempts: string[] = [];

  private meta(key: string, s: Stored, range?: R2Range): R2Object {
    const checksums = {
      ...(s.sha256 ? { sha256: s.sha256 } : {}),
      md5: s.md5,
      toJSON: () => ({
        ...(s.sha256 ? { sha256: Buffer.from(s.sha256).toString("hex") } : {}),
        md5: Buffer.from(s.md5).toString("hex"),
      }),
    } as R2Checksums;
    return {
      key,
      version: s.etag,
      size: s.bytes.length,
      etag: s.etag,
      httpEtag: `"${s.etag}"`,
      checksums,
      uploaded: s.uploaded,
      customMetadata: s.customMetadata,
      storageClass: "Standard",
      ...(range ? { range } : {}),
      writeHttpMetadata: () => undefined,
    } as unknown as R2Object;
  }

  async head(key: string): Promise<R2Object | null> {
    const s = this.store.get(key);
    return s ? this.meta(key, s) : null;
  }

  async get(
    key: string,
    options?: R2GetOptions,
  ): Promise<R2ObjectBody | R2Object | null> {
    const s = this.store.get(key);
    if (!s) return null;
    if (!conditionHolds(s, options?.onlyIf)) return this.meta(key, s);
    let bytes = s.bytes;
    let range: R2Range | undefined;
    if (options?.range) {
      if (options.range instanceof Headers)
        throw new Error("R2Mock: header ranges are not used by core/blobs.ts");
      const r = options.range as {
        offset?: number;
        length?: number;
        suffix?: number;
      };
      if (r.suffix !== undefined) {
        const len = Math.min(r.suffix, bytes.length);
        range = { suffix: r.suffix };
        bytes = bytes.slice(bytes.length - len);
      } else {
        const offset = r.offset ?? 0;
        if (offset > bytes.length)
          throw new Error("R2Mock: range out of bounds");
        const length = r.length ?? bytes.length - offset;
        range = { offset, length };
        bytes = bytes.slice(offset, offset + length);
      }
    }
    const meta = this.meta(key, s, range);
    const body = chunkedStream(bytes);
    return Object.assign(meta, {
      body,
      bodyUsed: false,
      arrayBuffer: async () => bytes.slice().buffer,
      text: async () => new TextDecoder().decode(bytes),
    }) as unknown as R2ObjectBody;
  }

  async put(
    key: string,
    value:
      | ReadableStream
      | ArrayBuffer
      | ArrayBufferView
      | string
      | null
      | Blob,
    options?: R2PutOptions,
  ): Promise<R2Object | null> {
    this.putAttempts.push(key);
    const current = this.store.get(key);
    const bytes = await readAll(value);
    if (!conditionHolds(current, options?.onlyIf)) return null;
    let sha256: ArrayBuffer | undefined;
    if (options?.sha256 !== undefined) {
      const want = toHexOrBuf(options.sha256);
      const got = createHash("sha256").update(bytes).digest();
      if (!got.equals(want))
        throw new Error(
          "put: The SHA-256 checksum you specified did not match what we received.",
        );
      sha256 = ab(got);
    }
    const stored: Stored = {
      bytes,
      etag: randomBytes(16).toString("hex"),
      uploaded: new Date(),
      md5: ab(createHash("md5").update(bytes).digest()),
      customMetadata: options?.customMetadata ?? {},
      ...(sha256 ? { sha256 } : {}),
    };
    this.store.set(key, stored);
    return this.meta(key, stored);
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.store.delete(k);
  }

  async list(options?: R2ListOptions): Promise<R2Objects> {
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1000;
    const all = [...this.store.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort()
      .filter((k) => !options?.cursor || k > options.cursor)
      .filter((k) => !options?.startAfter || k > options.startAfter);
    const page = all.slice(0, limit);
    const objects = page.map((k) => this.meta(k, this.store.get(k)!));
    return all.length > limit
      ? {
          objects,
          delimitedPrefixes: [],
          truncated: true,
          cursor: page.at(-1)!,
        }
      : { objects, delimitedPrefixes: [], truncated: false };
  }

  // ── Test-only seams ──────────────────────────────────────────────────────────────────────

  /** Store bytes directly, as an S3 upload with or without `x-amz-checksum-sha256` would. */
  seed(
    key: string,
    bytes: Uint8Array,
    opts: { withSha256?: boolean } = {},
  ): void {
    const sha = createHash("sha256").update(bytes).digest();
    this.store.set(key, {
      bytes,
      etag: randomBytes(16).toString("hex"),
      uploaded: new Date(),
      md5: ab(createHash("md5").update(bytes).digest()),
      customMetadata: {},
      ...(opts.withSha256 ? { sha256: ab(sha) } : {}),
    });
  }

  /** Replace an object's bytes in place (a racing CI re-upload); keeps any stale checksum
   *  only if `keepChecksum`, to model a lying record. */
  tamper(
    key: string,
    bytes: Uint8Array,
    opts: { keepChecksum?: boolean } = {},
  ): void {
    const s = this.store.get(key);
    if (!s) throw new Error(`R2Mock: no object at ${key}`);
    this.store.set(key, {
      ...s,
      bytes,
      etag: randomBytes(16).toString("hex"),
      ...(opts.keepChecksum ? {} : { sha256: undefined }),
    });
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  keys(): string[] {
    return [...this.store.keys()].sort();
  }
}

export function asR2(mock: R2Mock): R2Bucket {
  return mock as unknown as R2Bucket;
}

/**
 * Install a streaming `crypto.DigestStream` for the Node lane. workerd has one natively; Node
 * does not. This one hashes chunk by chunk with `node:crypto` — it never concatenates — so a
 * test of the streamed fallback exercises the same shape as production.
 */
export function installDigestStream(): void {
  const c = crypto as unknown as Record<string, unknown>;
  if (c.DigestStream) return;
  class NodeDigestStream extends WritableStream<ArrayBuffer | ArrayBufferView> {
    readonly digest: Promise<ArrayBuffer>;
    private readonly counter: { n: number };
    get bytesWritten(): number {
      return this.counter.n;
    }
    constructor(algorithm: string) {
      if (algorithm !== "SHA-256")
        throw new Error("NodeDigestStream: SHA-256 only");
      const hash = createHash("sha256");
      let resolve!: (b: ArrayBuffer) => void;
      let reject!: (e: unknown) => void;
      const digest = new Promise<ArrayBuffer>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const self = { n: 0 };
      super({
        write(chunk) {
          const buf =
            chunk instanceof ArrayBuffer
              ? Buffer.from(chunk)
              : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          self.n += buf.byteLength;
          hash.update(buf);
        },
        close() {
          resolve(ab(hash.digest()));
        },
        abort(reason) {
          reject(reason);
        },
      });
      this.digest = digest;
      this.counter = self;
    }
  }
  Object.defineProperty(c, "DigestStream", {
    value: NodeDigestStream,
    configurable: true,
    writable: true,
  });
}
