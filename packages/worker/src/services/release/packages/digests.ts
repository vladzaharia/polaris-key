/**
 * The digests npm and Maven clients verify beyond SHA-256 (F-03, plans/F-01.md §6.3): npm's
 * `dist.integrity` (SHA-512) and `dist.shasum` (SHA-1), and Maven's `.sha512`, `.sha1` and `.md5`
 * sidecars. Each `npm-tarball` and `maven-file` is streamed once from the blob store after
 * promotion; SHA-256 is already the blob key and R2-verified, which is all PyPI, Swift, OCI and
 * Godot need.
 *
 * `node:crypto`'s streaming `createHash` (the Worker runs with `nodejs_compat`, and
 * `ed25519Stream.ts` already streams SHA-512 through it) holds only the hash state and the chunk
 * in hand, so a 50 MiB package never sits in the isolate's memory. It covers SHA-1, SHA-512 and
 * MD5 in workerd and in Node alike, so no per-algorithm fallback is needed.
 */

import { createHash } from "node:crypto";
import type { Env } from "../../../core/platform.js";
import type { PackageFileRow } from "./ingest.js";

export interface FileDigests {
  sha1?: string;
  sha512?: string;
  md5?: string;
}

/** Which digests a file type gets. */
function algorithmsFor(type: string): ("sha1" | "sha512" | "md5")[] {
  if (type === "npm-tarball") return ["sha512", "sha1"];
  if (type === "maven-file") return ["sha512", "sha1", "md5"];
  return [];
}

/** Stream one body through every algorithm, once. */
export async function digestStream(
  body: ReadableStream<Uint8Array>,
  algorithms: readonly ("sha1" | "sha512" | "md5")[],
): Promise<FileDigests> {
  const hashes = algorithms.map((a) => [a, createHash(a)] as const);
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const [, h] of hashes) h.update(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out: FileDigests = {};
  for (const [a, h] of hashes) out[a] = h.digest("hex");
  return out;
}

/**
 * The extra digests of every npm tarball and Maven file among `files`, by file name, read from
 * the blob store. A file whose object cannot be read gets none (the renderers then omit the
 * sidecar rather than invent one); the release was already verified by SHA-256.
 */
export async function packageFileDigests(
  env: Env,
  files: readonly PackageFileRow[],
): Promise<Map<string, FileDigests>> {
  const out = new Map<string, FileDigests>();
  const bucket = env.BLOBS;
  if (!bucket) return out;
  for (const f of files) {
    const algorithms = algorithmsFor(f.type);
    if (algorithms.length === 0) continue;
    const obj = await bucket.get(f.storageKey);
    if (!obj) continue;
    out.set(f.name, await digestStream(obj.body, algorithms));
  }
  return out;
}
