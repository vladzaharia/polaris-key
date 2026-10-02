/// <reference types="@cloudflare/workers-types" />

/**
 * Server-side Sparkle EdDSA verification (R6-03).
 *
 * The appcast's `sparkle:edSignature` used to be relayed verbatim from a sibling `<dmg>.sig`
 * release asset, with `release_config.sparkle_ed25519_pub` consulted only as a truthiness
 * flag — so the platform advertised "signed appcasts fail closed" while checking nothing but
 * the sidecar's *existence*. Here we actually import the configured public key and verify the
 * sidecar signature over the DMG bytes before the item is allowed into the feed.
 *
 * Verification streams the DMG from GitHub through an incremental SHA-512 (P0-10,
 * `ed25519Stream.ts`), so an artifact of any size GitHub allows is verifiable without holding
 * it in memory. It is still a full download, so a final verdict — positive or negative — is
 * memoised in KV keyed by (product, asset id, signature, public key). Any change to any of
 * those inputs is a different key — a swapped asset or a swapped key can never reuse an old
 * verdict. The negative memo matters as much as the positive one: the appcast is an
 * unauthenticated surface and a 404 is not edge-cached, so without it every cache-missing
 * request for a release whose signature fails would re-download and re-hash the whole DMG.
 */

import { kvKey, type Env } from "../../core/platform.js";
import type { FetchImpl } from "./githubApp.js";
import {
  ed25519SignaturePrecheck,
  streamingEd25519Check,
} from "./ed25519Stream.js";
import { fetchAssetStream, NotFoundError } from "./github.js";

/**
 * Verified verdicts are cached for 30 days. The key covers every input, and GitHub gives a
 * re-uploaded asset a new id, so a verdict cannot go stale; the TTL only bounds KV growth and
 * how often a DMG is downloaded again to re-verify it.
 */
export const VERIFY_CACHE_TTL_SECONDS = 30 * 86_400;
/**
 * Final negative verdicts are cached for a day. A negative is as permanent as a positive for
 * the same key (the bytes are immutable per asset id), so this only needs to be long enough
 * that a failing release costs one DMG download a day rather than one per request; it is kept
 * short so an operator fixing the key or sidecar sees nothing surprising if a verdict was ever
 * wrong.
 */
export const NEGATIVE_VERIFY_CACHE_TTL_SECONDS = 86_400;
/**
 * GitHub's per-asset maximum (2 GiB). Verification streams, so the cap bounds download time,
 * not memory; it is enforced while streaming, whatever the `Content-Length` says.
 */
export const MAX_VERIFY_BYTES = 2 * 1024 * 1024 * 1024;

/** Decode base64 (accepting the base64url alphabet) to bytes; `null` on malformed input. */
function decodeBase64(value: string): Uint8Array | null {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;
  try {
    const bin = atob(normalized);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function cacheKey(
  product: string,
  /** What names the signed bytes immutably: a GitHub asset id, or `sha256:<hex>` (P3-09). */
  subject: number | string,
  signature: string,
  publicKey: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${subject}\u0000${signature}\u0000${publicKey}`),
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return kvKey(product, "sparkle-sig", hex);
}

/** A memo write that never throws (synchronously or not): a KV failure only loses the memo. */
async function memoPut(
  env: Env,
  key: string,
  value: string,
  ttl: number,
): Promise<void> {
  try {
    await env.HOT.put(key, value, { expirationTtl: ttl });
  } catch {
    // The verdict stands; the next request verifies again.
  }
}

export interface SparkleVerifyInput {
  token: string;
  owner: string;
  repo: string;
  /** Release-asset id of the DMG the signature covers. */
  assetId: number;
  /** Base64 EdDSA signature read from the sibling `<dmg>.sig` asset. */
  signature: string;
  /** `release_config.sparkle_ed25519_pub` — the raw 32-byte key, base64. */
  publicKey: string;
  fetchImpl: FetchImpl;
  /** Byte cap on the DMG body; defaults to {@link MAX_VERIFY_BYTES}. A test seam. */
  maxBytes?: number;
  /**
   * The DMG's listed size (the release listing's `size`). A body of any other length is
   * `incomplete` and never memoised, so a truncated clean EOF or a wrong-but-2xx body cannot pin
   * a negative verdict for a day and drop a security update from the appcast.
   */
  expectedSize?: number;
  /**
   * The runtime's `waitUntil` (a stopgap until verification moves to publish time): the stream
   * tail and the memo write finish under it, so a client that aborts mid-stream no longer
   * prevents the verdict from being memoised (R10-dos addendum).
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Verify a Sparkle EdDSA signature over a DMG's bytes against the configured public key.
 * Returns `false` (never throws) for every failure mode — malformed key, malformed
 * signature, unfetchable/oversized asset, or a signature that simply does not verify — so
 * callers can fail closed uniformly.
 */
export async function verifySparkleSignature(
  env: Env,
  product: string,
  input: SparkleVerifyInput,
): Promise<boolean> {
  const maxBytes = input.maxBytes ?? MAX_VERIFY_BYTES;
  return verifyEd25519OverBytes(env, product, {
    subject: input.assetId,
    signature: input.signature,
    publicKey: input.publicKey,
    maxBytes,
    ...(input.expectedSize !== undefined
      ? { expectedSize: input.expectedSize }
      : {}),
    ...(input.waitUntil ? { waitUntil: input.waitUntil } : {}),
    open: async () => {
      try {
        return await fetchAssetStream(
          input.token,
          input.owner,
          input.repo,
          input.assetId,
          maxBytes,
          input.fetchImpl,
        );
      } catch (err) {
        if (err instanceof NotFoundError) return null;
        throw err;
      }
    },
  });
}

/** What `verifyEd25519OverBytes` checks: a signature, a key, and a way to open the bytes. */
export interface Ed25519BytesInput {
  /**
   * What names the signed bytes IMMUTABLY, so a memoised verdict can never outlive them: a GitHub
   * asset id (GitHub gives a re-upload a new id), or `sha256:<hex>` for a content-addressed
   * artifact whose stream is checked against that digest by `open`'s caller (P3-09).
   */
  subject: number | string;
  /** Base64 EdDSA signature. */
  signature: string;
  /** The raw 32-byte public key, base64. */
  publicKey: string;
  /** Opens the signed bytes; `null` = not there (a final no, never memoised). */
  open: () => Promise<ReadableStream<Uint8Array> | null>;
  maxBytes?: number;
  /** The listed length; a body of any other length is no verdict (never memoised). */
  expectedSize?: number;
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * The verifier behind `verifySparkleSignature`, over any byte source: precheck, KV memo, then a
 * streaming check whose final verdicts are memoised (positive 30 days, negative a day). P3-09's
 * WinSparkle appcast and extended Sparkle appcast verify CI's `.sig` sidecars with it, over the
 * payload's stored bytes (R2 or GitHub). `false` for every failure; never throws for a bad input.
 */
export async function verifyEd25519OverBytes(
  env: Env,
  product: string,
  input: Ed25519BytesInput,
): Promise<boolean> {
  const { subject, signature, publicKey } = input;
  const keyBytes = decodeBase64(publicKey);
  const sigBytes = decodeBase64(signature);
  if (!keyBytes || keyBytes.length !== 32) return false;
  if (!sigBytes || sigBytes.length !== 64) return false;

  // S >= L, an undecodable or small-order key or R: a final no that needs no bytes, so no
  // download is opened for it.
  if (!ed25519SignaturePrecheck(keyBytes, sigBytes)) return false;

  const key = await cacheKey(product, subject, signature, publicKey);
  const memo = await env.HOT.get(key);
  if (memo === "1") return true;
  if (memo === "0") return false;

  const maxBytes = input.maxBytes ?? MAX_VERIFY_BYTES;
  const body = await input.open();
  if (body === null) return false;

  const work = (async () => {
    const verdict = await streamingEd25519Check(
      keyBytes,
      sigBytes,
      body,
      maxBytes,
      input.expectedSize,
    );
    // Only a final verdict is memoised: an `incomplete` (mid-stream failure, body past the cap
    // or of the wrong length) says nothing about the bytes, and the next request must be free to
    // try again. A failing memo write never turns a completed verification into an error: the
    // verifier's contract is that it never throws.
    if (verdict === "valid") {
      await memoPut(env, key, "1", VERIFY_CACHE_TTL_SECONDS);
    } else if (verdict === "invalid") {
      await memoPut(env, key, "0", NEGATIVE_VERIFY_CACHE_TTL_SECONDS);
    }
    return verdict;
  })();
  input.waitUntil?.(work.catch(() => undefined));
  return (await work) === "valid";
}
