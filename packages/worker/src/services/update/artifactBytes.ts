/// <reference types="@cloudflare/workers-types" />

/**
 * Reading a release artifact's stored bytes for the app-updater feeds (P3-09).
 *
 * The Worker never signs an updater payload and never trusts a value it did not check. Three
 * feeds need facts the release record does not carry, and each is derived from the bytes the
 * record pins, never passed through:
 *
 *   - Sparkle / WinSparkle `sparkle:edSignature`: CI's `<file>.sig` sidecar (the CLI uploads it
 *     as a `signature` artifact). Its few bytes are read and checked against the sidecar's own
 *     recorded SHA-256, then the signature is VERIFIED over the payload with P0-10's streaming
 *     verifier (`verifyEd25519OverBytes`), whose final verdicts are memoised in KV — so a release
 *     costs one streamed read of its payload, not one per feed request.
 *   - Velopack `SHA1`: computed with a streaming digest over the payload while the same pass
 *     checks the payload's recorded SHA-256 and size, and memoised by that SHA-256 (the bytes it
 *     names cannot change).
 *   - AppImage `.zsync`: the control file's bytes (a few MB at most), checked against its
 *     recorded SHA-256 before its `URL:` header is rewritten.
 *
 * Nothing is buffered beyond a small sidecar or control file: payloads stream through a hash.
 *
 * Locations, in README §3.5's order: R2 (the content address of THIS artifact's SHA-256, a
 * non-gated key this product holds a ref to — the byte route's own rule), then GitHub through
 * Release's `openSource` (behind its installation token and SSRF guard). An external URL is not
 * read here: the Worker does not fetch arbitrary hosts on a public route's behalf.
 */

import { createHash } from "node:crypto";
import type {
  CatalogSourceArtifact,
  ReleaseCatalog,
} from "../../core/hooks.js";
import { pk as kvKey } from "../../platform/kv.js";
import { sha256Hex } from "../../platform/hash.js";
import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { hasRef, parseKey } from "../../core/assets/blobs.js";
import { verifyEd25519OverBytes } from "../release/sparkle.js";

export interface ArtifactReadContext {
  env: Env;
  db: Db;
  product: string;
  catalog: ReleaseCatalog;
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** The largest sidecar signature read (a base64 Ed25519 signature is 88 bytes). */
export const MAX_SIGNATURE_BYTES = 1024;
/** The largest `.zsync` control file read (a 2 GiB AppImage at 2 KiB blocks is ~7 MiB). */
export const MAX_ZSYNC_BYTES = 16 * 1024 * 1024;
/** A computed SHA-1 is kept a year: it is a pure function of the bytes its key's SHA-256 names. */
const SHA1_MEMO_TTL_SECONDS = 365 * 86_400;
/** A payload whose bytes are not its recorded SHA-256 is not re-read for a day. */
const SHA1_NEGATIVE_TTL_SECONDS = 86_400;

const LOCATION_RANK: Record<string, number> = { r2: 0, github: 1 };

/**
 * Open one artifact's stored bytes, or `null` when no readable location has them. The stream is
 * the WHOLE file (no Range).
 */
export async function openArtifact(
  ctx: ArtifactReadContext,
  artifact: CatalogSourceArtifact,
): Promise<ReadableStream<Uint8Array> | null> {
  const locations = [...artifact.locations]
    .filter((l) => l.provider in LOCATION_RANK)
    .sort((a, b) => LOCATION_RANK[a.provider]! - LOCATION_RANK[b.provider]!);
  for (const loc of locations) {
    if (loc.provider === "r2") {
      if (!ctx.env.BLOBS || !artifact.sha256 || !loc.key) continue;
      const parsed = parseKey(loc.key);
      if (
        !parsed ||
        parsed.area !== "locked" ||
        parsed.kind !== "blob" ||
        parsed.gated ||
        parsed.sha256 !== artifact.sha256
      )
        continue;
      if (!(await hasRef(ctx.db, ctx.product, loc.key))) continue;
      const obj = await ctx.env.BLOBS.get(loc.key);
      if (obj && "body" in obj && obj.body)
        return obj.body as ReadableStream<Uint8Array>;
      continue;
    }
    if (loc.provider === "github") {
      const res = await ctx.catalog
        .openSource(
          {
            kind: "github",
            releaseId: artifact.releaseId,
            artifactId: artifact.artifactId,
            ...(loc.asset !== undefined ? { asset: loc.asset } : {}),
            redirect: false,
          },
          new Request("https://update.internal/artifact", { method: "GET" }),
        )
        .catch(() => null);
      if (res && res.status === 200 && res.body)
        return res.body as ReadableStream<Uint8Array>;
      await res?.body?.cancel().catch(() => undefined);
    }
  }
  return null;
}

/**
 * The stream, checked against the artifact's recorded SHA-256 and size as it passes: a body that
 * is not those bytes ERRORS at its end instead of ending cleanly, so a streaming verifier reads it
 * as "no verdict" rather than a verdict about the wrong bytes.
 */
function pinned(
  body: ReadableStream<Uint8Array>,
  sha256: string,
  size: number | null,
): ReadableStream<Uint8Array> {
  const h = createHash("sha256");
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        h.update(chunk);
        total += chunk.byteLength;
        controller.enqueue(chunk);
      },
      flush(controller) {
        if (h.digest("hex") !== sha256 || (size !== null && total !== size))
          controller.error(new Error("artifact bytes do not match the record"));
      },
    }),
  );
}

/**
 * Read a small artifact whole (a signature sidecar, a `.zsync` file), or `null` when it is
 * larger than `maxBytes`, unreadable, or not the bytes its record pins.
 */
export async function readSmallArtifact(
  ctx: ArtifactReadContext,
  artifact: CatalogSourceArtifact,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (
    !artifact.sha256 ||
    artifact.sizeBytes === null ||
    artifact.sizeBytes > maxBytes
  )
    return null;
  const body = await openArtifact(ctx, artifact);
  if (!body) return null;
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) return null;
      parts.push(value.slice());
    }
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return (await sha256Hex(out)) === artifact.sha256 &&
    total === artifact.sizeBytes
    ? out
    : null;
}

/**
 * The verified Sparkle EdDSA signature of `target` (a payload or a delta): CI's sidecar
 * `<target name>.sig` among `siblings`, read and checked, then verified over `target`'s bytes
 * against `publicKey`. `null` when there is no sidecar, no key, or it does not verify.
 */
export async function verifiedSidecarSignature(
  ctx: ArtifactReadContext,
  target: CatalogSourceArtifact,
  siblings: readonly CatalogSourceArtifact[],
  publicKey: string | null,
): Promise<string | null> {
  if (!publicKey || !target.sha256) return null;
  // The descriptor-named sidecar of the same build only (the CI-signed record covers it); a
  // release-level `.sig` the GitHub sync picked up is not consulted. Verification below would
  // refuse a forged one anyway; this keeps the lookup to recorded files.
  const sidecar = siblings.find(
    (a) =>
      a.name === `${target.name}.sig` &&
      a.buildId !== null &&
      a.buildId === target.buildId &&
      a.role === "signature",
  );
  if (!sidecar) return null;
  const bytes = await readSmallArtifact(ctx, sidecar, MAX_SIGNATURE_BYTES);
  if (!bytes) return null;
  const signature = new TextDecoder().decode(bytes).trim();
  if (!/^[A-Za-z0-9+/=_-]{1,200}$/.test(signature)) return null;
  const sha256 = target.sha256;
  const ok = await verifyEd25519OverBytes(ctx.env, ctx.product, {
    subject: `sha256:${sha256}`,
    signature,
    publicKey,
    ...(target.sizeBytes !== null ? { expectedSize: target.sizeBytes } : {}),
    ...(ctx.waitUntil ? { waitUntil: ctx.waitUntil } : {}),
    open: async () => {
      const body = await openArtifact(ctx, target);
      return body ? pinned(body, sha256, target.sizeBytes) : null;
    },
  });
  return ok ? signature : null;
}

/**
 * The SHA-1 of an artifact's bytes (Velopack's `SHA1`), computed by a streaming digest that also
 * checks the recorded SHA-256 and size, memoised by that SHA-256. `null` when the bytes cannot be
 * read, or are not the recorded ones.
 */
export async function artifactSha1(
  ctx: ArtifactReadContext,
  artifact: CatalogSourceArtifact,
): Promise<string | null> {
  const sha256 = artifact.sha256;
  if (!sha256) return null;
  const key = kvKey(ctx.product, "artifact-sha1", sha256);
  const memo = await ctx.env.HOT.get(key);
  if (memo === "!") return null;
  if (memo && /^[0-9a-f]{40}$/.test(memo)) return memo;
  const body = await openArtifact(ctx, artifact);
  if (!body) return null;
  const work = (async (): Promise<string | null> => {
    const reader = body.getReader();
    const s1 = createHash("sha1");
    const s256 = createHash("sha256");
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        s1.update(value);
        s256.update(value);
      }
    } catch {
      return null; // no verdict: the next request reads again
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const ok =
      s256.digest("hex") === sha256 &&
      (artifact.sizeBytes === null || total === artifact.sizeBytes);
    const sha1 = s1.digest("hex");
    try {
      await ctx.env.HOT.put(key, ok ? sha1 : "!", {
        expirationTtl: ok ? SHA1_MEMO_TTL_SECONDS : SHA1_NEGATIVE_TTL_SECONDS,
      });
    } catch {
      // The answer stands; only the memo is lost.
    }
    return ok ? sha1 : null;
  })();
  ctx.waitUntil?.(work.catch(() => undefined));
  return work;
}
