// Verified download (SDK parity pass §3.6, proposed id `release.fetch`): stream one build's
// payload to a file, resumable, and verify it against the VERIFIED release record before handing
// it over. The reference is Godot's `core/download.gd`.
//
// Rules:
//   * the URL is discovery's `distribution.endpoints.builds` template (else Release's `builds`
//     alias), never the legacy `release/dl` route;
//   * the device bearer and the `X-PKey-*` headers go with the request when it is the control
//     plane's own origin (gated delivery needs them); a cross-origin redirect drops the bearer
//     (the fetch standard's rule, which undici follows);
//   * `Accept-Encoding: identity`, because a compressed body breaks `Range`;
//   * the bytes land in `<to>.part`; a later call resumes with `Range: bytes=<have>-` and
//     `If-Range: "<sha256>"` (a 206 appends, a 200 starts over, a 416 means the part is already
//     complete);
//   * size and SHA-256 are checked against the record's payload artifact BEFORE the part is
//     renamed to `to`; a mismatch deletes the part and throws `payload-mismatch`. A partial or
//     unverified file is never left at `to`.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { PolarisError } from "@polaris-key/client-core";
import type { ReleaseRecordDoc } from "@polaris-key/protocol/release";
import type { UpdateDecision } from "@polaris-key/protocol/update";
import { ErrorCode } from "../constants.generated.js";
import type { CoreContext } from "../core/context.js";
import { classifyResponse, errorFrom, transportError } from "../core/http.js";
import type { TokenManager } from "../core/token.js";
import type { UpdateClient } from "../update/client.js";

/** What to download: a `binary` decision, a record hash, or a verified record (each with an
 *  optional build id; without one the record's only build for this platform is used). */
export type FetchTarget =
  | Extract<UpdateDecision, { action: "binary" }>
  | { sha256: string; buildId?: string }
  | { record: ReleaseRecordDoc; buildId?: string };

export interface ReleaseFetchOptions {
  /** The destination file. Its directory is created when missing. */
  to: string;
  /** Bytes so far and the expected total. */
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface ReleaseFetchResult {
  path: string;
  size: number;
  sha256: string;
  version: string;
  buildId: string;
}

interface Artifact {
  name?: string;
  role?: string;
  sha256: string;
  size: number;
}

interface Build {
  id: string;
  platform?: string;
  arch?: string;
  artifacts?: Artifact[];
}

async function hashFile(
  path: string,
): Promise<{ size: number; hash: ReturnType<typeof createHash> }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { size, hash };
}

export async function releaseFetch(
  ctx: CoreContext,
  tokens: TokenManager,
  update: UpdateClient,
  target: FetchTarget,
  opts: ReleaseFetchOptions,
): Promise<ReleaseFetchResult> {
  // 1. The verified record and the build.
  let record: ReleaseRecordDoc;
  let buildId: string | undefined;
  if ("record" in target) {
    record = target.record;
    buildId = target.buildId;
  } else if ("action" in target) {
    if (!target.release.sha256)
      throw new PolarisError(
        ErrorCode.invalidOptions,
        "this decision names no release record hash.",
      );
    record = (await update.releaseRecord(target.release.sha256)).record;
    buildId = target.build;
  } else {
    record = (await update.releaseRecord(target.sha256)).record;
    buildId = target.buildId;
  }
  const builds = (record as unknown as { builds?: Build[] }).builds ?? [];
  const build = buildId
    ? builds.find((b) => b.id === buildId)
    : builds.length === 1
      ? builds[0]
      : undefined;
  if (!build)
    throw new PolarisError(
      ErrorCode.invalidOptions,
      buildId
        ? `release ${record.version} has no build ${buildId}.`
        : `release ${record.version} has several builds; name one.`,
    );
  const payload =
    build.artifacts?.find((a) => a.role === "payload") ?? build.artifacts?.[0];
  if (!payload || !/^[0-9a-f]{64}$/.test(payload.sha256))
    throw new PolarisError(
      ErrorCode.invalidOptions,
      `build ${build.id} names no payload artifact.`,
    );

  // 2. The URL, from discovery. Discovery that failed for want of an answer is reported as
  // that failure (`network-error` offline), not as a product without a builds route.
  const failed =
    update.buildUrl(record.version, build.id) === null
      ? await update.ensureDiscovery()
      : null;
  const url = update.buildUrl(record.version, build.id);
  if (url === null && failed !== null)
    throw new PolarisError(failed.code, failed.message, {
      ...(failed.status > 0 ? { status: failed.status } : {}),
    });
  if (url === null)
    throw new PolarisError(
      ErrorCode.serviceUnavailable,
      "discovery names no distribution builds route for this product.",
    );

  // 3. Download into the part file, resuming.
  const part = `${opts.to}.part`;
  await mkdir(dirname(opts.to), { recursive: true });
  ctx.fetcher(); // local-only refuses here, before the part file is read or reset
  let have = await stat(part).then(
    (s) => s.size,
    () => 0,
  );
  if (have > payload.size) {
    await rm(part, { force: true });
    have = 0;
  }
  const token = tokens.current;
  const sameOrigin = new URL(url).origin === new URL(ctx.baseUrl).origin;
  const headers = ctx.headers({
    "accept-encoding": "identity",
    ...(token && sameOrigin ? { authorization: `Bearer ${token}` } : {}),
    // Resume only the same bytes: If-Range names the payload's strong ETag (its quoted SHA-256),
    // so a server holding different bytes answers 200 and the download starts over.
    ...(have > 0
      ? { range: `bytes=${have}-`, "if-range": `"${payload.sha256}"` }
      : {}),
  });
  if (have < payload.size || have === 0) {
    // No deadline: a download takes as long as it takes, and the caller's signal cancels it.
    const res = await ctx.request(
      url,
      { headers, signal: opts.signal },
      "the build download",
    );
    if (res.status === 416 && have > 0) {
      // The part is already whole; verify it below.
    } else if (res.status === 200 || res.status === 206) {
      if (res.status === 200) have = 0;
      const fh = await open(part, res.status === 200 ? "w" : "a", 0o600);
      try {
        let done = have;
        opts.onProgress?.(done, payload.size);
        if (res.body) {
          const reader = res.body.getReader();
          for (;;) {
            let chunk: Awaited<ReturnType<typeof reader.read>>;
            try {
              chunk = await reader.read();
            } catch (e) {
              // The connection dropped mid-body: the part file keeps what arrived.
              if (opts.signal?.aborted) throw e;
              throw transportError(e, "the build download");
            }
            const { done: end, value } = chunk;
            if (end) break;
            done += value.length;
            if (done > payload.size) {
              await reader.cancel().catch(() => undefined);
              break;
            }
            await fh.write(value);
            opts.onProgress?.(done, payload.size);
          }
        }
      } finally {
        await fh.close();
      }
    } else {
      // The one taxonomy (SP-46): a gated refusal by its own code (`download_auth_required`),
      // `not_found` only for a 404, `rate_limited`, `server-error`.
      const c = await classifyResponse(res);
      throw errorFrom(
        c.message === undefined
          ? {
              ...c,
              message: `the build download was refused (status ${res.status}).`,
            }
          : c,
        "the build download",
      );
    }
  }

  // 4. Verify against the record, then move into place.
  const { size, hash } = await hashFile(part);
  const sha256 = hash.digest("hex");
  if (size !== payload.size || sha256 !== payload.sha256) {
    if (size < payload.size)
      throw new PolarisError(
        ErrorCode.networkError,
        `the download stopped at ${size} of ${payload.size} bytes; call again to resume.`,
      );
    await rm(part, { force: true });
    throw new PolarisError(
      ErrorCode.payloadMismatch,
      `the downloaded bytes do not match release ${record.version}'s record.`,
    );
  }
  await rename(part, opts.to);
  await update.journal
    .record("update_downloaded", {
      release: record.version,
      fromRelease: ctx.version,
    })
    .catch(() => null);
  return {
    path: opts.to,
    size,
    sha256,
    version: record.version,
    buildId: build.id,
  };
}
