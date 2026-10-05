/// <reference types="@cloudflare/workers-types" />
// distribution-download-model (SP-00, `release.distribution`; SDK-PARITY-PASS §3.8): the public
// download page's model, `GET /<p>/distribution/download.json` (P2b-06), as the
// `client.distribution` sub-client reads it — the platform groups, and the group for the
// device's own platform (`current`).
//
// Also home to `deliveryWorld`, the fixture `release-fetch-gated` (release.ts) shares: a product
// running Release and Distribution with one stable release, 1.0.0, ingested through the real
// descriptor ingest (P2-02), whose three builds' payload bytes are stored in R2 and referenced by
// the release, so the build route serves them with no GitHub call.

import { expect } from "vitest";
import { parseManifest } from "@polaris-key/manifest";
import { TranscriptRecorder, type World } from "../recorder.js";
import { DEVICE, downloadModel, T0, VERSION } from "../client.js";
import type { JsonValue } from "../format.js";
import {
  pinned,
  PRODUCT,
  productWorld,
  servicesOn,
  type Scenario,
} from "../world.js";
import { setDeliverableAccess } from "../../seed.js";
import { asR2, installDigestStream, R2Mock } from "../../r2Mock.js";
import { sha256Hex } from "../../releaseRoutesFixture.js";
import { blobKey, putVerified, recordObject } from "../../../src/core/blobs.js";
import { manifestDeliverableStatements } from "../../../src/services/release/deliverables.js";
import { ingestReleaseDescriptor } from "../../../src/services/release/descriptor.js";

/** License + Config + Release + Distribution: delivery that a licence can gate. */
const DELIVERY_ON = servicesOn("license", "config", "release", "distribution");

/** The one release every delivery transcript serves. */
export const RELEASE_VERSION = "1.0.0";

/** The app's declared builds: [buildId, platform, arch, format, file-name suffix]. */
const BUILDS: Array<[string, string, string, string, string]> = [
  ["linux-x64", "linux", "x86_64", "tar.gz", "linux-x86_64.tar.gz"],
  ["win-x64", "windows", "x86_64", "zip", "windows-x86_64.zip"],
  ["mac", "macos", "universal", "dmg", "macos.dmg"],
];

/** A build's payload: readable ASCII, so a transcript's byte bodies are plain strings. */
export function payloadOf(name: string): string {
  return `polaris-key transcript payload: ${name}\n`.repeat(2);
}

/** The payload a build serves, with its size and SHA-256 (what the release record pins). */
export function buildPayload(buildId: string): {
  name: string;
  text: string;
  size: number;
  sha256: string;
} {
  const row = BUILDS.find((b) => b[0] === buildId);
  if (!row) throw new Error(`no build ${buildId}`);
  const name = `djdl-${RELEASE_VERSION}-${row[4]}`;
  const text = payloadOf(name);
  const bytes = new TextEncoder().encode(text);
  return { name, text, size: bytes.length, sha256: sha256Hex(bytes) };
}

function appDeclaration() {
  const res = parseManifest({
    product: JSON.stringify({
      slug: PRODUCT,
      name: "djdl",
      modules: {
        license: { enabled: true },
        config: { enabled: true },
        release: { enabled: true },
        distribution: { enabled: true },
      },
    }),
    schema: JSON.stringify({ schemaVersion: 1, entries: [] }),
    release: JSON.stringify({
      release: {
        provider: { type: "github", owner: "acme", repo: "djdl" },
        binaryName: "djdl",
        deliverables: {
          app: {
            kind: "app",
            versioning: { scheme: "semver" },
            artifacts: BUILDS.map(([id, platform, arch, format, suffix]) => ({
              id,
              platform,
              arch,
              format,
              match: `djdl-*-${suffix}`,
            })),
          },
        },
      },
    }),
  });
  if (!res.ok) throw new Error(res.errors.join("\n"));
  return res.manifest.release!.app!;
}

/**
 * The delivery world: the app deliverable under `access` (`dist_access`), the `direct` outlet for
 * the three desktop platforms, and release 1.0.0 on `stable` with its payloads in R2.
 * `bytesOrigin` sets `BLOB_ORIGIN`: the download model lists only builds with an immutable URL on
 * the bytes host, while the build route also answers on the console host, where the recorder
 * sends its requests.
 */
export async function deliveryWorld(opts: {
  access: "public" | "licensed";
  bytesOrigin?: string;
}): Promise<World> {
  installDigestStream();
  const world = await productWorld(DELIVERY_ON);
  const r2 = new R2Mock();
  world.env.BLOBS = asR2(r2);
  if (opts.bytesOrigin) world.env.BLOB_ORIGIN = opts.bytesOrigin;
  await world.db.run(
    `INSERT INTO release_config
       (product, gh_owner, gh_repo, gh_installation_id, beta_branch, binary_name,
        summary_marker, metadata_access, artifacts_access)
     VALUES (?, 'acme', 'djdl', 42, 'main', 'djdl', 'pkey:summary', 'public', ?)`,
    PRODUCT,
    opts.access,
  );
  await world.db.batch(
    manifestDeliverableStatements(PRODUCT, appDeclaration(), T0),
  );
  await setDeliverableAccess(world.db, PRODUCT, "app", opts.access, null, T0);
  await world.db.run(
    `INSERT INTO dist_outlets
       (product, outlet_id, kind, identity_json, listing_json, created_at, modified_at)
     VALUES (?, 'direct', 'direct', ?, ?, ?, ?)`,
    PRODUCT,
    JSON.stringify({ platforms: ["macos", "windows", "linux"] }),
    JSON.stringify({ name: "djdl", subtitle: "Transcript fixture" }),
    T0,
    T0,
  );

  const promoted: string[] = [];
  const builds = [];
  for (const [id, platform, arch, format] of BUILDS) {
    const p = buildPayload(id);
    const bytes = new TextEncoder().encode(p.text);
    const key = blobKey(p.sha256);
    const put = await putVerified(asR2(r2), key, bytes, {
      sha256: p.sha256,
      size: p.size,
    });
    if (!put.ok) throw new Error(`put ${key}: ${put.reason}`);
    await recordObject(
      world.db,
      {
        storageKey: key,
        sha256: p.sha256,
        size: p.size,
        kind: "blob",
        gated: false,
      },
      T0,
    );
    promoted.push(key);
    builds.push({
      id,
      platform,
      arch,
      format,
      artifacts: [
        {
          name: p.name,
          role: "payload",
          sha256: p.sha256,
          size: p.size,
          locations: [{ provider: "r2", key }],
        },
      ],
    });
  }
  const res = await ingestReleaseDescriptor(
    world.db,
    world.env,
    PRODUCT,
    {
      descriptorVersion: 1,
      product: PRODUCT,
      deliverable: "app",
      kind: "app",
      version: RELEASE_VERSION,
      channel: "stable",
      title: `djdl ${RELEASE_VERSION}`,
      notes: "<!-- pkey:summary -->First release.<!-- /pkey:summary -->",
      publishedAt: new Date((T0 - 86_400) * 1000)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z"),
      builds,
    },
    { source: "ci", now: T0, promoted },
  );
  if (!res.ok) throw new Error(JSON.stringify(res));
  return world;
}

/** The bytes host the download model's build URLs point at. */
const BYTES_ORIGIN = "https://dl.plrs.im";

/** The device's platform: `current` is the model's group for it. */
const PLATFORM = "linux";

export const distributionDownloadModel: Scenario = {
  id: "distribution-download-model",
  record: () =>
    pinned("distribution-download-model", async (pin) => {
      const world = await deliveryWorld({
        access: "public",
        bytesOrigin: BYTES_ORIGIN,
      });
      const r = new TranscriptRecorder({
        id: "distribution-download-model",
        description:
          "The distribution model (P2b-06): downloadModel() is a plain public GET of /<p>/distribution/download.json, with no credential and no metadata headers. The client exposes the platform groups in the model's order, and the group for its own platform (initial.platform) as current, compared by value: the platform, its primary action, the actions, and the builds newest release first, each with its immutable bytes-host URL, size and SHA-256.",
        features: ["release.distribution"],
        requires: [],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: {
          deviceId: DEVICE,
          version: VERSION,
          services: ["license", "config", "release", "distribution"],
          platform: PLATFORM,
        },
      });
      // The expectation is the model the Worker served, read from the response rather than
      // restated: the step stores this object, and the drive fills it in.
      const outcome: Record<string, JsonValue> = { result: "ok" };
      await r.step(
        { action: "downloadModel" },
        async (s) => {
          const res = await downloadModel(s, PRODUCT);
          expect(res.status).toBe(200);
          const model = (await res.json()) as {
            platforms: Array<{ platform: string; builds: unknown[] }>;
          };
          const current = model.platforms.find((g) => g.platform === PLATFORM);
          expect(current?.builds.length).toBeGreaterThan(0);
          outcome.platforms = model.platforms.map((g) => g.platform);
          outcome.current = current as unknown as JsonValue;
        },
        outcome,
      );
      return r.transcript();
    }),
};
