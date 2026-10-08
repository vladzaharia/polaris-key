/**
 * F-03 fixtures: give any test world a package deliverable and a published package version,
 * written by the real package ingest (`packages/ingest.ts`) — so a suite can prove that nothing
 * device-facing ever shows it.
 */

import { createHash } from "node:crypto";
import { expect } from "vitest";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import { recordObject, blobKey } from "../src/core/blobs.js";
import { stmtUpsertDeliverable } from "../src/services/release/model.js";
import { ingestPackageDescriptor } from "../src/services/release/packages/ingest.js";

export const PACKAGE_ID = "npm.sdk";
export const PACKAGE_NAME = "@pkgtest/sdk";
/** Higher than every app version any world publishes, so "the newest" would pick it. */
export const PACKAGE_VERSION = "99.9.9";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Declare `npm.sdk` and publish 99.9.9 to `stable` (and the release id it got). */
export async function addPackageRelease(
  db: Db,
  env: Env,
  product: string,
  now: number,
  version = PACKAGE_VERSION,
): Promise<{ releaseId: string; sha256: string }> {
  const decl = {
    kind: "package" as const,
    id: PACKAGE_ID,
    ecosystem: "npm" as const,
    name: PACKAGE_NAME,
    artifacts: { tarball: { match: "pkgtest-sdk-*.tgz" } },
  };
  const s = stmtUpsertDeliverable(
    {
      product,
      deliverableId: PACKAGE_ID,
      kind: "package",
      defJson: JSON.stringify(decl),
      ecosystem: "npm",
      packageName: PACKAGE_NAME,
    },
    now,
  );
  await db.run(s.sql, ...s.params);
  const bytes = new TextEncoder().encode(`package ${product} ${version}`);
  const digest = sha(bytes);
  await recordObject(
    db,
    {
      storageKey: blobKey(digest),
      sha256: digest,
      size: bytes.length,
      kind: "blob",
      gated: false,
    },
    now,
  );
  // SEC-DST-14: the bytes are in the store too. Without them every blob-route answer for a
  // package is a 404 for want of an object, and "the route never serves a package" passes
  // vacuously (it hid SEC-DST-1).
  if (env.BLOBS)
    await env.BLOBS.put(blobKey(digest), bytes, { sha256: digest });
  const res = await ingestPackageDescriptor(
    db,
    env,
    product,
    {
      descriptorVersion: 1,
      product,
      deliverable: PACKAGE_ID,
      kind: "package",
      version,
      channel: "stable",
      package: {
        ecosystem: "npm",
        name: PACKAGE_NAME,
        files: [
          {
            name: `pkgtest-sdk-${version}.tgz`,
            role: "payload",
            type: "npm-tarball",
            sha256: digest,
            size: bytes.length,
            locations: [{ provider: "r2", key: blobKey(digest) }],
          },
        ],
        metadata: { name: PACKAGE_NAME, version },
      },
    },
    {
      now,
      promoted: [blobKey(digest)],
      feed: {
        ecosystem: "npm",
        enabled: true,
        ownerEnabled: true,
        policyEnabled: true,
        namespace: { scope: "@pkgtest" },
        maxPackageBytes: 52428800,
        ext: {},
      },
      source: { kind: "static" },
      digests: async () => new Map(),
    },
  );
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return { releaseId: `${PACKAGE_ID}@${version}`, sha256: digest };
}
