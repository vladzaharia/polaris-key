/**
 * Streaming Ed25519 (PureEdDSA, RFC 8032 §5.1.7) verification over a body of any size.
 *
 * WebCrypto's `crypto.subtle.verify` needs the whole message in one buffer, and neither
 * Workers nor Node expose a streaming Ed25519 API. A Sparkle signature covers a whole DMG —
 * GitHub allows 2 GiB per asset — inside a 128 MB isolate, so buffering is an out-of-memory
 * crash, not a catchable error. PureEdDSA's only whole-message step is `SHA-512(R || A || M)`,
 * which streams; everything else is two scalar multiplications on 32-byte inputs.
 *
 * Strictness, chosen so this verifier never accepts anything WebCrypto rejected:
 *   - the public key and `R` must be canonical point encodings (y < p; no x = 0 with the sign
 *     bit set), otherwise the verdict is `false`;
 *   - `S` must be fully reduced (`S < L`), otherwise `false` (the malleability check);
 *   - a small-order public key is refused (a real Sparkle key is never one);
 *   - the equation is the cofactorless `[S]B == R + [k]A`.
 *
 * Memory: the verifier holds the hash state and the chunk the reader handed it, nothing else.
 * The reader is cancelled on every exit path, so an early `false` (bad key, oversized body)
 * stops the download instead of draining it.
 */

import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";

const Point = ed25519.Point;
/** The prime order of the Ed25519 base point, `2^252 + 27742317777372353535851937790883648493`. */
const L = Point.Fn.ORDER;

/** Little-endian bytes → bigint. */
function leToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
  return n;
}

/**
 * The outcome of a streaming verification.
 *
 * - `valid`: the signature verifies over the whole body.
 * - `invalid`: a final, deterministic "no" — a malformed key or signature, `S >= L`, an
 *   undecodable or small-order point, or a body read to its end within the cap that the
 *   signature does not cover. The same inputs over the same bytes always give this answer, so
 *   a caller may memoise it.
 * - `incomplete`: no verdict was reached — the body errored mid-stream or ran past `maxBytes`.
 *   A retry may succeed (or the cap may change), so a caller must not memoise it.
 */
export type Ed25519StreamVerdict = "valid" | "invalid" | "incomplete";

/**
 * Check an Ed25519 `signature` by `publicKey` over the bytes of `body`, reading it chunk by
 * chunk, and say whether the answer is final ({@link Ed25519StreamVerdict}). More than
 * `maxBytes` of body is `incomplete`, enforced while streaming — the caller's `Content-Length`
 * pre-check is only a cheap early refusal. Never throws. `body === null` is an empty message.
 */
export async function streamingEd25519Check(
  publicKey: Uint8Array,
  signature: Uint8Array,
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Ed25519StreamVerdict> {
  const reader = body?.getReader();
  // Set once the whole body has been hashed. After that every step is a pure function of the
  // inputs and the (immutable) bytes, so even a throw is a final `invalid`.
  let complete = false;
  try {
    if (publicKey.length !== 32 || signature.length !== 64) return "invalid";
    const rBytes = signature.subarray(0, 32);
    const s = leToBigInt(signature.subarray(32, 64));
    if (s >= L) return "invalid";

    let A: ReturnType<typeof Point.fromBytes>;
    let R: ReturnType<typeof Point.fromBytes>;
    try {
      A = Point.fromBytes(publicKey, false);
      R = Point.fromBytes(rBytes, false);
    } catch {
      return "invalid";
    }
    if (A.isSmallOrder()) return "invalid";

    const hash = createHash("sha512");
    hash.update(rBytes);
    hash.update(publicKey);
    if (reader) {
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) return "incomplete";
        // Hash the chunk on the spot and drop it: the reader may reuse its buffer.
        hash.update(value);
      }
    }
    complete = true;
    const k = leToBigInt(new Uint8Array(hash.digest())) % L;

    // Variable-time multiplication is fine here: every input is public.
    const lhs = Point.BASE.multiplyUnsafe(s);
    const rhs = R.add(A.multiplyUnsafe(k));
    return lhs.equals(rhs) ? "valid" : "invalid";
  } catch {
    // Before the body is complete this is a body that errored mid-stream: no verdict. After,
    // it is an arithmetic edge noble refuses for these exact inputs: a final no.
    return complete ? "invalid" : "incomplete";
  } finally {
    await reader?.cancel().catch(() => undefined);
  }
}

/**
 * Verify an Ed25519 `signature` by `publicKey` over the bytes of `body`, reading it chunk by
 * chunk. `true` only for {@link streamingEd25519Check}'s `valid`; every failure — wrong
 * lengths, undecodable points, `S >= L`, an oversized body, a body that errors mid-stream, or
 * a signature that does not verify — is `false`, never a throw.
 */
export async function streamingEd25519Verify(
  publicKey: Uint8Array,
  signature: Uint8Array,
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<boolean> {
  return (
    (await streamingEd25519Check(publicKey, signature, body, maxBytes)) ===
    "valid"
  );
}
