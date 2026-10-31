/// <reference types="@cloudflare/workers-types" />

/**
 * The byte plumbing of the file routes (U-10.6; WIRE-CONTRACT-V5 §13.8, plans/U-10-U-11a-slices.md
 * §2.2): the `Content-Digest` header (RFC 9530) and a body that is hashed as it passes to R2.
 * Nothing here buffers a body: a part is up to 64 MiB and the isolate has 128 MB.
 */

import { base64Decode, hexEncode } from "../../../platform/bytes.js";

/** `sha-256=:<base64>:` among the members of a `Content-Digest` value. */
const SHA256_MEMBER = /(?:^|,)\s*sha-256=:([A-Za-z0-9+/]{43}=):\s*(?=,|$)/;

/**
 * The SHA-256 a `Content-Digest` header carries, as lowercase hex, or null when the header is
 * missing, has no `sha-256` member, or that member does not decode to 32 bytes. Other algorithms
 * in the same header are ignored: only the one the server checks matters.
 */
export function parseContentDigest(value: string | null): string | null {
  if (value === null) return null;
  const m = SHA256_MEMBER.exec(value);
  if (!m) return null;
  let bytes: Uint8Array;
  try {
    bytes = base64Decode(m[1] as string);
  } catch {
    return null;
  }
  return bytes.length === 32 ? hexEncode(bytes) : null;
}

type DigestStreamCtor = new (algorithm: string) => WritableStream<
  ArrayBuffer | ArrayBufferView
> & {
  readonly digest: Promise<ArrayBuffer>;
};

/** A body with a running SHA-256: pass `stream` on to R2, then read `digest`. */
export interface HashedBody {
  stream: ReadableStream<Uint8Array>;
  /** The lowercase hex SHA-256 of every byte that passed; settles when `stream` is fully read. */
  digest: Promise<string>;
}

/**
 * Hashes `body` as it passes through. workerd provides `crypto.DigestStream`; the Node lane
 * installs an equivalent (`test/r2Mock.ts`). There is no in-memory fallback: one that buffered
 * would be the isolate OOM this exists to avoid.
 */
export function hashBody(body: ReadableStream<Uint8Array>): HashedBody {
  const Ctor = (crypto as unknown as { DigestStream?: DigestStreamCtor })
    .DigestStream;
  if (!Ctor) throw new Error("crypto.DigestStream is unavailable");
  const sink = new Ctor("SHA-256");
  const writer = sink.getWriter();
  const tap = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      await writer.write(chunk);
      controller.enqueue(chunk);
    },
    async flush() {
      await writer.close();
    },
    async cancel(reason) {
      await writer.abort(reason).catch(() => undefined);
    },
  });
  return {
    stream: body.pipeThrough(tap),
    digest: sink.digest.then((d) => hexEncode(d)),
  };
}

/**
 * A stream R2 can take as a body of exactly `length` bytes: where the runtime has a
 * `FixedLengthStream` the stream goes through it (R2 needs the length up front, and a short or
 * long body errors instead of being stored); elsewhere it is passed as it is.
 */
export function fixedLength(
  body: ReadableStream<Uint8Array>,
  length: number,
): ReadableStream<Uint8Array> {
  const Fixed = (globalThis as { FixedLengthStream?: typeof FixedLengthStream })
    .FixedLengthStream;
  return Fixed ? body.pipeThrough(new Fixed(length)) : body;
}
