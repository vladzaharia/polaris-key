/**
 * F-08 fixtures: a deterministic OCI repository with four versions, published through the real
 * package ingest (`services/release/packages/ingest.ts`) into a test world, and the same package
 * as a `RegistryPackage` for the renderer's golden files.
 *
 *   0.8.0          stable  deprecated   one manifest (Docker schema 2)
 *   0.9.0          stable  yanked       one manifest (OCI)
 *   1.0.0          stable  live         a multi-arch image index (linux/amd64, linux/arm64)
 *   1.1.0-beta.1   beta    live         one manifest (OCI)
 *
 * Every byte is a pure function of the version, so digests (and the golden files) are stable.
 */

import { createHash } from "node:crypto";
import { expect } from "vitest";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import { blobKey, recordObject } from "../src/core/blobs.js";
import { stmtUpsertDeliverable } from "../src/services/release/model.js";
import { ingestPackageDescriptor } from "../src/services/release/packages/ingest.js";
import { packageStateStatements } from "../src/services/release/packages/state.js";
import { yank } from "../src/services/release/policy.js";
import type { AdminSession } from "../src/admin/session.js";
import type {
  PackageFile,
  RegistryPackage,
} from "../src/services/distribution/registry/materialise.js";
import type { R2Mock } from "./r2Mock.js";

export const OCI_ID = "oci.app";
export const OCI_REPO = "tools/app";

export const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
export const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
export const DOCKER_MANIFEST =
  "application/vnd.docker.distribution.manifest.v2+json";
const OCI_CONFIG = "application/vnd.oci.image.config.v1+json";
const OCI_LAYER = "application/vnd.oci.image.layer.v1.tar+gzip";

const enc = (s: string) => new TextEncoder().encode(s);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** One object of a version, with its bytes. */
export interface OciObject {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly type: "oci-blob" | "oci-manifest" | "oci-index";
  readonly mediaType: string;
}

/** One version of the fixture repository. */
export interface OciFixtureVersion {
  readonly version: string;
  readonly channel: string;
  readonly state: "live" | "yanked" | "deprecated";
  readonly stateMessage: string | null;
  readonly objects: readonly OciObject[];
  /** The digest the version's tag points to, and its media type. */
  readonly root: OciObject;
  readonly platforms?: readonly string[];
}

function object(
  bytes: Uint8Array,
  type: OciObject["type"],
  mediaType: string,
): OciObject {
  return { bytes, sha256: sha(bytes), type, mediaType };
}

const descriptor = (o: OciObject, extra: Record<string, unknown> = {}) => ({
  mediaType: o.mediaType,
  digest: `sha256:${o.sha256}`,
  size: o.bytes.length,
  ...extra,
});

/** One platform image: its config, its layer and its manifest. */
function image(
  version: string,
  arch: string,
  manifestType: string,
): { manifest: OciObject; objects: OciObject[] } {
  const layer = object(
    enc(`layer ${version} ${arch}\n`),
    "oci-blob",
    OCI_LAYER,
  );
  const config = object(
    enc(
      JSON.stringify({
        architecture: arch,
        os: "linux",
        rootfs: { type: "layers", diff_ids: [`sha256:${layer.sha256}`] },
      }),
    ),
    "oci-blob",
    OCI_CONFIG,
  );
  const manifest = object(
    enc(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: manifestType,
        config: descriptor(config),
        layers: [descriptor(layer)],
      }),
    ),
    "oci-manifest",
    manifestType,
  );
  return { manifest, objects: [manifest, config, layer] };
}

function single(
  version: string,
  channel: string,
  state: OciFixtureVersion["state"],
  stateMessage: string | null,
  manifestType: string,
): OciFixtureVersion {
  const { manifest, objects } = image(version, "amd64", manifestType);
  return { version, channel, state, stateMessage, objects, root: manifest };
}

function multiArch(version: string, channel: string): OciFixtureVersion {
  const amd = image(version, "amd64", OCI_MANIFEST);
  const arm = image(version, "arm64", OCI_MANIFEST);
  const index = object(
    enc(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_INDEX,
        manifests: [
          descriptor(amd.manifest, {
            platform: { architecture: "amd64", os: "linux" },
          }),
          descriptor(arm.manifest, {
            platform: { architecture: "arm64", os: "linux" },
          }),
        ],
      }),
    ),
    "oci-index",
    OCI_INDEX,
  );
  return {
    version,
    channel,
    state: "live",
    stateMessage: null,
    objects: [index, ...amd.objects, ...arm.objects],
    root: index,
    platforms: ["linux/amd64", "linux/arm64"],
  };
}

/** The four versions, in publication order. */
export function ociFixture(): OciFixtureVersion[] {
  return [
    single("0.8.0", "stable", "deprecated", "use 1.x", DOCKER_MANIFEST),
    single("0.9.0", "stable", "yanked", "broken entrypoint", OCI_MANIFEST),
    multiArch("1.0.0", "stable"),
    single("1.1.0-beta.1", "beta", "live", null, OCI_MANIFEST),
  ];
}

function files(v: OciFixtureVersion): PackageFile[] {
  return v.objects.map((o) => ({
    name: `sha256:${o.sha256}`,
    type: o.type,
    sha256: o.sha256,
    size: o.bytes.length,
    mediaType: o.mediaType,
  }));
}

function metadata(v: OciFixtureVersion): Record<string, unknown> {
  return {
    name: OCI_REPO,
    version: v.version,
    root: `sha256:${v.root.sha256}`,
    mediaType: v.root.mediaType,
    ...(v.platforms ? { platforms: [...v.platforms] } : {}),
  };
}

/** The fixture as the renderer sees it (what `releaseCatalog` answers for it). */
export function ociFixturePackage(owner: string): RegistryPackage {
  const versions = ociFixture();
  return {
    product: owner,
    ecosystem: "oci",
    deliverableId: OCI_ID,
    name: OCI_REPO,
    nameNorm: OCI_REPO,
    versions: versions.map((v, i) => ({
      version: v.version,
      state: v.state,
      stateMessage: v.stateMessage,
      files: files(v),
      metadata: metadata(v),
      publishedAt: 1_700_000_000 + i,
    })),
    tags: { latest: "1.0.0", beta: "1.1.0-beta.1" },
  };
}

/**
 * Declare `oci.app` (`tools/app`) for `product`, store every object in `bucket` with its
 * checksum, publish the four versions through the real ingest, then set the yank and the
 * deprecation. The feed rows must already exist.
 */
export async function publishOciFixture(
  db: Db,
  env: Env,
  bucket: R2Mock,
  product: string,
  now: number,
): Promise<OciFixtureVersion[]> {
  const decl = {
    kind: "package" as const,
    id: OCI_ID,
    ecosystem: "oci" as const,
    name: OCI_REPO,
    artifacts: { layout: { match: "image/**" } },
  };
  const s = stmtUpsertDeliverable(
    {
      product,
      deliverableId: OCI_ID,
      kind: "package",
      defJson: JSON.stringify(decl),
      ecosystem: "oci",
      packageName: OCI_REPO,
    },
    now,
  );
  await db.run(s.sql, ...s.params);
  // What resync writes for every deliverable, packages included: its delivery access row.
  await db.run(
    `INSERT OR IGNORE INTO dist_access (product, deliverable_id, mode, source, modified_at)
     VALUES (?, ?, 'public', 'manifest', ?)`,
    product,
    OCI_ID,
    now,
  );
  const versions = ociFixture();
  for (const [i, v] of versions.entries()) {
    for (const o of v.objects) {
      await bucket.put(blobKey(o.sha256), o.bytes, { sha256: o.sha256 });
      await recordObject(
        db,
        {
          storageKey: blobKey(o.sha256),
          sha256: o.sha256,
          size: o.bytes.length,
          kind: "blob",
          gated: false,
        },
        now,
      );
    }
    const res = await ingestPackageDescriptor(
      db,
      env,
      product,
      {
        descriptorVersion: 1,
        product,
        deliverable: OCI_ID,
        kind: "package",
        version: v.version,
        channel: v.channel,
        seq: i + 1,
        package: {
          ecosystem: "oci",
          name: OCI_REPO,
          files: files(v).map((f) => ({
            ...f,
            role: "payload" as const,
            locations: [{ provider: "r2" as const, key: blobKey(f.sha256) }],
          })),
          metadata: metadata(v),
        },
      },
      {
        now: now + i,
        promoted: v.objects.map((o) => blobKey(o.sha256)),
        feed: {
          ecosystem: "oci",
          enabled: true,
          ownerEnabled: true,
          policyEnabled: true,
          namespace: {},
          maxPackageBytes: 5368709120,
          ext: {},
        },
        source: { kind: "static" },
        digests: async () => new Map(),
      },
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
  }
  // The state changes through Release's own paths: the yank (which also hides the version from
  // its channel) and the package-state statements the deprecate route runs.
  for (const v of versions) {
    const releaseId = `${OCI_ID}@${v.version}`;
    if (v.state === "yanked") {
      const y = await yank(
        env,
        db,
        product,
        releaseId,
        v.stateMessage,
        { kind: "admin", session: { sub: "u1" } as AdminSession },
        now + 10,
      );
      expect(y.ok, JSON.stringify(y)).toBe(true);
    }
    if (v.state === "deprecated")
      await db.batch(
        await packageStateStatements(
          db,
          product,
          releaseId,
          "deprecate",
          v.stateMessage,
          now + 10,
        ),
      );
  }
  return versions;
}
