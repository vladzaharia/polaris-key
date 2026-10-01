/// <reference types="@cloudflare/workers-types" />
// update-feed-rollback and update-record-by-hash: the v4 update flow (P3-03, plans/P3-01.md §2.5,
// §6) — `client.update.decide({channel})` fetches the signed channel feed, verifies it against
// the product's keys and the canonical channel's `seq` floor, fetches the CI-signed release
// record the platform's target pins (by hash, from its cache when it holds it), verifies that
// against the release keys the app pins, and decides.
//
// Each `expect` is written by hand from §2.8, as every scenario's is: recording needs no
// `decideUpdate`, and every SDK's replayer checks it once its wave package teaches it
// `updateDecide` (P3-04 to P3-08; P3-05 for React).
//
// ── THE WORLD ───────────────────────────────────────────────────────────────────────────────
//
// One release, v1.3.0 (seq 1), with a universal macOS DMG build, published with a record signed
// by the corpus release key; the implicit `direct` outlet reports it live. The client is a macOS
// arm64 install of 1.2.0 (format `dmg`) on `direct`, which can only `download`, so the decision
// is `binary {method: "download"}` for build `macos`.

import { expect } from "vitest";
import { signJws } from "@polaris-key/jws";
import { TranscriptRecorder, type StepRecorder } from "../recorder.js";
import { DEVICE, T0, VERSION } from "../client.js";
import {
  pinned,
  PRODUCT,
  productWorld,
  servicesOn,
  type Scenario,
} from "../world.js";
import type { World } from "../recorder.js";
import type { JsonValue, UpdateInitial } from "../format.js";
import { TEST_KID, TEST_PEM } from "../../seed.js";
import {
  RELEASE_KID,
  RELEASE_PEM,
  RELEASE_PUB,
  releaseKeysJson,
} from "../../releaseKeysFixture.js";
import { seedDeliveryAccess } from "../../releaseSurface.js";
import { sha256HexOfAscii } from "../../../src/services/release/records.js";

const WITH_UPDATE = servicesOn(
  "license",
  "config",
  "release",
  "distribution",
  "update",
);

const PAYLOAD_SHA = "c".repeat(64);
const RELEASE_ID = "v1.3.0";

/** The CI-signed record of v1.3.0 (what `pkey release publish` would have submitted). */
const RECORD_PAYLOAD = {
  schemaVersion: 1,
  aud: PRODUCT,
  deliverable: "app",
  kind: "app",
  version: "1.3.0",
  seq: 1,
  issuedAt: T0 - 3600,
  tag: RELEASE_ID,
  channel: "stable",
  builds: [
    {
      id: "macos",
      platform: "macos",
      arch: "universal",
      format: "dmg",
      artifacts: [
        {
          name: "djdl-1.3.0-macos.dmg",
          role: "payload",
          sha256: PAYLOAD_SHA,
          size: 1000,
        },
      ],
    },
  ],
};

/** A world serving the feed: Release, Distribution and Update on, one recorded release. */
async function updateWorld(): Promise<{
  world: World;
  record: string;
  recordSha: string;
}> {
  const world = await productWorld(WITH_UPDATE);
  const record = await signJws(
    RECORD_PAYLOAD,
    RELEASE_PEM,
    RELEASE_KID,
    "pkey-release+jws",
  );
  const recordSha = await sha256HexOfAscii(record);
  const db = world.db;
  await db.run(
    `INSERT INTO release_config
       (product, gh_owner, gh_repo, gh_installation_id, beta_branch, binary_name,
        summary_marker, metadata_access, artifacts_access, release_keys_json)
     VALUES (?, 'acme', 'djdl', 42, 'main', 'djdl', 'pkey:summary', 'public', 'public', ?)`,
    PRODUCT,
    releaseKeysJson(),
  );
  await seedDeliveryAccess(db, PRODUCT, "public");
  await db.run(
    `INSERT INTO release_deliverables (product, deliverable_id, kind, def_json, def_source, created_at, modified_at)
     VALUES (?, 'app', 'app', ?, 'manifest', ?, ?)`,
    PRODUCT,
    JSON.stringify({
      kind: "app",
      versioning: { scheme: "semver", buildNumber: null },
      channels: {},
      artifacts: [
        {
          id: "macos",
          platform: "macos",
          arch: "universal",
          format: "dmg",
          role: "payload",
          match: "djdl-*-macos.dmg",
        },
      ],
    }),
    T0,
    T0,
  );
  await db.run(
    `INSERT INTO release_metadata
       (product, release_id, version, metadata_access, artifacts_access, published_at,
        metadata_json, created_at, modified_at, deliverable_id, seq, channel)
     VALUES (?, ?, '1.3.0', 'public', 'public', ?, ?, ?, ?, 'app', 1, 'stable')`,
    PRODUCT,
    RELEASE_ID,
    T0 - 3600,
    JSON.stringify({
      descriptor: {
        status: "ingested",
        sha256: "d".repeat(64),
        source: "ci",
        at: T0 - 3600,
      },
    }),
    T0 - 3600,
    T0 - 3600,
  );
  await db.run(
    `INSERT INTO release_builds (product, release_id, build_id, platform, arch, format, created_at, modified_at)
     VALUES (?, ?, 'macos', 'macos', 'universal', 'dmg', ?, ?)`,
    PRODUCT,
    RELEASE_ID,
    T0 - 3600,
    T0 - 3600,
  );
  await db.run(
    `INSERT INTO release_records
       (product, deliverable_id, release_id, seq, kind, record_sha256, kid, jws, ingested_at)
     VALUES (?, 'app', ?, 1, 'app', ?, ?, ?, ?)`,
    PRODUCT,
    RELEASE_ID,
    recordSha,
    RELEASE_KID,
    record,
    T0 - 3600,
  );
  await db.run(
    `INSERT INTO dist_outlets (product, outlet_id, kind, identity_json, created_at, modified_at)
     VALUES (?, 'direct', 'direct', '{}', ?, ?)`,
    PRODUCT,
    T0,
    T0,
  );
  // CI reported the release live on `direct` (P2b-03); a stored row wins over the derivation.
  await db.run(
    `INSERT INTO dist_availability
       (product, release_id, build_id, outlet_id, transport, state, since, source, updated_at)
     VALUES (?, ?, '', 'direct', 'pkey-cdn', 'live', ?, 'ci', ?)`,
    PRODUCT,
    RELEASE_ID,
    T0 - 3600,
    T0 - 3600,
  );
  return { world, record, recordSha };
}

/** The feed body a channel answers right now: the macOS target the Worker composes. */
function feedDoc(seq: number, issuedAt: number, recordSha: string) {
  return {
    schemaVersion: 1,
    iss: "key.plrs.im",
    aud: PRODUCT,
    channel: "stable",
    selector: {},
    seq,
    issuedAt,
    expiresAt: issuedAt + 900,
    app: {
      deliverable: "app",
      versionScheme: "semver",
      targets: [
        {
          platform: "macos",
          release: { sha256: recordSha, seq: 1, version: "1.3.0" },
          floor: null,
          critical: false,
          outlets: {
            direct: {
              kind: "direct",
              live: { version: "1.3.0", seq: 1 },
              halted: false,
            },
          },
        },
      ],
    },
  };
}

function initialUpdate(feeds: Record<string, string>): UpdateInitial {
  return {
    pinnedReleaseKeys: { [RELEASE_KID]: RELEASE_PUB },
    outlet: { id: "direct", kind: "direct" },
    platform: "macos",
    arch: "arm64",
    installed: {
      version: "1.2.0",
      buildNumber: null,
      format: "dmg",
      engine: null,
    },
    methods: ["download"],
    cache: { feeds, releaseRecords: {} },
  };
}

/** The decision both transcripts reach: download v1.3.0's universal macOS build. */
function binaryDownload(recordSha: string): JsonValue {
  return {
    action: "binary",
    method: "download",
    release: { version: "1.3.0", seq: 1, sha256: recordSha },
    build: "macos",
    mandatory: false,
    critical: false,
    prestage: [],
    discardStaged: false,
  };
}

function getFeed(s: StepRecorder, channel: string): Promise<Response> {
  return s.send({
    method: "GET",
    path: `/${PRODUCT}/update/${channel}/feed.jws?platform=macos`,
    metadata: false,
  });
}

function getRecord(s: StepRecorder, sha256: string): Promise<Response> {
  return s.send({
    method: "GET",
    path: `/${PRODUCT}/release/records/${sha256}`,
    metadata: false,
  });
}

export const updateFeedRollback: Scenario = {
  id: "update-feed-rollback",
  record: () =>
    pinned("update-feed-rollback", async (pin) => {
      const { world, record, recordSha } = await updateWorld();
      // The Worker's `stable` row sits at seq 6 with other content, so the next request signs
      // seq 7. The client already committed a seq 8 feed of `stable` (same key, still fresh).
      await world.db.run(
        `INSERT INTO update_feed_state (product, channel, seq, content_sha256) VALUES (?, 'stable', 6, ?)`,
        PRODUCT,
        "0".repeat(64),
      );
      const committed = await signJws(
        feedDoc(8, T0 - 60, recordSha),
        TEST_PEM,
        TEST_KID,
        "pkey-feed+jws",
      );
      const r = new TranscriptRecorder({
        id: "update-feed-rollback",
        description:
          "The v4 update decision when the network answers with an OLDER feed. The client requests `latest`; the Worker signs the canonical channel `stable` at seq 7, but the client already committed a seq 8 feed of `stable`. The floor is looked up by the feed's own channel claim (`stable`), never by the requested name, so seq 7 is refused as feed-rollback, the decision comes from the committed seq 8 feed, and the record its macOS target pins is fetched by hash and verified against the pinned release key. A client that keyed floors by the requested name would find no floor for `latest`, commit seq 7 and fail.",
        features: ["update.feed", "update.decide"],
        requires: ["core.store", "release.record"],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: {
          deviceId: DEVICE,
          version: VERSION,
          services: ["release", "distribution", "update"],
          update: initialUpdate({ stable: committed }),
        },
      });
      await r.step(
        {
          action: "updateDecide",
          args: { channel: "latest" },
          note: "seq 7 < the committed seq 8: feed-rollback; decide from the committed feed.",
        },
        async (s) => {
          const feed = await getFeed(s, "latest");
          expect(feed.status).toBe(200);
          const body = await feed.text();
          const payload = JSON.parse(
            Buffer.from(body.split(".")[1]!, "base64url").toString("utf8"),
          ) as { seq: number; channel: string };
          expect(payload).toMatchObject({ seq: 7, channel: "stable" });
          const rec = await getRecord(s, recordSha);
          expect(rec.status).toBe(200);
          expect(await rec.text()).toBe(record);
        },
        {
          channel: "stable",
          feed: "committed",
          record: "network",
          errors: [{ code: "feed-rollback", detail: null }],
          decision: binaryDownload(recordSha),
        },
      );
      return r.transcript();
    }),
};

export const updateRecordByHash: Scenario = {
  id: "update-record-by-hash",
  record: () =>
    pinned("update-record-by-hash", async (pin) => {
      const { world, record, recordSha } = await updateWorld();
      const r = new TranscriptRecorder({
        id: "update-record-by-hash",
        description:
          "The v4 update decision, twice. First call: the client fetches the signed `stable` feed, commits it, fetches the release record its macOS target pins by the record's SHA-256 (hash before signature), verifies it against the pinned release key and decides to download v1.3.0. Second call: the Worker answers the same feed bytes, so nothing changed; the record comes from the client's verified cache and no record request is made.",
        features: ["release.record", "update.decide"],
        requires: ["core.store", "update.feed"],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: {
          deviceId: DEVICE,
          version: VERSION,
          services: ["release", "distribution", "update"],
          update: initialUpdate({}),
        },
      });
      let first = "";
      await r.step(
        { action: "updateDecide", args: { channel: "stable" } },
        async (s) => {
          const feed = await getFeed(s, "stable");
          expect(feed.status).toBe(200);
          first = await feed.text();
          const rec = await getRecord(s, recordSha);
          expect(rec.status).toBe(200);
          expect(await rec.text()).toBe(record);
        },
        {
          channel: "stable",
          feed: "network",
          record: "network",
          errors: [],
          decision: binaryDownload(recordSha),
        },
      );
      await r.step(
        {
          action: "updateDecide",
          args: { channel: "stable" },
          now: T0 + 60,
          note: "The same feed bytes: decide from the committed feed; the record is cached.",
        },
        async (s) => {
          const feed = await getFeed(s, "stable");
          expect(feed.status).toBe(200);
          expect(await feed.text()).toBe(first);
        },
        {
          channel: "stable",
          feed: "network",
          record: "cache",
          errors: [],
          decision: binaryDownload(recordSha),
        },
      );
      return r.transcript();
    }),
};
