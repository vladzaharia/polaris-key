// @pkey-feature update.feed release.record
//
// Every `feedCases` and `releaseRecordCases` vector of `conformance/corpus/v2/cases.json`
// (plans/P3-01.md §4.4, §4.5) replayed through the Node SDK's OWN wiring — `client.update.feed()`
// and `client.update.releaseRecord()` over a fake Worker — rather than through client-core
// directly (the Node runner does that). What this proves is the mapping: the trust set the client
// hands the verifier, the requested channel, the platform, the effective clock, the floors, and
// how each verdict surfaces.
//
// FEEDS. A case's `trust` is the client's pins and its `now` the system clock. Its `floors` map
// cannot be stored as numbers (V3 §4.1: signed artifacts only), so each floor is a committed feed
// signed with the corpus key for that channel, at that `seq` and `issuedAt`; the client derives
// the floor from it on the reload path. A network case (`checkFreshness: true`) serves its JWS as
// the feed answer:
//
//   ok           → committed, `source: "network"`, the expected `seq` and `issuedAt`;
//   not-newer    → the committed floor feed is used, nothing reported;
//   rollback     → the committed floor feed is used, `feed-rollback` in `errors`;
//   any refusal  → `feed-rejected` with the step as `detail`: in `errors` when a committed feed is
//                  left to decide from, raised when none is.
//
// A reload case (`checkFreshness: false`) is seeded as the committed feed and the network fails:
// `ok` means the client decides from it; a refusal means the reload path dropped it, so nothing is
// left and the transport failure is raised.
//
// RECORDS. A case's `releaseKeys` are `update.pinnedReleaseKeys` and its `productTrust` the pins.
// When it has a `pin`, a committed feed pinning `expectedHash` with that version and `seq` is
// seeded, so the client cross-checks against it (step 15); without one, the record is verified
// only. `record-release-key-is-product-key` cannot be configured as stated (a release key that is
// also a trust PIN is refused at construction, `invalid-options`, tested in
// updateDecide.test.ts), so there the overlapping key reaches the effective trust set the way a
// real rotation would: through a verified trust manifest.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ISSUER } from "@polaris-key/protocol/core";
import type { CacheRecordV3 } from "@polaris-key/client-core";
import { PolarisKeyClient } from "../src/client.js";
import { UpdateError } from "../src/update/client.js";
import {
  BASE,
  MemStore,
  PRODUCT,
  PRODUCT_KID,
  RELEASE_KEYS,
  V4_SERVICES,
  corpusKey,
  fakeWorker,
  feedPayload,
  readCorpus,
  sign,
  signFeed,
} from "./updateFixtures.js";

type TrustSet = Record<string, string>;

interface FeedCase {
  id: string;
  description: string;
  jws: string;
  trust: TrustSet;
  expectedAud: string;
  channel: string;
  platform: string;
  now: number;
  checkFreshness: boolean;
  floors?: Record<string, { seq: number; issuedAt: number }>;
  expect:
    | { verify: "ok"; seq: number; issuedAt: number; doc?: unknown }
    | { verify: "fail"; reason: string };
}

interface RecordCase {
  id: string;
  description: string;
  jws: string;
  releaseKeys: TrustSet;
  productTrust: TrustSet;
  expectedAud: string;
  expectedHash: string;
  pin?: { deliverable: string; version: string; seq: number };
  expect:
    | { verify: "ok"; kind: string; doc?: unknown }
    | { verify: "fail"; step: string };
}

const corpus = readCorpus<{
  feedCases: FeedCase[];
  releaseRecordCases: RecordCase[];
}>("cases.json");

const FAR = "f".repeat(64);
const FOUR_PART = /^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){3}$/;

afterEach(() => {
  vi.useRealTimers();
});

async function feedClient(
  c: { trust: TrustSet; platform: string; now: number; aud: string },
  cache: CacheRecordV3 | null,
  feeds: (channel: string) => string | number,
) {
  vi.useFakeTimers({ toFake: ["Date"], now: c.now * 1000 });
  const store = new MemStore("dev_corpus", cache);
  const worker = fakeWorker({ feeds });
  const client = await PolarisKeyClient.create({
    productSlug: c.aud,
    baseUrl: BASE,
    version: "1.0.0",
    trust: { pinnedKeys: c.trust },
    store,
    fetchImpl: worker.fetch,
    requestTimeoutMs: 0,
    expectedServices: [...V4_SERVICES],
    update: {
      pinnedReleaseKeys: RELEASE_KEYS,
      platform: c.platform as never,
      arch: "arm64",
    },
  });
  return { client, store, worker };
}

async function floorFeeds(c: FeedCase): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [channel, floor] of Object.entries(c.floors ?? {}))
    out[channel] = await signFeed(
      feedPayload({
        channel,
        seq: floor.seq,
        issuedAt: floor.issuedAt,
        platform: c.platform,
        sha256: FAR,
      }),
    );
  return out;
}

async function settle<T>(p: Promise<T>): Promise<T | UpdateError> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof UpdateError) return e;
    throw e;
  }
}

describe(`feedCases through client.update.feed() (${corpus.feedCases.length})`, () => {
  it("has every feed case of plans/P3-01.md §4.4", () => {
    expect(corpus.feedCases.length).toBe(77);
  });

  for (const c of corpus.feedCases) {
    const want = c.expect.verify === "ok" ? "ok" : c.expect.reason;
    it(`${c.id} → ${want}`, async () => {
      const ctx = {
        trust: c.trust,
        platform: c.platform,
        now: c.now,
        aud: c.expectedAud,
      };
      if (!c.checkFreshness) {
        // The reload path: the case's JWS is the committed feed, and the network is down.
        const { client } = await feedClient(
          ctx,
          { v: 3, feeds: { [c.channel]: c.jws } },
          () => 503,
        );
        const got = await settle(client.update.feed({ channel: c.channel }));
        client.close();
        if (c.expect.verify === "ok") {
          expect(got, c.description).not.toBeInstanceOf(UpdateError);
          if (got instanceof UpdateError) return;
          expect(got.source).toBe("committed");
          expect(got.feed.seq).toBe(c.expect.seq);
          expect(got.feed.issuedAt).toBe(c.expect.issuedAt);
          expect(got.errors).toEqual([{ code: "network-error", detail: null }]);
          if (c.expect.doc !== undefined)
            expect(got.feed).toEqual(c.expect.doc);
        } else {
          expect(got, c.description).toBeInstanceOf(UpdateError);
          expect((got as UpdateError).code).toBe("network-error");
        }
        return;
      }

      const floors = await floorFeeds(c);
      const { client, store } = await feedClient(
        ctx,
        Object.keys(floors).length > 0 ? { v: 3, feeds: floors } : null,
        () => c.jws,
      );
      const got = await settle(client.update.feed({ channel: c.channel }));
      client.close();

      if (c.expect.verify === "ok") {
        expect(got, c.description).not.toBeInstanceOf(UpdateError);
        if (got instanceof UpdateError) return;
        expect(got.source).toBe("network");
        expect(got.errors).toEqual([]);
        expect(got.feed.seq).toBe(c.expect.seq);
        expect(got.feed.issuedAt).toBe(c.expect.issuedAt);
        if (c.expect.doc !== undefined) expect(got.feed).toEqual(c.expect.doc);
        // Committed under its own claim, the canonical channel.
        expect(got.channel).toBe(got.feed.channel);
        expect(store.cache?.feeds?.[got.feed.channel]).toBe(c.jws);
        return;
      }

      const reason = c.expect.reason;
      const error =
        reason === "not-newer"
          ? null
          : reason === "rollback"
            ? { code: "feed-rollback", detail: null }
            : { code: "feed-rejected", detail: reason };
      if (got instanceof UpdateError) {
        // Nothing committed to fall back to: the refusal is raised.
        expect(
          error,
          `${c.id} raised although nothing should be`,
        ).not.toBeNull();
        expect({ code: got.code, detail: got.detail }).toEqual(error);
        expect(Object.keys(floors)).toEqual([]);
        return;
      }
      // A committed feed was left: the decision uses it, and the refusal is reported.
      expect(got.source, c.description).toBe("committed");
      expect(got.errors).toEqual(error ? [error] : []);
      expect(floors[got.channel]).toBeDefined();
      expect(store.cache?.feeds?.[got.channel]).toBe(floors[got.channel]);
    });
  }
});

/** A trust manifest, signed by `signer` (a pin), that publishes `kid`'s key. */
async function manifestPublishing(kid: string, signer: string, at: number) {
  return sign(
    {
      schemaVersion: 1,
      aud: PRODUCT,
      iss: ISSUER,
      issuedAt: at,
      expiresAt: at + 300,
      jwksUrl: `${BASE}/${PRODUCT}/.well-known/jwks.json`,
      cacheSeconds: 300,
      keys: [
        {
          kid,
          alg: "EdDSA",
          kty: "OKP",
          crv: "Ed25519",
          publicKey: corpusKey(kid).publicKeyRaw,
          status: "active",
        },
      ],
    },
    signer,
    "pkey-trust+jws",
  );
}

describe(`releaseRecordCases through client.update.releaseRecord() (${corpus.releaseRecordCases.length})`, () => {
  it("has every record case of plans/P3-01.md §4.5", () => {
    expect(corpus.releaseRecordCases.length).toBe(49);
  });

  for (const c of corpus.releaseRecordCases) {
    const want = c.expect.verify === "ok" ? "ok" : c.expect.step;
    it(`${c.id} → ${want}`, async () => {
      const now = 1_700_000_100;
      vi.useFakeTimers({ toFake: ["Date"], now: now * 1000 });
      const releaseRaw = new Set(Object.values(c.releaseKeys));
      // The pins: the product trust set, less any key that is also a release key (construction
      // refuses that overlap); such a key reaches the EFFECTIVE set through a trust manifest.
      const pins: TrustSet = {};
      const viaManifest: string[] = [];
      for (const [kid, key] of Object.entries(c.productTrust))
        if (releaseRaw.has(key)) viaManifest.push(kid);
        else pins[kid] = key;
      const signer =
        Object.keys(pins).find((k) => k !== PRODUCT_KID) ?? PRODUCT_KID;
      const cache: CacheRecordV3 = { v: 3 };
      if (viaManifest.length === 1)
        cache.trustJws = await manifestPublishing(
          viaManifest[0]!,
          signer,
          now - 60,
        );
      // The pin, through a committed feed (a feed can pin only a lowercase hex hash).
      const pinned = !!c.pin && /^[0-9a-f]{64}$/.test(c.expectedHash);
      if (pinned) {
        const feed = feedPayload({
          seq: 3,
          issuedAt: now - 60,
          sha256: c.expectedHash,
          version: c.pin!.version,
          recordSeq: c.pin!.seq,
        });
        if (FOUR_PART.test(c.pin!.version)) feed.app.versionScheme = "4part";
        cache.feeds = { stable: await signFeed(feed, signer) };
      }

      const worker = fakeWorker({ records: { [c.expectedHash]: c.jws } });
      const client = await PolarisKeyClient.create({
        productSlug: c.expectedAud,
        baseUrl: BASE,
        version: "1.0.0",
        trust: { pinnedKeys: pins },
        store: new MemStore("dev_corpus", cache),
        fetchImpl: worker.fetch,
        requestTimeoutMs: 0,
        expectedServices: [...V4_SERVICES],
        update: {
          pinnedReleaseKeys: c.releaseKeys,
          platform: "macos",
          arch: "arm64",
        },
      });
      const got = await settle(client.update.releaseRecord(c.expectedHash));
      client.close();

      if (c.expect.verify === "ok") {
        expect(got, c.description).not.toBeInstanceOf(UpdateError);
        if (got instanceof UpdateError) return;
        expect(got.record.kind).toBe(c.expect.kind);
        expect(got.source).toBe("network");
        expect(got.pinned).toBe(pinned);
        if (c.expect.doc !== undefined)
          expect(got.record).toEqual(c.expect.doc);
        return;
      }
      expect(got, c.description).toBeInstanceOf(UpdateError);
      const e = got as UpdateError;
      if (c.expect.step === "cross-check") {
        expect(pinned, `${c.id} needs a pin to reach the cross-check`).toBe(
          true,
        );
        expect({ code: e.code, detail: e.detail }).toEqual({
          code: "record-mismatch",
          detail: null,
        });
      } else
        expect({ code: e.code, detail: e.detail }).toEqual({
          code: "record-rejected",
          detail: c.expect.step,
        });
    });
  }
});
