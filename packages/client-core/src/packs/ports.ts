// The ports every pack function takes (plans/P4-01.md §2.13; P4-06). client-core does no I/O:
// SHA-256 beyond WebCrypto's one-shot digest, zstd, byte storage and the network are the host's,
// injected through these interfaces, so the same appliers, planner and pipeline run in Node, in
// a browser and under the corpus runner (which injects in-memory ports). Byte sources and sinks
// are positional (`read(offset, length)`, `write(offset, bytes)`), so a payload is streamed
// through them rather than held whole.

/** A readable run of bytes of a known length: a staged object, an installed file, a range of an
 *  installed payload. `read` returns exactly `length` bytes (or fewer only at the end). */
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** A positional writer: a container payload being rebuilt, a staged object being downloaded. */
export interface ByteSink {
  write(offset: number, bytes: Uint8Array): Promise<void>;
}

/** Where a tree payload's files go while it is staged. Paths have passed `checkPaths`. */
export interface TreeSink {
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
}

/** An incremental SHA-256 (`node:crypto`, `hash-wasm`, CryptoKit, …). */
export interface Sha256Hasher {
  update(bytes: Uint8Array): void;
  /** The lowercase hex digest. The hasher is spent afterwards. */
  digest(): string | Promise<string>;
}

/** Creates a fresh hasher per digest. */
export type Sha256Port = () => Sha256Hasher;

/**
 * The zstd decoder (plans/P4-01.md §2.7 rules 1–3). `decode` takes one frame with its content
 * size; `decodeWithPrefix` one `zstd --patch-from` frame over the whole base as a raw-content
 * prefix. Either may throw: every failure is the applier's verdict, never an exception. The
 * appliers run the window check themselves before `decodeWithPrefix` (§2.7 rule 3), with
 * `pointerBits` as P: 31 for a 64-bit decoder, 30 for a 32-bit or wasm32 one.
 */
export interface ZstdPort {
  readonly pointerBits: 30 | 31;
  decode(frame: Uint8Array, size: number): Uint8Array | Promise<Uint8Array>;
  decodeWithPrefix(
    frame: Uint8Array,
    prefix: Uint8Array,
    size: number,
    windowLogMax: number,
  ): Uint8Array | Promise<Uint8Array>;
  /**
   * Optional streaming decode of one plain frame, whose output arrives in order through
   * `onChunk` and must total `size` bytes. When present, `applyFull` streams the whole payload
   * through it instead of decoding it in one buffer (Node's `node:zlib`).
   */
  decodeStream?(
    frame: ByteSource,
    size: number,
    onChunk: (bytes: Uint8Array) => Promise<void>,
  ): Promise<void>;
}

/** A stored object by the SHA-256 of its stored bytes, or null when the host has none. The
 *  applier checks the length and the hash against the ref before it decodes a byte. */
export type ObjectPort = (sha256: string) => Promise<ByteSource | null>;

/** One installed file, reachable by its SHA-256 (a file of an installed tree, or a range of an
 *  installed container payload). */
export interface InstalledFile {
  path: string;
  sha256: string;
  size: number;
  source: ByteSource;
}

// ── Helpers over the ports ─────────────────────────────────────────────────────────────────

/** The chunk size every helper reads in: 1 MiB. */
export const READ_CHUNK = 1 << 20;

/** A source over bytes already in memory. */
export function memorySource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.byteLength,
    read: (offset, length) =>
      Promise.resolve(
        bytes.subarray(
          Math.min(offset, bytes.byteLength),
          Math.min(offset + length, bytes.byteLength),
        ),
      ),
  };
}

/** A source over a range of another source. */
export function sliceSource(
  source: ByteSource,
  offset: number,
  size: number,
): ByteSource {
  return {
    size,
    read: (at, length) =>
      source.read(offset + at, Math.max(0, Math.min(length, size - at))),
  };
}

/** Every byte of a source, in one buffer. Only for objects the caller has bounded. */
export async function readAll(source: ByteSource): Promise<Uint8Array> {
  const out = new Uint8Array(source.size);
  for (let at = 0; at < source.size; ) {
    const chunk = await source.read(at, Math.min(READ_CHUNK, source.size - at));
    if (chunk.byteLength === 0) break;
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * The default `Sha256Port`: WebCrypto's one-shot digest over the buffered input. WebCrypto does
 * not stream, so this holds every byte it is fed until `digest`; hosts inject a streaming
 * hasher (`node:crypto`, `hash-wasm`) for anything large.
 */
export const webCryptoSha256: Sha256Port = () => {
  const parts: Uint8Array[] = [];
  let total = 0;
  return {
    update(bytes) {
      parts.push(bytes.slice());
      total += bytes.byteLength;
    },
    async digest() {
      const all = new Uint8Array(total);
      let at = 0;
      for (const p of parts) {
        all.set(p, at);
        at += p.byteLength;
      }
      return hex(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", all.buffer as ArrayBuffer),
        ),
      );
    },
  };
};

/** The SHA-256 of bytes in memory, through a port. */
export async function sha256Of(
  sha256: Sha256Port,
  bytes: Uint8Array,
): Promise<string> {
  const h = sha256();
  h.update(bytes);
  return h.digest();
}

/** The SHA-256 of a whole source, read in chunks, through a port. */
export async function hashSource(
  sha256: Sha256Port,
  source: ByteSource,
): Promise<string> {
  const h = sha256();
  for (let at = 0; at < source.size; ) {
    const chunk = await source.read(at, Math.min(READ_CHUNK, source.size - at));
    if (chunk.byteLength === 0) break;
    h.update(chunk);
    at += chunk.byteLength;
  }
  return h.digest();
}
