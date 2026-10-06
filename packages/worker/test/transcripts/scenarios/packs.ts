/// <reference types="@cloudflare/workers-types" />
// packs-chunk-range: the chunk-bundle Range + If-Range fetch (P4-32, plans/P4-32.md §4;
// WIRE-CONTRACT-V4 §11.4 with §2.6, "bundles are blobs").
//
// A chunk run is ONE single-range request per run on the blob route, with
// `If-Range: "<bundle sha256>"`. The only answers that satisfy the strategy are a 206 with the
// exact `Content-Range: bytes <o>-<e>/<size>`, or a 206 clipped at the end of the object; any
// other answer fails it. The scenario records three of them through the real router:
//
//   1. the exact 206 for bytes 16-39 of a 64-byte bundle;
//   2. the 206 clipped at the end of the object (bytes 48-79 asked, 48-63 served);
//   3. the 200 (the whole object) the Worker answers when If-Range MISSES.
//
// ── THE IF-RANGE MISS (plans/P4-32.md Q1, option A) ─────────────────────────────────────────
//
// The blobs URL is content-addressed and every SDK derives its If-Range from that same hash, so
// no SDK can send a validator that misses. The recorder sends a stale one ("<64 zeros>") and the
// transcript asserts `if-range` by PRESENCE only: the scenario proves the Worker's 200, and the
// replay proves the SDK refuses a 200 to its own If-Range.
//
// ── THE FIXTURE (Q2, option A) ──────────────────────────────────────────────────────────────
//
// The bundle is 64 ASCII bytes, staged as a public pack object through the same CI uploads +
// stage routes the pack-transport suite uses. That path writes a `pack-upload` ref and never
// parses the content, so no real zstd bundle (and no binary transcript body) is needed: the
// content corpus already proves decoding (chunkIndexCases, chunk applyCases).

import { expect } from "vitest";
import { parseManifest } from "@polaris-key/manifest";
import { TranscriptRecorder, BASE_URL, type World } from "../recorder.js";
import { discovery, DEVICE, T0, VERSION } from "../client.js";
import { pinned, PRODUCT, servicesOn, type Scenario } from "../world.js";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import {
  makeEnv,
  seedProduct,
  setDeliverableAccess,
  stagePackObjects,
} from "../../seed.js";
import { asR2, installDigestStream, R2Mock } from "../../r2Mock.js";
import { setServices } from "../../../src/repo.js";
import { serializeServices } from "../../../src/core/services.js";
import { issueStaticCiToken } from "../../../src/core/publisher.js";
import { manifestDeliverableStatements } from "../../../src/services/release/deliverables.js";
import { manifestIngestStatements } from "../../../src/services/distribution/outlets.js";
import { reprDigest } from "../../../src/core/blobs.js";
import { dispatchWith } from "../../../src/dispatch.js";
import { releaseKeysJson } from "../../releaseKeysFixture.js";
import { sha256Hex } from "../../releaseRoutesFixture.js";

/** The pack whose bundle the conversation fetches from. */
const PACK = "djdl.levels";

/** The bundle: 64 ASCII bytes. Fetched ranges are their own substrings, readable in the file. */
const BUNDLE_TEXT =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";
const BUNDLE = new TextEncoder().encode(BUNDLE_TEXT);
const BUNDLE_SHA = sha256Hex(BUNDLE);
const ETAG = `"${BUNDLE_SHA}"`;

/** A validator that is not this object's ETag: what no content-addressed client can send. */
const STALE_IF_RANGE = `"${"0".repeat(64)}"`;

/** Release and Distribution, nothing else: the conversation is public pack bytes alone. */
const PACKS_ON = servicesOn("release", "distribution");

const RELEASE_DOC = {
  release: {
    provider: { type: "github", owner: "acme", repo: "djdl" },
    binaryName: "djdl",
    deliverables: {
      app: {
        kind: "app",
        versioning: { scheme: "semver" },
        content: { contentApi: 1 },
        artifacts: [
          {
            id: "macos",
            platform: "macos",
            arch: "universal",
            format: "dmg",
            match: "djdl-*-macos.dmg",
          },
        ],
      },
      [PACK]: { kind: "pack", type: "files.tree", delivery: "on-demand" },
    },
  },
};

const PRODUCT_DOC = {
  slug: PRODUCT,
  name: "djdl",
  modules: { release: { enabled: true }, distribution: { enabled: true } },
};

/** CI credentials for the uploads route: any well-formed parent R2 token. */
const R2_ENV = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_PARENT_ACCESS_KEY_ID: "parent-akid",
  R2_PARENT_SECRET_ACCESS_KEY: "parent-secret",
  BLOBS_BUCKET_NAME: "polaris-key-blobs-test",
};

/** A product serving one public pack object on the blob route. No `BLOB_ORIGIN`, so the blobs
 *  template stays on `https://key.plrs.im`. Setup requests are not recorded. */
async function packsWorld(): Promise<World> {
  installDigestStream();
  const db = makeTestDb();
  const kv = new KvMock();
  const env = makeEnv(kv, [PRODUCT]);
  const r2 = new R2Mock();
  env.BLOBS = asR2(r2);
  env.KEY_HASH_PEPPER = "pepper";
  Object.assign(env, R2_ENV);

  await seedProduct(db, PRODUCT);
  await setServices(
    db,
    PRODUCT,
    serializeServices({ services: PACKS_ON }),
    "manifest",
    T0,
  );
  await db.run(
    `INSERT INTO release_config
       (product, gh_owner, gh_repo, gh_installation_id, beta_branch, binary_name,
        summary_marker, metadata_access, artifacts_access, release_keys_json)
     VALUES (?, 'acme', 'djdl', 42, 'main', 'djdl', 'pkey:summary', 'public', 'public', ?)`,
    PRODUCT,
    releaseKeysJson(),
  );
  const parsed = parseManifest({
    product: JSON.stringify(PRODUCT_DOC),
    schema: JSON.stringify({ schemaVersion: 1, entries: [] }),
    release: JSON.stringify(RELEASE_DOC),
  });
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  const m = parsed.manifest;
  await db.batch([
    ...manifestDeliverableStatements(
      PRODUCT,
      m.release!.app,
      T0,
      m.release!.packDeliverables,
    ),
    ...manifestIngestStatements(m, PRODUCT, T0),
  ]);
  await setDeliverableAccess(db, PRODUCT, "app", "public", null, T0);
  await setDeliverableAccess(db, PRODUCT, PACK, "public", null, T0);

  const ciToken = (
    await issueStaticCiToken(env, db, {
      product: PRODUCT,
      scopes: ["release:publish"],
      expiresAt: T0 + 3600,
      label: null,
      createdBy: "u1",
      now: T0,
    })
  ).token;
  const post = (path: string, body: unknown) =>
    dispatchWith(
      new Request(`${BASE_URL}/${PRODUCT}/release/publish/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ciToken}`,
        },
        body: JSON.stringify(body),
      }) as unknown as Request,
      env,
      db,
      T0,
    );
  await stagePackObjects(post, r2, PACK, [
    { bytes: BUNDLE, sha256: BUNDLE_SHA },
  ]);
  return { db, kv, env };
}

/** The blob route path of the bundle. */
const BLOB_PATH = `/${PRODUCT}/distribution/blobs/sha256/${BUNDLE_SHA}`;

/** The server-side checks every blob answer gets as it records (not part of the transcript). */
function servedAsBlob(res: Response): void {
  expect(res.headers.get("etag")).toBe(ETAG);
  expect(res.headers.get("repr-digest")).toBe(reprDigest(BUNDLE_SHA));
  expect(res.headers.get("content-encoding")).toBeNull();
}

export const packsChunkRange: Scenario = {
  id: "packs-chunk-range",
  record: () =>
    pinned("packs-chunk-range", async (pin) => {
      const world = await packsWorld();
      const r = new TranscriptRecorder({
        id: "packs-chunk-range",
        description:
          'The chunk-bundle fetch (WIRE-CONTRACT-V4 §11.4): one single-range request per run on the blob route, with If-Range set to the bundle\'s own strong ETag. A 206 with the exact Content-Range, and a 206 clipped at the end of the object, satisfy the run. The 200 the Worker answers when If-Range misses (recorded with a stale validator, which no content-addressed client can send, so its if-range is asserted by presence only) is "any other answer" and must fail the strategy.',
        features: ["packs.apply.chunk"],
        requires: [],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: {
          deviceId: DEVICE,
          version: VERSION,
          services: ["release", "distribution"],
        },
      });

      await r.step(
        { action: "discover" },
        async (s) => {
          const res = await discovery(s, PRODUCT);
          expect(res.status).toBe(200);
          const doc = (await res.json()) as {
            services: { distribution: { endpoints: { blobs: string } } };
          };
          expect(doc.services.distribution.endpoints.blobs).toBe(
            `${BASE_URL}/${PRODUCT}/distribution/blobs/sha256/{sha256}`,
          );
        },
        {
          result: "ok",
          services: {
            license: false,
            config: false,
            release: true,
            distribution: true,
            update: false,
            identity: false,
            sync: false,
          },
        },
      );

      await r.step(
        {
          action: "chunkRange",
          note: "The exact 206: bytes 16-39 of the 64-byte bundle.",
          args: { bundle: BUNDLE_SHA, offset: 16, length: 24 },
        },
        async (s) => {
          const res = await s.send({
            method: "GET",
            path: BLOB_PATH,
            metadata: false,
            assertHeaders: { range: "bytes=16-39", "if-range": ETAG },
          });
          expect(res.status).toBe(206);
          expect(res.headers.get("content-range")).toBe("bytes 16-39/64");
          servedAsBlob(res);
          expect(await res.text()).toBe(BUNDLE_TEXT.slice(16, 40));
        },
        { range: "ok", bytes: BUNDLE_TEXT.slice(16, 40) },
      );

      await r.step(
        {
          action: "chunkRange",
          note: "A run past the end of the object: the 206 is clipped to bytes 48-63.",
          args: { bundle: BUNDLE_SHA, offset: 48, length: 32 },
        },
        async (s) => {
          const res = await s.send({
            method: "GET",
            path: BLOB_PATH,
            metadata: false,
            assertHeaders: { range: "bytes=48-79", "if-range": ETAG },
          });
          expect(res.status).toBe(206);
          expect(res.headers.get("content-range")).toBe("bytes 48-63/64");
          servedAsBlob(res);
          expect(await res.text()).toBe(BUNDLE_TEXT.slice(48));
        },
        { range: "ok", bytes: BUNDLE_TEXT.slice(48) },
      );

      await r.step(
        {
          action: "chunkRange",
          note: "If-Range misses (the recorder sent a stale validator): the Worker answers 200 with the whole object, which fails the strategy.",
          args: { bundle: BUNDLE_SHA, offset: 16, length: 24 },
        },
        async (s) => {
          const res = await s.send({
            method: "GET",
            path: BLOB_PATH,
            metadata: false,
            assertHeaders: { range: "bytes=16-39" },
            presentHeaders: { "if-range": STALE_IF_RANGE },
          });
          expect(res.status).toBe(200);
          expect(res.headers.get("content-range")).toBeNull();
          servedAsBlob(res);
          expect(await res.text()).toBe(BUNDLE_TEXT);
        },
        { range: "refused" },
      );

      return r.transcript();
    }),
};
