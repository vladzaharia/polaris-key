/**
 * Seed the harness's OCI feed (F-08, plans/F-01.md §6.8). Run by `run.mjs` with tsx, before
 * `wrangler dev` starts, against the same local state directory:
 *
 *   tsx scripts/registry-clients/seeds/oci.ts --persist-to <state>
 *
 *   1. builds real OCI image layouts on disk: gzip'd tar layers with correct `diff_ids`, image
 *      configs, manifests and, for the multi-arch version, an image index (linux/amd64 and
 *      linux/arm64);
 *   2. reads each layout with the CLI's own extractor (`packages/cli/src/package/oci.ts`, what
 *      `pkey release publish` runs) and builds the `kind: package` descriptor as the CLI does;
 *   3. stores every blob in the local R2 bucket with its SHA-256 checksum (what an upload
 *      ticket's PUT and the promotion leave behind) and ingests the descriptor through the
 *      Worker's own package ingest (`services/release/packages/ingest.ts`), into the local D1;
 *   4. yanks 0.9.0 and deprecates 0.8.0 through Release's own paths.
 *
 * The real `pkey release publish` upload (an upload ticket's temporary R2 S3 credentials) has no
 * local equivalent under `wrangler dev`, so steps 2 and 3 call the same code in-process instead
 * of over HTTP. Nothing here reaches a deployed environment: the bindings are wrangler's local
 * ones for `--env test`.
 *
 *   0.8.0          stable  deprecated  linux/amd64
 *   0.9.0          stable  yanked      linux/amd64
 *   1.0.0          stable  live        linux/amd64 + linux/arm64 (an image index)
 *   1.1.0-beta.1   beta    live        linux/amd64
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { getPlatformProxy } from "wrangler";
import { extractOci } from "../../../../cli/src/package/oci.ts";
import { hashFile } from "../../../../cli/src/publish.ts";
import { D1Db } from "../../../src/db/d1.ts";
import { blobKey, recordObject } from "../../../src/core/blobs.ts";
import { stmtUpsertDeliverable } from "../../../src/services/release/model.ts";
import { ingestPackageDescriptor } from "../../../src/services/release/packages/ingest.ts";
import { packageStateStatements } from "../../../src/services/release/packages/state.ts";
import { yank } from "../../../src/services/release/policy.ts";
import type { Env } from "../../../src/env.ts";

export const OWNER = "registry-smoke";
export const DELIVERABLE = "oci.smoke";
export const REPOSITORY = "tools/smoke";

const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const OCI_CONFIG = "application/vnd.oci.image.config.v1+json";
const OCI_LAYER = "application/vnd.oci.image.layer.v1.tar+gzip";

const sha = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** A one-file ustar archive (the layer's uncompressed bytes). */
function tar(name: string, content: string): Buffer {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  const put = (s: string, off: number, len: number) =>
    header.write(s, off, len, "ascii");
  put(name, 0, 100);
  put("0000644\0", 100, 8);
  put("0000000\0", 108, 8);
  put("0000000\0", 116, 8);
  put(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12);
  put("00000000000\0", 136, 12);
  put("        ", 148, 8);
  put("0", 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const b of header) sum += b;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, pad, Buffer.alloc(1024)]);
}

interface Blob {
  bytes: Buffer;
  digest: string;
  mediaType: string;
}

function blob(bytes: Buffer | string, mediaType: string): Blob {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return { bytes: b, digest: `sha256:${sha(b)}`, mediaType };
}

const desc = (b: Blob, extra: Record<string, unknown> = {}) => ({
  mediaType: b.mediaType,
  digest: b.digest,
  size: b.bytes.length,
  ...extra,
});

/** One platform's image: layer, config, manifest. */
function image(version: string, arch: string): { manifest: Blob; all: Blob[] } {
  const raw = tar(
    "hello.txt",
    `hello from Polaris Key ${version} on linux/${arch}\n`,
  );
  // mtime 0 in the gzip header, so the bytes are a pure function of the input.
  const layer = blob(gzipSync(raw, { level: 9 }), OCI_LAYER);
  const config = blob(
    JSON.stringify({
      architecture: arch,
      os: "linux",
      config: { Cmd: ["/hello.txt"] },
      rootfs: { type: "layers", diff_ids: [`sha256:${sha(raw)}`] },
      history: [{ created_by: "registry-clients seed (F-08)" }],
    }),
    OCI_CONFIG,
  );
  const manifest = blob(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      config: desc(config),
      layers: [desc(layer)],
    }),
    OCI_MANIFEST,
  );
  return { manifest, all: [manifest, config, layer] };
}

/** Write an OCI image layout for one version; answer its directory. */
function layout(root: string, version: string, archs: string[]): string {
  const dir = join(root, version);
  mkdirSync(join(dir, "blobs", "sha256"), { recursive: true });
  const images = archs.map((a) => image(version, a));
  const blobs = images.flatMap((i) => i.all);
  let top: Blob;
  if (archs.length > 1) {
    top = blob(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_INDEX,
        manifests: images.map((img, i) =>
          desc(img.manifest, {
            platform: { architecture: archs[i], os: "linux" },
          }),
        ),
      }),
      OCI_INDEX,
    );
    blobs.push(top);
  } else top = images[0]!.manifest;
  for (const b of blobs)
    writeFileSync(join(dir, "blobs", "sha256", b.digest.slice(7)), b.bytes);
  writeFileSync(
    join(dir, "oci-layout"),
    JSON.stringify({ imageLayoutVersion: "1.0.0" }),
  );
  writeFileSync(
    join(dir, "index.json"),
    JSON.stringify({
      schemaVersion: 2,
      manifests: [
        desc(top, {
          annotations: { "org.opencontainers.image.ref.name": version },
        }),
      ],
    }),
  );
  return dir;
}

const VERSIONS: Array<{
  version: string;
  channel: string;
  archs: string[];
  state?: "yanked" | "deprecated";
  message?: string;
}> = [
  {
    version: "0.8.0",
    channel: "stable",
    archs: ["amd64"],
    state: "deprecated",
    message: "use 1.x",
  },
  {
    version: "0.9.0",
    channel: "stable",
    archs: ["amd64"],
    state: "yanked",
    message: "broken entrypoint",
  },
  { version: "1.0.0", channel: "stable", archs: ["amd64", "arm64"] },
  { version: "1.1.0-beta.1", channel: "beta", archs: ["amd64"] },
];

async function main(): Promise<void> {
  const state = argValue("--persist-to");
  if (!state) {
    console.error("usage: seeds/oci.ts --persist-to <dir>");
    process.exit(2);
  }
  const proxy = await getPlatformProxy<Env>({
    environment: "test",
    persist: { path: join(state, "v3") },
  });
  const work = mkdtempSync(join(tmpdir(), "pkey-oci-seed-"));
  try {
    const env = proxy.env;
    const db = new D1Db(env.DB as unknown as D1Database);
    const bucket = env.BLOBS!;
    const now = Math.floor(Date.now() / 1000);
    await db.run(
      "INSERT OR IGNORE INTO dist_registry_owners (product, enabled, updated_at) VALUES (?, 1, ?)",
      OWNER,
      now,
    );
    await db.run(
      `INSERT OR IGNORE INTO dist_registry_feeds (product, ecosystem, enabled, namespace_json, max_package_bytes, updated_at)
       VALUES (?, 'oci', 1, '{}', 5368709120, ?)`,
      OWNER,
      now,
    );
    const declaration = {
      kind: "package" as const,
      id: DELIVERABLE,
      ecosystem: "oci" as const,
      name: REPOSITORY,
      artifacts: { layout: { match: "image/**" } },
    };
    const s = stmtUpsertDeliverable(
      {
        product: OWNER,
        deliverableId: DELIVERABLE,
        kind: "package",
        defJson: JSON.stringify(declaration),
        ecosystem: "oci",
        packageName: REPOSITORY,
      },
      now,
    );
    await db.run(s.sql, ...s.params);
    await db.run(
      `INSERT OR IGNORE INTO dist_access (product, deliverable_id, mode, source, modified_at)
       VALUES (?, ?, 'public', 'manifest', ?)`,
      OWNER,
      DELIVERABLE,
      now,
    );
    for (const [i, v] of VERSIONS.entries()) {
      const dir = layout(work, v.version, v.archs);
      const x = await extractOci({
        declaration,
        dir,
        workDir: work,
        version: v.version,
      });
      const files = [];
      for (const f of x.files) {
        const { sha256, size } = await hashFile(f.path);
        const bytes = await readFile(f.path);
        await bucket.put(blobKey(sha256), bytes, { sha256 });
        await recordObject(
          db,
          {
            storageKey: blobKey(sha256),
            sha256,
            size,
            kind: "blob",
            gated: false,
          },
          now,
        );
        files.push({
          name: f.name,
          role: "payload" as const,
          type: f.type,
          sha256,
          size,
          ...(f.mediaType ? { mediaType: f.mediaType } : {}),
          locations: [{ provider: "r2" as const, key: blobKey(sha256) }],
        });
      }
      const descriptor = {
        descriptorVersion: 1 as const,
        product: OWNER,
        deliverable: DELIVERABLE,
        kind: "package" as const,
        version: v.version,
        channel: v.channel,
        seq: i + 1,
        package: {
          ecosystem: "oci" as const,
          name: REPOSITORY,
          files,
          metadata: x.metadata,
        },
      };
      const res = await ingestPackageDescriptor(db, env, OWNER, descriptor, {
        now: now + i,
        promoted: files.map((f) => blobKey(f.sha256)),
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
      });
      if (!res.ok)
        throw new Error(`ingest ${v.version}: ${JSON.stringify(res)}`);
      console.log(
        `seeded ${OWNER}/${REPOSITORY}:${v.version} (${v.channel}, ${files.length} objects, root ${String(x.metadata.root)})`,
      );
    }
    for (const v of VERSIONS) {
      const releaseId = `${DELIVERABLE}@${v.version}`;
      if (v.state === "yanked") {
        const y = await yank(
          env,
          db,
          OWNER,
          releaseId,
          v.message,
          {
            kind: "admin",
            session: { sub: "registry-clients" },
          } as unknown as Parameters<typeof yank>[5],
          now + 10,
        );
        if (!y.ok) throw new Error(`yank ${releaseId}: ${JSON.stringify(y)}`);
      }
      if (v.state === "deprecated")
        await db.batch(
          await packageStateStatements(
            db,
            OWNER,
            releaseId,
            "deprecate",
            v.message ?? null,
            now + 10,
          ),
        );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
    await proxy.dispose();
  }
}

await main();
