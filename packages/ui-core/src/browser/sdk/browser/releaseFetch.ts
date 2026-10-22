// Verified download for the browser transport (SDK parity pass §3.6, feature `release.fetch`):
// one build's payload, fetched with the device bearer, resumable, and checked against the
// VERIFIED release record before it is handed over. `@polaris-key/node`'s `release.fetch()`
// (packages/sdk-node/src/release/fetch.ts) with a `Blob` where Node writes a file.
//
// Rules, as Node's:
//   * the URL is discovery's `distribution.endpoints.builds` template (else Release's `builds`
//     alias), never the legacy `release/dl` route;
//   * the device bearer and the `X-PKey-*` headers go with the request when the URL is the
//     control plane's own origin (licensed delivery needs them); another origin gets neither
//     the bearer nor a cookie (`credentials: "omit"`);
//   * the bytes received so far are kept, per payload hash, in `parts`; a later call resumes
//     with `Range: bytes=<have>-` and `If-Range: "<sha256>"` (a 206 appends, a 200 starts over, a
//     416 means the held bytes are already whole). The Worker's CORS list allows both headers;
//   * size and SHA-256 are checked against the record's payload artifact BEFORE anything is
//     returned; a mismatch drops the held bytes and throws `payload-mismatch`. A partial or
//     unverified payload is never returned.
//
// A browser cannot set `Accept-Encoding` (a forbidden header); the Worker serves build bytes
// with `no-transform`, so no compression breaks the range arithmetic.
//
// It is a standalone function, like `decideBrowserUpdate`, so the adapter and the transcript
// replayer drive the same code.

import type { IHasher } from "hash-wasm";
import { verifyReleaseRecord } from "@polaris-key/client-core";
import { MAX_RECORD_JWS_BYTES } from "@polaris-key/protocol/core";
import type { ReleaseRecordDoc } from "@polaris-key/protocol/release";
import type { UpdateDecision } from "@polaris-key/protocol/update";
import { ErrorCode } from "../constants.generated.js";
import { PolarisError } from "../core/types.js";
import type { DiscoveryDocument } from "./discovery.js";
import type { TrustSet } from "./offline.js";
import { buildDownloadUrlFor, endpoint, expand, wireCodeOf } from "./update.js";

/** What to download: a `binary` decision, a record hash, or a verified record (each with an
 *  optional build id; without one the record's only build is used). */
export type FetchTarget =
  | Extract<UpdateDecision, { action: "binary" }>
  | { sha256: string; buildId?: string }
  | { record: ReleaseRecordDoc; buildId?: string };

export interface ReleaseFetchOptions {
  /** Bytes so far and the expected total. */
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/** The verified payload: a `Blob` in a browser, a file `path` the desktop host wrote. */
export interface ReleaseFetchResult {
  blob?: Blob;
  path?: string;
  size: number;
  sha256: string;
  version: string;
  buildId: string;
}

/** The bytes held from interrupted downloads, by payload SHA-256 (the adapter keeps a page-lived
 *  map; a host may hand its own). */
export type PartStore = Map<string, Uint8Array>;

export interface BrowserReleaseFetchOptions extends ReleaseFetchOptions {
  baseUrl: string;
  product: string;
  fetchImpl: typeof fetch;
  /** The verified discovery document, or null when discovery has not answered. */
  discovery: DiscoveryDocument | null;
  /** The `X-PKey-*` metadata (bearer mode: the session's, device id included). */
  headers: Record<string, string>;
  /** The device token, or null (a public build still downloads). */
  bearer: string | null;
  record: ReleaseRecordDoc;
  buildId?: string;
  parts: PartStore;
}

interface Artifact {
  role?: string;
  sha256: string;
  size: number;
}

const HEX64 = /^[0-9a-f]{64}$/;

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Download, resume and verify one build of a verified record. Throws `PolarisError`:
 *  `invalid-options` (no such build or payload), `service-unavailable` (discovery names no
 *  builds route), `network` (a transport failure or a short body: the bytes so far are kept,
 *  call again to resume), `payload-mismatch`, or `release-refused` with the server's code as
 *  `wireCode` (`download_auth_required`, `unauthorized`, `forbidden`, …). */
export async function fetchReleaseBuild(
  o: BrowserReleaseFetchOptions,
): Promise<ReleaseFetchResult & { blob: Blob }> {
  const record = o.record;
  const builds = record.builds ?? [];
  const build = o.buildId
    ? builds.find((b) => b.id === o.buildId)
    : builds.length === 1
      ? builds[0]
      : undefined;
  if (!build)
    throw new PolarisError(
      "invalid-options",
      o.buildId
        ? `release ${record.version} has no build ${o.buildId}.`
        : `release ${record.version} has several builds; name one.`,
    );
  const artifacts = (build.artifacts ?? []) as Artifact[];
  const payload = artifacts.find((a) => a.role === "payload") ?? artifacts[0];
  if (!payload || !HEX64.test(payload.sha256))
    throw new PolarisError(
      "invalid-options",
      `build ${build.id} names no payload artifact.`,
    );

  const url = buildDownloadUrlFor(
    o.discovery,
    o.baseUrl,
    record.version,
    build.id,
  );
  if (url === null)
    throw new PolarisError(
      "service-unavailable",
      "Discovery names no distribution builds route for this product.",
    );

  let held = o.parts.get(payload.sha256) ?? null;
  if (held && held.length > payload.size) {
    o.parts.delete(payload.sha256);
    held = null;
  }
  let have = held?.length ?? 0;
  const sameOrigin = new URL(url).origin === new URL(o.baseUrl).origin;
  const headers: Record<string, string> = {
    ...o.headers,
    ...(o.bearer && sameOrigin ? { authorization: `Bearer ${o.bearer}` } : {}),
    // Resume only the same bytes: If-Range names the payload's strong ETag (its quoted SHA-256),
    // so a server holding different bytes answers 200 and the download starts over.
    ...(have > 0
      ? { range: `bytes=${have}-`, "if-range": `"${payload.sha256}"` }
      : {}),
  };
  let chunks: Uint8Array[] = held ? [held] : [];
  if (have < payload.size || have === 0) {
    let res: Response;
    try {
      res = await o.fetchImpl(url, {
        method: "GET",
        credentials: "omit",
        headers: sameOrigin ? headers : {},
        ...(o.signal ? { signal: o.signal } : {}),
      });
    } catch (e) {
      if (o.signal?.aborted) throw e;
      throw new PolarisError(
        "network",
        (e as Error).message,
        ErrorCode.networkError,
      );
    }
    if (res.status === 416 && have > 0) {
      // The held bytes are already whole; verify them below.
    } else if (res.status === 200 || res.status === 206) {
      if (res.status === 200) {
        have = 0;
        chunks = [];
      }
      let done = have;
      o.onProgress?.(done, payload.size);
      try {
        if (res.body) {
          const reader = res.body.getReader();
          for (;;) {
            const { done: end, value } = await reader.read();
            if (end) break;
            if (done + value.length > payload.size) {
              await reader.cancel().catch(() => undefined);
              chunks.push(value);
              done += value.length;
              break;
            }
            chunks.push(value);
            done += value.length;
            o.onProgress?.(done, payload.size);
          }
        } else {
          const buf = new Uint8Array(await res.arrayBuffer());
          chunks.push(buf);
          done += buf.length;
          o.onProgress?.(done, payload.size);
        }
      } catch (e) {
        // Keep what arrived: the next call resumes from it.
        if (done > 0 && done <= payload.size)
          o.parts.set(payload.sha256, concat(chunks, done));
        if (o.signal?.aborted) throw e;
        throw new PolarisError(
          "network",
          (e as Error).message,
          ErrorCode.networkError,
        );
      }
      have = done;
    } else {
      const code = await wireCodeOf(res);
      throw new PolarisError(
        ErrorCode.releaseRefused,
        `The build download was refused (status ${res.status}).`,
        code ??
          (res.status === 401 ? ErrorCode.unauthorized : ErrorCode.forbidden),
      );
    }
  }

  // Verify against the record before anything is returned.
  const bytes = concat(chunks, have);
  if (bytes.length < payload.size) {
    o.parts.set(payload.sha256, bytes);
    throw new PolarisError(
      "network",
      `The download stopped at ${bytes.length} of ${payload.size} bytes; call again to resume.`,
      ErrorCode.networkError,
    );
  }
  // hash-wasm carries its wasm as base64: loaded here, on a download, never with the Provider.
  let hasher: IHasher;
  try {
    const { createSHA256 } = await import("hash-wasm");
    hasher = await createSHA256();
  } catch {
    // A chunk that will not load (offline, blocked, a stale deploy): typed, and the bytes are
    // never accepted unhashed.
    throw new PolarisError(
      "network",
      "The download could not be verified: the hashing module could not be loaded.",
      ErrorCode.networkError,
    );
  }
  hasher.init();
  hasher.update(bytes);
  const sha256 = hasher.digest("hex");
  o.parts.delete(payload.sha256);
  if (bytes.length !== payload.size || sha256 !== payload.sha256)
    throw new PolarisError(
      ErrorCode.payloadMismatch,
      `The downloaded bytes do not match release ${record.version}'s record.`,
    );
  return {
    blob: new Blob([bytes as BlobPart], { type: "application/octet-stream" }),
    size: bytes.length,
    sha256,
    version: record.version,
    buildId: build.id,
  };
}

/** One release record by hash (`release.endpoints.record`), verified against the PINNED release
 *  keys only, hash before signature. Throws `service-unavailable`, `network`, `release-refused`
 *  (with the server's code) or `record-rejected` (with the step as `detail`). */
export async function fetchVerifiedRecord(o: {
  baseUrl: string;
  product: string;
  fetchImpl: typeof fetch;
  discovery: DiscoveryDocument | null;
  headers: Record<string, string>;
  sha256: string;
  releaseKeys: TrustSet;
  productTrust: TrustSet;
}): Promise<ReleaseRecordDoc> {
  const template = endpoint(o.discovery, "release", "record");
  if (template === null)
    throw new PolarisError(
      "service-unavailable",
      "Discovery names no release record route for this product.",
    );
  let res: Response;
  try {
    res = await o.fetchImpl(
      expand(template, o.baseUrl, { sha256: o.sha256 }).toString(),
      {
        method: "GET",
        credentials: "omit",
        headers: { accept: "application/jose", ...o.headers },
      },
    );
  } catch (e) {
    throw new PolarisError(
      "network",
      (e as Error).message,
      ErrorCode.networkError,
    );
  }
  if (!res.ok)
    throw new PolarisError(
      ErrorCode.releaseRefused,
      `The release record was refused (status ${res.status}).`,
      (await wireCodeOf(res)) ?? ErrorCode.notFound,
    );
  const text = await res.text();
  const v = await verifyReleaseRecord(
    text.length > MAX_RECORD_JWS_BYTES
      ? text.slice(0, MAX_RECORD_JWS_BYTES + 1)
      : text,
    {
      releaseKeys: o.releaseKeys,
      productTrust: o.productTrust,
      expectedAud: o.product,
      expectedHash: o.sha256,
    },
  );
  if (!v.ok)
    throw new PolarisError(
      "record-rejected",
      `The release record was refused at step ${v.step}.`,
      "record-rejected",
      v.step,
    );
  return v.record;
}
