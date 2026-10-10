/// <reference types="@cloudflare/workers-types" />

/**
 * The payload URL (P4-18): one pack container payload, DECODED, for a browser, beside the blob
 * route (README §3.5; notes/A7 §9.1, §9.3; RFC 9842):
 *
 *     GET|HEAD /<p>/distribution/packs/<pack>/<variant>/payload/<sha256>[?via=dcz]
 *
 * `<variant>` is the variant key (`texture=s3tc;…`) or `default`; `<sha256>` is the variant's
 * `payload.sha256`. Also answered on the bytes host (`DISTRIBUTION_BYTE_ROUTES`).
 *
 * ── WHY A SECOND URL ────────────────────────────────────────────────────────────────────────
 *
 * The blob route serves every stored object as opaque bytes with no `Content-Encoding`, so
 * `Range` and the stored hash stay intact. A browser keeps a response as a dictionary AFTER
 * content decoding, and a `--patch-from` delta's base is the decoded payload (`from` is its
 * SHA-256), so the dictionary must be the payload, not the stored frame. This URL therefore
 * streams the stored `full` frame with `Content-Encoding: zstd` (the browser decodes it
 * natively: no WASM), full-body only (no `Range`), and leaves the blob route unchanged.
 *
 * ── WHAT IT ANSWERS (`dictionary.ts` `choosePayloadAnswer`) ─────────────────────────────────
 *
 *   - `Available-Dictionary` naming the `from` of a published `zstd-patch-from` payload delta TO
 *     this payload, and `dcz` accepted: `Content-Encoding: dcz`, the 40-byte header derived from
 *     `from` and the stored artifact streamed from R2 (no base byte is read);
 *   - else, with `?via=dcz` (the SDK's guard against a silent full download): `409`, no body;
 *   - else the stored `full`: with `Content-Encoding: zstd` when `zstd` is accepted (`406`
 *     otherwise; the frame is never decoded at the edge), or raw for `codec: none`.
 *
 * Every answer carries `Vary: Accept-Encoding, Available-Dictionary`. A `200` for an ungated
 * payload of at most 100 MiB carries `Use-As-Dictionary` with a per-(pack, variant) match
 * pattern. A gated payload's answer is `private, no-store` and never a dictionary: the browser
 * could not keep it, so gated packs take the WASM path.
 *
 * ── ACCESS ──────────────────────────────────────────────────────────────────────────────────
 *
 * Exactly the blob route's (`blobAccess.ts`): the `full` object is decided from the holders of
 * its keys (the pack's delivery access and, under `gated/`, its current gate), and a dcz answer
 * also needs the artifact decided servable. The body is sent with `encodeBody: "manual"` (set
 * at the edge, `index.ts`), so the runtime never re-encodes the pre-encoded bytes. Cloudflare's
 * shared-dictionary support is passthrough: it forwards the headers and varies the cache, and
 * never computes a delta itself (notes/E5 §4.1).
 */

import type { CatalogPackPayload, ReleaseCatalog } from "../../core/hooks.js";
import { notFound } from "../../core/errors.js";
import {
  BLOB_CSP,
  checksumHex,
  parseKey,
  reprDigest,
} from "../../core/assets/blobs.js";
import { decideBlob } from "./blobAccess.js";
import type { ByteContext } from "./bytes.js";
import {
  choosePayloadAnswer,
  DCZ_GUARD,
  DCZ_HEADER_BYTES,
  dczHeader,
  MAX_DICTIONARY_BYTES,
  PAYLOAD_VARY,
  useAsDictionary,
} from "./dictionary.js";

export interface PayloadTarget {
  kind: "payload";
  packId: string;
  /** The variant segment: a variant key, or `default`. */
  buildId: string;
  /** The variant's `payload.sha256`. */
  sha256: string;
}

/** What the access step decided for a payload URL request. */
export type PayloadDecision =
  | { kind: "refused"; response: Response }
  | {
      kind: "serve";
      payload: CatalogPackPayload;
      /** The `full` object's key, and whether every holder of it is `public`. */
      key: string;
      publicCache: boolean;
    };

/** The pack payload and the blob route's decision for its `full` object. */
export async function decidePayload(
  ctx: ByteContext,
  catalog: ReleaseCatalog,
  target: PayloadTarget,
): Promise<PayloadDecision> {
  const payload = catalog.packPayload
    ? await catalog.packPayload(target.packId, target.buildId, target.sha256)
    : null;
  if (!payload) return { kind: "refused", response: notFound() };
  const d = await decideBlob(ctx, catalog, payload.full.sha256);
  if (d.kind === "refused") return d;
  if (d.kind === "absent") return { kind: "refused", response: notFound() };
  return {
    kind: "serve",
    payload,
    key: d.key,
    publicCache: d.publicCache,
  };
}

/** A stored, servable object: its key and R2 head, its stored checksum checked. */
async function storedObject(
  bucket: R2Bucket,
  key: string,
  sha256: string,
  bytes: number,
): Promise<R2Object | null> {
  const parsed = parseKey(key);
  if (!parsed || parsed.area === "staging") return null;
  const head = await bucket.head(key);
  // Fail closed as `blobResponse` does: no stored checksum, or another one, is not ours to serve.
  if (!head || checksumHex(head) !== sha256 || head.size !== bytes) return null;
  return head;
}

/** `header` followed by `body`, with a fixed length on workerd (`FixedLengthStream`). */
export function prefixed(
  header: Uint8Array,
  body: ReadableStream<Uint8Array>,
  length: number,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let sentHeader = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentHeader) {
        sentHeader = true;
        controller.enqueue(header);
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const Fixed = (
    globalThis as {
      FixedLengthStream?: new (
        n: number,
      ) => TransformStream<Uint8Array, Uint8Array>;
    }
  ).FixedLengthStream;
  if (!Fixed) return stream;
  const fixed = new Fixed(length);
  // The response consumes `fixed.readable`; a failed pipe errors it, which the client sees.
  stream.pipeTo(fixed.writable).catch(() => undefined);
  return fixed.readable;
}

/** Serve one payload URL request the access step cleared. */
export async function servePayload(
  ctx: ByteContext,
  catalog: ReleaseCatalog,
  decision: Extract<PayloadDecision, { kind: "serve" }>,
  target: PayloadTarget,
): Promise<Response> {
  const { req, env, product } = ctx;
  const bucket = env.BLOBS;
  if (!bucket) return notFound();
  const { payload } = decision;
  const url = new URL(req.url);
  const guard = url.searchParams.get(DCZ_GUARD.param) === DCZ_GUARD.value;
  const ask = (deltas: CatalogPackPayload["deltas"]) =>
    choosePayloadAnswer({
      acceptEncoding: req.headers.get("accept-encoding"),
      availableDictionary: req.headers.get("available-dictionary"),
      guard,
      fullCodec: payload.full.codec,
      deltas,
    });

  let answer = ask(payload.deltas);
  let artifact: { key: string; head: R2Object } | null = null;
  if (answer.kind === "dcz") {
    // The artifact is authorised as the blob route would authorise it, and must be stored.
    const a = answer.artifact;
    const d = await decideBlob(ctx, catalog, a.sha256);
    const head =
      d.kind === "serve"
        ? await storedObject(bucket, d.key, a.sha256, a.bytes)
        : null;
    if (d.kind === "serve" && head) artifact = { key: d.key, head };
    else answer = ask([]);
  }

  const parsedKey = parseKey(decision.key);
  const gated =
    payload.gated ||
    (parsedKey !== null && "gated" in parsedKey && parsedKey.gated === true);
  const headers = new Headers({
    vary: PAYLOAD_VARY,
    "x-content-type-options": "nosniff",
    "content-security-policy": BLOB_CSP,
  });
  if (answer.kind === "refuse") {
    headers.set("cache-control", "no-store");
    return new Response(null, { status: answer.status, headers });
  }

  headers.set(
    "cache-control",
    gated
      ? "private, no-store, no-transform"
      : decision.publicCache
        ? "public, max-age=31536000, immutable, no-transform"
        : // Ungated but not public (a licence is needed): the browser may keep it, and so use it
          // as a dictionary; no shared cache may.
          "private, max-age=31536000, immutable, no-transform",
  );
  headers.set("content-type", "application/octet-stream");
  headers.set(
    "content-disposition",
    `attachment; filename="${payload.payload.sha256}"`,
  );
  headers.set("accept-ranges", "none");
  if (!gated && payload.payload.size <= MAX_DICTIONARY_BYTES)
    headers.set(
      "use-as-dictionary",
      useAsDictionary(product.slug, target.packId, target.buildId),
    );

  if (answer.kind === "dcz" && artifact) {
    const length = DCZ_HEADER_BYTES + answer.artifact.bytes;
    headers.set("content-encoding", "dcz");
    headers.set("content-length", String(length));
    if (req.method === "HEAD")
      return new Response(null, { status: 200, headers });
    const obj = await bucket.get(artifact.key, {
      onlyIf: { etagMatches: artifact.head.etag },
    });
    if (!obj || !("body" in obj)) return notFound();
    return new Response(prefixed(dczHeader(answer.from), obj.body, length), {
      status: 200,
      headers,
    });
  }

  const full = payload.full;
  const head = await storedObject(
    bucket,
    decision.key,
    full.sha256,
    full.bytes,
  );
  if (!head) return notFound();
  if (answer.kind === "full" && answer.encoding === "zstd")
    headers.set("content-encoding", "zstd");
  headers.set("content-length", String(full.bytes));
  // The representation is the stored frame (RFC 9530), whose hash the record names.
  headers.set("etag", `"${full.sha256}"`);
  headers.set("repr-digest", reprDigest(full.sha256));
  if (req.method === "HEAD")
    return new Response(null, { status: 200, headers });
  const obj = await bucket.get(decision.key, {
    onlyIf: { etagMatches: head.etag },
  });
  if (!obj || !("body" in obj)) return notFound();
  return new Response(obj.body, { status: 200, headers });
}
