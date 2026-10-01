// @pkey-feature update.feed release.record update.decide
//
// Cross-SDK update-decision parity over `conformance/corpus/v2/update-matrix.json`
// (plans/P3-01.md §2.8, §4.6) — the projection suite. The decision itself is proven row for row
// by `conformance/runners/node/corpusV2.test.ts` through `@polaris-key/client-core`; what only
// this file can prove is that the NODE SDK's wiring feeds it the right inputs.
//
// Every row runs end to end through `PolarisKeyClient.update.decide()`: its feed and record are
// signed with the corpus keys, served by a fake v4 Worker at the discovery endpoints, fetched,
// verified, committed and decided. The row's installed state is PROJECTED onto client options:
//
//   installed.version              → CoreOptions.version
//   installed.binaryVersion, buildNumber, platform, arch, format, engine
//                                  → update.{binaryVersion, buildNumber, platform, arch, format, engine}
//   outlet {id, kind} + subkind    → update.outlet {id, kind, subkind} (an id), else
//                                    update.detected {kind, subkind} (no id)
//   methods                        → update.methods
//   staged, skipVersion            → decide()'s arguments
//   now                            → the system clock (the effective clock, with no floor)
//   bucket                         → the store's device id (the corpus device, or none)
//
// so a wrong mapping fails its row. A stale row decides from the committed feed (seeded in the
// store), as §2.5 says it must after a refusal. A row's record is re-signed, so its hash changes:
// the feed pins the new hash, and an expected `release.sha256` that named the old one names the
// new one. Nothing else in a row changes.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootDecision,
  recordHash,
  rolloutBucket,
} from "@polaris-key/client-core";
import type {
  ChannelFeedDoc,
  UpdateDecision,
  UpdateDecisionInput,
} from "@polaris-key/protocol/update";
import { PolarisKeyClient } from "../src/client.js";
import type { UpdateClientOptions } from "../src/update/client.js";
import {
  BASE,
  MemStore,
  PINS,
  PRODUCT,
  RELEASE_KEYS,
  V4_SERVICES,
  fakeWorker,
  readCorpus,
  signFeed,
  signRecord,
} from "./updateFixtures.js";

interface Row {
  name: string;
  input: UpdateDecisionInput;
  expect: { decision: UpdateDecision; boot: string };
}

const matrix = readCorpus<{ rows: Row[] }>("update-matrix.json");
const CORPUS_DEVICE = "dev_7c1e2d";
const CORPUS_SALT = "00112233445566778899aabbccddeeff";

afterEach(() => {
  vi.useRealTimers();
});

interface Signed {
  feed: ChannelFeedDoc;
  feedJws: string;
  recordJws: string | null;
  recordHash: string | null;
  expected: UpdateDecision;
}

/** Re-sign a row's feed and record, pinning the new record hash. */
async function signRow(row: Row): Promise<Signed> {
  const feed = structuredClone(row.input.feed);
  const platform = row.input.installed.platform;
  const target = feed.app.targets.find((t) => t.platform === platform);
  let expected = structuredClone(row.expect.decision);
  let recordJws: string | null = null;
  let hash: string | null = null;
  if (row.input.record) {
    recordJws = await signRecord(row.input.record);
    hash = await recordHash(recordJws);
    const old = target?.release.sha256;
    if (old) {
      for (const t of feed.app.targets)
        if (t.release.sha256 === old) t.release.sha256 = hash;
      if (
        (expected.action === "binary" || expected.action === "code-ready") &&
        expected.release.sha256 === old
      )
        expected = {
          ...expected,
          release: { ...expected.release, sha256: hash },
        };
    }
  }
  const feedJws = await signFeed(feed);
  return { feed, feedJws, recordJws, recordHash: hash, expected };
}

const isStale = (row: Row): boolean =>
  row.input.now >= row.input.feed.expiresAt + 300;

const hasRollout = (row: Row): boolean => {
  const t = row.input.feed.app.targets.find(
    (x) => x.platform === row.input.installed.platform,
  );
  return Object.values(t?.outlets ?? {}).some((e) => e.rollout !== undefined);
};

/** The row's installed state and outlet as the host's `update` options. */
function project(row: Row): UpdateClientOptions {
  const { installed, outlet, subkind, methods } = row.input;
  return {
    pinnedReleaseKeys: RELEASE_KEYS,
    ...(outlet.id !== null
      ? {
          outlet: {
            id: outlet.id,
            kind: outlet.kind as never,
            subkind: subkind as never,
          },
        }
      : {
          detected: {
            kind: outlet.kind as never,
            confidence: null,
            source: null,
            subkind: subkind as never,
          },
        }),
    ...(installed.binaryVersion !== undefined
      ? { binaryVersion: installed.binaryVersion }
      : {}),
    buildNumber: installed.buildNumber,
    platform: installed.platform as never,
    arch: installed.arch as never,
    format: installed.format,
    engine: installed.engine,
    methods: [...methods],
  };
}

describe(`update-matrix rows through client.update.decide() (${matrix.rows.length})`, () => {
  it("has every row of plans/P3-01.md §4.6", () => {
    expect(matrix.rows.length).toBe(65);
  });

  for (const row of matrix.rows) {
    it(row.name, async () => {
      const s = await signRow(row);
      const inp = row.input;
      const stale = isStale(row);
      vi.useFakeTimers({ toFake: ["Date"], now: inp.now * 1000 });

      // The bucket comes from the device id; a row with a rollout and no bucket has none.
      const noDevice = hasRollout(row) && inp.bucket === null;
      if (hasRollout(row) && inp.bucket !== null)
        expect(await rolloutBucket(CORPUS_SALT, CORPUS_DEVICE)).toBe(
          inp.bucket,
        );
      const store = new MemStore(
        noDevice ? "" : CORPUS_DEVICE,
        stale ? { v: 3, feeds: { [s.feed.channel]: s.feedJws } } : null,
      );
      const worker = fakeWorker({
        // A stale feed fails freshness on the network: the decision comes from the cache.
        feeds: () => (stale ? 503 : s.feedJws),
        records:
          s.recordHash && s.recordJws ? { [s.recordHash]: s.recordJws } : {},
      });

      const client = await PolarisKeyClient.create({
        productSlug: PRODUCT,
        baseUrl: BASE,
        version: inp.installed.version,
        trust: { pinnedKeys: PINS },
        store,
        fetchImpl: worker.fetch,
        requestTimeoutMs: 0,
        expectedServices: [...V4_SERVICES],
        update: project(row),
      });
      const check = await client.update.decide({
        channel: s.feed.channel,
        staged: inp.staged,
        skipVersion: inp.skipVersion,
      });
      client.close();

      expect(check.decision).toEqual(s.expected);
      expect(bootDecision(check.decision)).toBe(row.expect.boot);
      expect(check.channel).toBe(s.feed.channel);
      expect(check.feed).toBe(stale ? "committed" : "network");
      // A stale row's feed fetch fails (503, no wire code); a pinned record the Worker does not
      // hold answers 404 with its wire code, and the decision goes on without it.
      const pinned = s.feed.app.targets.some(
        (t) => t.platform === inp.installed.platform,
      );
      expect(check.errors).toEqual([
        ...(stale ? [{ code: "network-error", detail: null }] : []),
        ...(pinned && !s.recordJws
          ? [{ code: "not_found", detail: null }]
          : []),
      ]);
      const feedUrl = worker.calls.find((c) => c.url.includes("/feed.jws"));
      expect(feedUrl?.url).toBe(
        `${BASE}/${PRODUCT}/update/${s.feed.channel}/feed.jws?platform=${inp.installed.platform}`,
      );
      // The slices persisted are signed artifacts only: the committed feed, and the record
      // only while that feed pins it.
      expect(store.cache?.feeds).toEqual({ [s.feed.channel]: s.feedJws });
      if (s.recordHash && check.record !== "none")
        expect(store.cache?.releaseRecords).toEqual({
          [s.recordHash]: s.recordJws,
        });
    });
  }
});
