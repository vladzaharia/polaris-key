// @vitest-environment node
//
// Runs in the NODE environment, like bundleImport.test.ts: under jsdom, `TextEncoder` output is a
// typed array from another realm and WebCrypto's Ed25519 `verify` rejects every signature.
//
// @pkey-feature update.feed release.record update.decide
// Cross-SDK update-decision parity over `conformance/corpus/v2/update-matrix.json`
// (plans/P3-01.md §2.8, §4.6), the pattern of `gateMatrixParity.test.ts`. The decision itself is
// proven row for row by `conformance/runners/node/corpusV2.test.ts` through
// `@polaris-key/client-core`; what only this file can prove is that the React ADAPTERS feed it the
// right inputs.
//
//   browser   every row end to end: the row's feed and record are signed with throwaway keys,
//             served from a fake Worker at the discovery endpoints, fetched, verified, committed
//             and decided by `BrowserAdapter.decideUpdate()`. The installed build, the outlet
//             (through `resolveUpdateOutlet`), the methods, the staged update, the skipped
//             version, the clock and the rollout bucket (from the page's device id) all come from
//             the adapter's options and arguments, so a wrong mapping fails its row. A stale row
//             decides from the committed feed, as §2.5 says it must after a refusal.
//   desktop   every row through `invoke("update", "decide", …)`: the renderer forwards the three
//             arguments and reports the host's `UpdateCheck` unchanged.
//
// A row's record is re-signed, so its hash changes: the feed pins the new hash, and an expected
// `release.sha256` that named the old one names the new one. Nothing else in a row changes.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  bootDecision,
  decideUpdate,
  recordHash,
  rolloutBucket,
} from "@polaris-key/client-core";
import type {
  ChannelFeedDoc,
  UpdateCheck,
  UpdateDecision,
  UpdateDecisionInput,
} from "@polaris-key/protocol/update";
import { BrowserAdapter } from "../src/browser/browserAdapter.js";
import type { OfflineRecord, OfflineStore } from "../src/browser/offline.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import type { PolarisBridge } from "../src/desktop/bridge.js";
import {
  makeFakeBridge,
  newTestKey,
  okBridgeState,
  services,
  signCompact,
  type TestKey,
} from "./fixtures.js";

interface Row {
  name: string;
  input: UpdateDecisionInput;
  expect: { decision: UpdateDecision; boot: string };
}

const here = dirname(fileURLToPath(import.meta.url));
const matrix = JSON.parse(
  readFileSync(
    join(
      here,
      "..",
      "..",
      "..",
      "conformance",
      "corpus",
      "v2",
      "update-matrix.json",
    ),
    "utf8",
  ),
) as { rows: Row[] };

const PRODUCT = "djdl";
const BASE = "https://key.plrs.im";
const CORPUS_DEVICE = "dev_7c1e2d";

let productKey: TestKey;
let releaseKey: TestKey;

beforeAll(async () => {
  productKey = await newTestKey("djdl-test-2026");
  releaseKey = await newTestKey("djdl-release-test-2026");
});

/** The discovery document of a v4 Worker: the feed and record endpoints, and the builds route. */
function discovery(): string {
  return JSON.stringify({
    version: 2,
    protocolVersion: 4,
    product: PRODUCT,
    baseUrl: BASE,
    services: {
      license: { enabled: false },
      config: { enabled: false },
      release: {
        enabled: true,
        endpoints: { record: `${BASE}/${PRODUCT}/release/records/{sha256}` },
      },
      update: {
        enabled: true,
        endpoints: {
          version: `${BASE}/${PRODUCT}/update/version`,
          feed: `${BASE}/${PRODUCT}/update/{channel}/feed.jws`,
        },
      },
      distribution: {
        enabled: true,
        endpoints: {
          builds: `${BASE}/${PRODUCT}/distribution/builds/{selector}/{buildId}`,
        },
      },
      identity: { enabled: false },
    },
  });
}

/** An in-memory `OfflineStore`. */
function memoryStore(seed?: OfflineRecord): OfflineStore & {
  records: Map<string, OfflineRecord>;
} {
  const records = new Map<string, OfflineRecord>();
  if (seed) records.set(PRODUCT, seed);
  return {
    records,
    async read(product) {
      return records.get(product) ?? null;
    },
    async write(product, record) {
      records.set(product, structuredClone(record));
    },
  };
}

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
    recordJws = await signCompact(
      row.input.record,
      releaseKey,
      "pkey-release+jws",
    );
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
  const feedJws = await signCompact(feed, productKey, "pkey-feed+jws");
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

describe(`update-matrix rows through the browser adapter (${matrix.rows.length})`, () => {
  for (const row of matrix.rows) {
    it(row.name, async () => {
      const s = await signRow(row);
      const inp = row.input;
      const stale = isStale(row);
      const seen: string[] = [];
      const fetchImpl = (async (input: RequestInfo | URL) => {
        const url = String(input);
        seen.push(url);
        if (url.endsWith("/.well-known/polaris.json"))
          return new Response(discovery(), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        if (url.includes("/update/") && url.includes("/feed.jws")) {
          // A stale feed fails freshness on the network: the decision comes from the cache.
          if (stale) return new Response("unavailable", { status: 503 });
          return new Response(s.feedJws, { status: 200 });
        }
        if (s.recordHash && url.endsWith(`/release/records/${s.recordHash}`))
          return new Response(s.recordJws, { status: 200 });
        if (url.includes("/release/records/"))
          return new Response("nf", { status: 404 });
        return new Response(null, { status: 401 });
      }) as unknown as typeof fetch;

      // The bucket comes from the page's device id; a row with a rollout and no bucket has none.
      const noDevice = hasRollout(row) && inp.bucket === null;
      if (hasRollout(row) && inp.bucket !== null)
        expect(
          await rolloutBucket(
            "00112233445566778899aabbccddeeff",
            CORPUS_DEVICE,
          ),
        ).toBe(inp.bucket);
      const store = noDevice
        ? null
        : memoryStore({
            deviceId: CORPUS_DEVICE,
            ...(stale
              ? { cache: { v: 3, feeds: { [s.feed.channel]: s.feedJws } } }
              : {}),
          });

      const { version, ...installed } = inp.installed;
      const outlet = inp.outlet;
      const adapter = new BrowserAdapter({
        auth: "cookie",
        productSlug: PRODUCT,
        baseUrl: BASE,
        fetchImpl,
        now: () => inp.now,
        version,
        trust: { pinnedKeys: { [productKey.kid]: productKey.raw } },
        offlineStore: store,
        update: {
          pinnedReleaseKeys: { [releaseKey.kid]: releaseKey.raw },
          ...(outlet.id !== null
            ? {
                outlet: {
                  id: outlet.id,
                  kind: outlet.kind as never,
                  subkind: inp.subkind as never,
                },
              }
            : {
                stamp: {},
                detected: {
                  kind: outlet.kind as never,
                  confidence: null,
                  source: null,
                  subkind: inp.subkind as never,
                },
              }),
          installed,
          methods: [...inp.methods],
        },
      });

      const check = await adapter.decideUpdate({
        channel: s.feed.channel,
        staged: inp.staged,
        skipVersion: inp.skipVersion,
      });
      expect(check.decision).toEqual(s.expected);
      expect(bootDecision(check.decision)).toBe(row.expect.boot);
      expect(check.channel).toBe(s.feed.channel);
      expect(check.feed).toBe(stale ? "committed" : "network");
      const feedUrl = seen.find((u) => u.includes("/feed.jws"));
      expect(feedUrl).toBe(
        `${BASE}/${PRODUCT}/update/${s.feed.channel}/feed.jws?platform=${inp.installed.platform}`,
      );
      adapter.dispose();
    });
  }
});

describe(`update-matrix rows through the desktop bridge (${matrix.rows.length})`, () => {
  for (const row of matrix.rows) {
    it(row.name, async () => {
      const answer: UpdateCheck = {
        channel: row.input.feed.channel,
        decision: decideUpdate(row.input),
        feed: "network",
        record: row.input.record ? "network" : "none",
        errors: [],
      };
      const invoke = vi.fn(async () => answer);
      const bridge = makeFakeBridge(
        okBridgeState({ capabilities: services("update") }),
      );
      bridge.invoke = invoke as PolarisBridge["invoke"];
      const adapter = desktopAdapter({
        bridge,
        expectServices: services("update"),
      });
      const args = {
        channel: row.input.feed.channel,
        staged: row.input.staged,
        skipVersion: row.input.skipVersion,
      };
      const check = await adapter.decideUpdate(args);
      expect(invoke).toHaveBeenCalledWith("update", "decide", args);
      expect(check).toEqual(answer);
      expect(check.decision).toEqual(row.expect.decision);
      expect(bootDecision(check.decision)).toBe(row.expect.boot);
      adapter.dispose();
    });
  }
});
