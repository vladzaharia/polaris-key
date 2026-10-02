// @pkey-feature update.feed release.record update.decide
// Unit proofs for P3-05's verifiers, decision helpers and `runUpdateCheck` (plans/P3-01.md
// §2.5–§2.8). The corpus pins every verdict across SDKs through the Node runner; these pin the
// edges the corpus does not carry: the record-body bound (an 88 845-byte body, §2.5 step 12),
// hash before signature, key separation, the reload path, step 9's write and §2.5's refusal
// rules and error map.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { base64UrlEncodeBytes, signJws, type TrustSet } from "@polaris-key/jws";
import type { ChannelFeedDoc } from "@polaris-key/protocol/update";
import type { ReleaseRecordDoc } from "@polaris-key/protocol/release";
import {
  CACHE_VERSION,
  bootDecision,
  boundChannels,
  commitFeed,
  decideUpdate,
  feedFloor,
  isUndismissable,
  isValidHostOutlet,
  recordHash,
  reloadFeeds,
  reloadReleaseRecords,
  runUpdateCheck,
  verifyFeed,
  verifyReleaseRecord,
  type CacheRecordV3,
  type FetchOutcome,
  type RunUpdateCheckOptions,
} from "../src/index.js";

interface Key {
  kid: string;
  pem: string;
  raw: string;
}

function pkcs8ToPem(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const body = btoa(bin).match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${body.join("\n")}\n-----END PRIVATE KEY-----`;
}

async function newKey(kid: string): Promise<Key> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    kid,
    pem: pkcs8ToPem(
      new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    ),
    raw: base64UrlEncodeBytes(
      new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    ),
  };
}

let PRODUCT: Key;
let RELEASE: Key;
let trust: TrustSet;
let releaseKeys: TrustSet;

beforeAll(async () => {
  PRODUCT = await newKey("djdl-test");
  RELEASE = await newKey("djdl-release-test");
  trust = { [PRODUCT.kid]: PRODUCT.raw };
  releaseKeys = { [RELEASE.kid]: RELEASE.raw };
});

const NOW = 1_700_000_100;
const SHA_A = "a".repeat(64);

function record(over: Partial<ReleaseRecordDoc> = {}): ReleaseRecordDoc {
  return {
    schemaVersion: 1,
    aud: "djdl",
    deliverable: "app",
    kind: "app",
    version: "1.5.0",
    seq: 15,
    issuedAt: 1_699_990_000,
    builds: [
      {
        id: "macos-dmg",
        platform: "macos",
        arch: "universal",
        format: "dmg",
        artifacts: [
          { name: "a.dmg", role: "payload", sha256: SHA_A, size: 10 },
        ],
      },
    ],
    ...over,
  };
}

function feed(
  sha256: string,
  over: Partial<ChannelFeedDoc> = {},
  release: { version: string; seq: number } = { version: "1.5.0", seq: 15 },
): ChannelFeedDoc {
  return {
    schemaVersion: 1,
    iss: "key.plrs.im",
    aud: "djdl",
    channel: "stable",
    selector: {},
    seq: 7,
    issuedAt: 1_700_000_000,
    expiresAt: 1_700_000_900,
    app: {
      deliverable: "app",
      versionScheme: "semver",
      targets: [
        {
          platform: "macos",
          release: { sha256, ...release },
          floor: null,
          critical: false,
          outlets: {
            direct: {
              kind: "direct",
              live: { version: release.version, seq: release.seq },
              halted: false,
            },
          },
        },
      ],
    },
    ...over,
  };
}

const signFeed = (doc: unknown, key = PRODUCT): Promise<string> =>
  signJws(doc, key.pem, key.kid, "pkey-feed+jws");
const signRecord = (doc: unknown, key = RELEASE): Promise<string> =>
  signJws(doc, key.pem, key.kid, "pkey-release+jws");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recordHash (WIRE-CONTRACT-V4 §8)", () => {
  it("is the lowercase hex SHA-256 of the exact ASCII bytes", async () => {
    expect(await recordHash("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("verifyReleaseRecord (§2.5 steps 12–15)", () => {
  it("accepts a record whose hash is the pin, signed by a pinned release key", async () => {
    const jws = await signRecord(record());
    const r = await verifyReleaseRecord(jws, {
      releaseKeys,
      productTrust: trust,
      expectedAud: "djdl",
      expectedHash: await recordHash(jws),
      pin: { deliverable: "app", version: "1.5.0", seq: 15 },
    });
    expect(r).toMatchObject({ ok: true, record: { version: "1.5.0" } });
  });

  it("refuses a hash mismatch WITHOUT any signature check", async () => {
    const jws = await signRecord(record());
    const verify = vi.spyOn(crypto.subtle, "verify");
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    const r = await verifyReleaseRecord(jws, {
      releaseKeys,
      productTrust: trust,
      expectedAud: "djdl",
      expectedHash: "0".repeat(64),
    });
    expect(r).toEqual({ ok: false, step: "hash" });
    expect(verify).not.toHaveBeenCalled();
    expect(importKey).not.toHaveBeenCalled();
  });

  it("refuses a body of 88 845 bytes at step hash without hashing it, even when its hash is the pin", async () => {
    const body = "a".repeat(88_845);
    const pin = await recordHash(body);
    const digest = vi.spyOn(crypto.subtle, "digest");
    const r = await verifyReleaseRecord(body, {
      releaseKeys,
      productTrust: trust,
      expectedAud: "djdl",
      expectedHash: pin,
    });
    expect(r).toEqual({ ok: false, step: "hash" });
    expect(digest).not.toHaveBeenCalled();
  });

  it("refuses a body with a byte outside ASCII at step hash without hashing it", async () => {
    const body = (await signRecord(record())) + "é";
    const pin = await recordHash(body);
    const digest = vi.spyOn(crypto.subtle, "digest");
    const r = await verifyReleaseRecord(body, {
      releaseKeys,
      productTrust: trust,
      expectedAud: "djdl",
      expectedHash: pin,
    });
    expect(r).toEqual({ ok: false, step: "hash" });
    expect(digest).not.toHaveBeenCalled();
  });

  it("refuses a record signed by the product key (only pinned release keys verify)", async () => {
    const jws = await signRecord(record(), PRODUCT);
    const r = await verifyReleaseRecord(jws, {
      releaseKeys,
      productTrust: trust,
      expectedAud: "djdl",
      expectedHash: await recordHash(jws),
    });
    expect(r).toEqual({ ok: false, step: "jws" });
  });

  it("refuses a pinned release key whose bytes are also a product key", async () => {
    const jws = await signRecord(record());
    const r = await verifyReleaseRecord(jws, {
      releaseKeys,
      productTrust: { ...trust, other: RELEASE.raw },
      expectedAud: "djdl",
      expectedHash: await recordHash(jws),
    });
    expect(r).toEqual({ ok: false, step: "jws" });
  });

  it("refuses the claims, then the cross-check", async () => {
    const bad = await signRecord(record({ aud: "other" }));
    expect(
      await verifyReleaseRecord(bad, {
        releaseKeys,
        productTrust: trust,
        expectedAud: "djdl",
        expectedHash: await recordHash(bad),
      }),
    ).toEqual({ ok: false, step: "claims" });
    const good = await signRecord(record());
    for (const pin of [
      { deliverable: "app", version: "1.5.1", seq: 15 },
      { deliverable: "app", version: "1.5.0", seq: 16 },
      { deliverable: "other", version: "1.5.0", seq: 15 },
    ])
      expect(
        await verifyReleaseRecord(good, {
          releaseKeys,
          productTrust: trust,
          expectedAud: "djdl",
          expectedHash: await recordHash(good),
          pin,
        }),
      ).toEqual({ ok: false, step: "cross-check" });
  });

  it("never throws on garbage", async () => {
    for (const body of ["", ".", "a.b.c", "x".repeat(10)])
      expect(
        (
          await verifyReleaseRecord(body, {
            releaseKeys,
            productTrust: trust,
            expectedAud: "djdl",
            expectedHash: await recordHash(body),
          })
        ).ok,
      ).toBe(false);
  });
});

describe("verifyFeed (§2.5 steps 3–8)", () => {
  const opts = {
    expectedAud: "djdl",
    channel: "stable",
    platform: "macos",
    now: NOW,
  };

  it("reports the canonical channel on refusals after step 5 only", async () => {
    const jws = await signFeed(feed(SHA_A));
    expect(await verifyFeed(jws, { ...opts, trust: {} })).toEqual({
      ok: false,
      reason: "jws",
    });
    expect(await verifyFeed(jws, { ...opts, trust, channel: "beta" })).toEqual({
      ok: false,
      reason: "channel",
    });
    expect(
      await verifyFeed(jws, {
        ...opts,
        trust,
        floors: { stable: { seq: 8, issuedAt: 0 } },
      }),
    ).toEqual({ ok: false, reason: "rollback", channel: "stable" });
  });

  it("reads floors at the CLAIM, never the requested name", async () => {
    const jws = await signFeed(feed(SHA_A));
    // `latest` binds to the `stable` claim; a `latest` floor is never read.
    expect(
      await verifyFeed(jws, {
        ...opts,
        trust,
        channel: "latest",
        floors: { latest: { seq: 9, issuedAt: 0 } },
      }),
    ).toMatchObject({ ok: true });
    expect(
      await verifyFeed(jws, {
        ...opts,
        trust,
        channel: "latest",
        floors: { stable: { seq: 9, issuedAt: 0 } },
      }),
    ).toEqual({ ok: false, reason: "rollback", channel: "stable" });
  });

  it("ignores an inherited floor key", async () => {
    const jws = await signFeed(feed(SHA_A, { channel: "stable" }));
    const floors = Object.create({ stable: { seq: 99, issuedAt: 0 } });
    expect(await verifyFeed(jws, { ...opts, trust, floors })).toMatchObject({
      ok: true,
    });
  });
});

describe("the reload path and step 9's write (§2.5, §2.6)", () => {
  it("keeps only feeds whose claim equals their key, and derives each floor", async () => {
    const stable = await signFeed(feed(SHA_A));
    const beta = await signFeed(feed(SHA_A, { channel: "beta", seq: 3 }));
    const out = await reloadFeeds(
      { stable, latest: stable, misfiled: beta, beta, junk: "x" },
      { trust, expectedAud: "djdl", platform: "macos" },
    );
    expect(Object.keys(out.feeds).sort()).toEqual(["beta", "stable"]);
    expect(out.floors).toEqual({
      stable: { seq: 7, issuedAt: 1_700_000_000 },
      beta: { seq: 3, issuedAt: 1_700_000_000 },
    });
  });

  it("drops a committed feed (and its floor) once its key leaves the trust set", async () => {
    const stable = await signFeed(feed(SHA_A));
    const out = await reloadFeeds(
      { stable },
      { trust: {}, expectedAud: "djdl", platform: "macos" },
    );
    expect(out).toEqual({ feeds: {}, floors: {} });
  });

  it("reloads an expired feed (no freshness on the reload path)", async () => {
    const stable = await signFeed(feed(SHA_A));
    const out = await reloadFeeds(
      { stable },
      { trust, expectedAud: "djdl", platform: "macos" },
    );
    expect(out.floors.stable).toEqual(
      feedFloor({ seq: 7, issuedAt: 1_700_000_000 }),
    );
  });

  it("commits under the claim and removes the requested name after an alias answer", () => {
    expect(
      commitFeed(
        { staging: "old", qa: "q" },
        { requested: "staging", claim: "beta", jws: "new" },
      ),
    ).toEqual({ qa: "q", beta: "new" });
    expect(
      commitFeed(
        { staging: "old" },
        { requested: "staging", claim: "staging", jws: "new" },
      ),
    ).toEqual({ staging: "new" });
    expect(boundChannels("latest")).toEqual(["latest", "stable"]);
    expect(boundChannels("qa")).toEqual(["qa"]);
  });

  it("keeps a cached record only while it verifies and is pinned", async () => {
    const jws = await signRecord(record());
    const h = await recordHash(jws);
    const opts = { releaseKeys, productTrust: trust, expectedAud: "djdl" };
    expect(
      Object.keys(
        await reloadReleaseRecords(
          { [h]: jws },
          { ...opts, pinned: new Set([h]) },
        ),
      ),
    ).toEqual([h]);
    expect(
      await reloadReleaseRecords({ [h]: jws }, { ...opts, pinned: new Set() }),
    ).toEqual({});
    expect(
      await reloadReleaseRecords(
        { [SHA_A]: jws },
        { ...opts, pinned: new Set([SHA_A]) },
      ),
    ).toEqual({});
  });

  it("CacheRecordV3 carries the two slices without a version bump", () => {
    const rec: CacheRecordV3 = {
      v: CACHE_VERSION,
      feeds: { stable: "jws" },
      releaseRecords: { [SHA_A]: "jws" },
    };
    expect(rec.v).toBe(3);
  });
});

describe("decision helpers (§2.8)", () => {
  it("validates host outlets", () => {
    expect(isValidHostOutlet("steam")).toBe(true);
    expect(isValidHostOutlet({ id: "altstore-beta", kind: "altstore" })).toBe(
      true,
    );
    expect(isValidHostOutlet("unknown")).toBe(false);
    expect(
      isValidHostOutlet({ id: "x", kind: "direct", subkind: "npmx" }),
    ).toBe(false);
    expect(isValidHostOutlet(42)).toBe(false);
  });

  it("names the prompts the player cannot dismiss, and none outside revoked content stops play", () => {
    const release = { version: "1.5.0", seq: 15 };
    const blocked = {
      action: "blocked",
      reason: "app-floor",
      discardStaged: false,
    } as const;
    const store = {
      action: "store",
      release,
      listingUrl: null,
      mandatory: true,
      critical: false,
      discardStaged: false,
    } as const;
    const platform = {
      ...store,
      action: "platform",
      mandatory: false,
    } as const;
    expect(isUndismissable(blocked)).toBe(true);
    expect(isUndismissable(store)).toBe(true);
    expect(isUndismissable(platform)).toBe(false);
    expect(bootDecision(blocked)).toBe("optional");
    expect(bootDecision(platform)).toBe("none");
    // Floors never stop play (plans/P4-13.md decision 4).
    expect(
      bootDecision({
        action: "blocked",
        reason: "content-floor",
        discardStaged: false,
      }),
    ).toBe("optional");
    expect(bootDecision({ ...store, contentBlock: "content-floor" })).toBe(
      "optional",
    );
    expect(
      bootDecision({
        action: "packs",
        install: [],
        revoke: ["diceroll.skins"],
        set: [],
        discardStaged: false,
      }),
    ).toBe("none");
  });

  it("answers required only for revoked required content (plans/P4-13.md decision 4)", () => {
    const release = { version: "1.5.0", seq: 15 };
    expect(
      bootDecision({
        action: "blocked",
        reason: "revoked-content",
        discardStaged: false,
      }),
    ).toBe("required");
    expect(
      bootDecision({
        action: "blocked",
        reason: "app-floor",
        discardStaged: false,
        contentBlock: "revoked-content",
      }),
    ).toBe("required");
    expect(
      bootDecision({
        action: "store",
        release,
        listingUrl: null,
        mandatory: true,
        critical: false,
        discardStaged: false,
        contentBlock: "revoked-content",
      }),
    ).toBe("required");
    expect(
      isUndismissable({
        action: "blocked",
        reason: "revoked-content",
        discardStaged: false,
      }),
    ).toBe(true);
  });

  it("decides from a feed whose outlet keys shadow Object.prototype", () => {
    const f = feed(SHA_A);
    f.app.targets[0]!.outlets = {
      constructor: { kind: "direct", live: null, halted: false },
    };
    const d = decideUpdate({
      now: NOW,
      feed: f,
      record: null,
      installed: {
        version: "1.4.0",
        buildNumber: null,
        platform: "macos",
        arch: "arm64",
        format: null,
        engine: null,
      },
      outlet: { id: "toString", kind: "direct" },
      subkind: null,
      staged: null,
      skipVersion: null,
      bucket: null,
      methods: ["download"],
    });
    expect(d).toEqual({
      action: "none",
      reason: "not-available",
      behind: false,
      discardStaged: false,
    });
  });
});

describe("runUpdateCheck (§2.5 refusal rules and error map)", () => {
  const installed = {
    version: "1.4.0",
    buildNumber: null,
    platform: "macos",
    arch: "arm64",
    format: null,
    engine: null,
  };

  async function fixture() {
    const recordJws = await signRecord(record());
    const hash = await recordHash(recordJws);
    return { recordJws, hash };
  }

  function base(
    over: Partial<RunUpdateCheckOptions> & {
      feedAnswer?: FetchOutcome;
      recordAnswer?: FetchOutcome;
    },
  ): RunUpdateCheckOptions & { calls: string[] } {
    const calls: string[] = [];
    const { feedAnswer, recordAnswer, ...rest } = over;
    return {
      channel: "stable",
      expectedAud: "djdl",
      trust,
      releaseKeys,
      now: NOW,
      installId: "dev_7c1e2d",
      installed,
      outlet: { id: "direct", kind: "direct" },
      subkind: null,
      methods: ["download"],
      cache: {},
      calls,
      fetchFeed: async (c) => {
        calls.push(`feed:${c}`);
        return feedAnswer ?? { ok: false, code: "network" };
      },
      fetchRecord: async (h) => {
        calls.push(`record:${h}`);
        return recordAnswer ?? { ok: false, code: "network" };
      },
      ...rest,
    };
  }

  it("fetches, commits and decides on the network path", async () => {
    const { recordJws, hash } = await fixture();
    const feedJws = await signFeed(feed(hash));
    const opts = base({
      feedAnswer: { ok: true, body: feedJws },
      recordAnswer: { ok: true, body: recordJws },
    });
    const r = await runUpdateCheck(opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.check).toEqual({
      channel: "stable",
      decision: {
        action: "binary",
        method: "download",
        release: { version: "1.5.0", seq: 15, sha256: hash },
        build: "macos-dmg",
        mandatory: false,
        critical: false,
        prestage: [],
        discardStaged: false,
      },
      feed: "network",
      record: "network",
      errors: [],
    });
    expect(r.boot).toBe("optional");
    expect(r.cache).toEqual({
      feeds: { stable: feedJws },
      releaseRecords: { [hash]: recordJws },
    });
    expect(opts.calls).toEqual(["feed:stable", `record:${hash}`]);

    // The same body again: nothing changed, and the record comes from the cache.
    const again = base({
      cache: r.cache,
      feedAnswer: { ok: true, body: feedJws },
    });
    const r2 = await runUpdateCheck(again);
    expect(r2.ok && r2.check).toMatchObject({
      channel: "stable",
      feed: "network",
      record: "cache",
      errors: [],
    });
    expect(again.calls).toEqual(["feed:stable"]);
  });

  it("stores an alias answer under the claim and removes the requested name's entry", async () => {
    const { recordJws, hash } = await fixture();
    const oldStaging = await signFeed(
      feed(hash, { channel: "staging", seq: 2 }),
    );
    const beta = await signFeed(feed(hash, { channel: "beta", seq: 3 }));
    const r = await runUpdateCheck(
      base({
        channel: "staging",
        cache: { feeds: { staging: oldStaging } },
        feedAnswer: { ok: true, body: beta },
        recordAnswer: { ok: true, body: recordJws },
      }),
    );
    expect(r.ok && r.check.channel).toBe("beta");
    expect(r.ok && r.cache.feeds).toEqual({ beta });
  });

  it("refuses a rollback and decides from the committed feed of the CLAIM (requested latest)", async () => {
    const { recordJws, hash } = await fixture();
    const committed = await signFeed(feed(hash, { seq: 8 }));
    const older = await signFeed(feed(hash, { seq: 7 }));
    const r = await runUpdateCheck(
      base({
        channel: "latest",
        cache: { feeds: { stable: committed } },
        feedAnswer: { ok: true, body: older },
        recordAnswer: { ok: true, body: recordJws },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.check).toMatchObject({
      channel: "stable",
      feed: "committed",
      record: "network",
      errors: [{ code: "feed-rollback", detail: null }],
    });
    expect(r.cache.feeds).toEqual({ stable: committed });
  });

  it("reports nothing for not-newer, and keeps the committed feed", async () => {
    const { recordJws, hash } = await fixture();
    const committed = await signFeed(feed(hash));
    const sameSeqOlder = await signFeed(
      feed(hash, { issuedAt: 1_699_999_999 }),
    );
    const r = await runUpdateCheck(
      base({
        cache: { feeds: { stable: committed } },
        feedAnswer: { ok: true, body: sameSeqOlder },
        recordAnswer: { ok: true, body: recordJws },
      }),
    );
    expect(r.ok && r.check).toMatchObject({ feed: "committed", errors: [] });
    expect(r.ok && r.cache.feeds).toEqual({ stable: committed });
  });

  it("falls back to the committed feed on a transport failure, and raises with nothing committed", async () => {
    const { recordJws, hash } = await fixture();
    const committed = await signFeed(feed(hash));
    const r = await runUpdateCheck(
      base({
        cache: { feeds: { stable: committed } },
        recordAnswer: { ok: true, body: recordJws },
      }),
    );
    expect(r.ok && r.check).toMatchObject({
      feed: "committed",
      errors: [{ code: "network", detail: null }],
    });
    expect(await runUpdateCheck(base({}))).toEqual({
      ok: false,
      error: { code: "network", detail: null },
    });
    const thrown = base({});
    thrown.fetchFeed = async () => {
      throw new Error("boom");
    };
    expect(await runUpdateCheck(thrown)).toEqual({
      ok: false,
      error: { code: "network", detail: null },
    });
  });

  it("maps refusals at steps 3–7 to feed-rejected with the step as detail", async () => {
    const { hash } = await fixture();
    const wrongChannel = await signFeed(feed(hash, { channel: "beta" }));
    expect(
      await runUpdateCheck(
        base({ feedAnswer: { ok: true, body: wrongChannel } }),
      ),
    ).toEqual({
      ok: false,
      error: { code: "feed-rejected", detail: "channel" },
    });
    const stale = await signFeed(
      feed(hash, { issuedAt: 1_000, expiresAt: 1_900 }),
    );
    expect(
      await runUpdateCheck(base({ feedAnswer: { ok: true, body: stale } })),
    ).toEqual({
      ok: false,
      error: { code: "feed-rejected", detail: "freshness" },
    });
  });

  it("a refused or unfetchable record is null for this call; a self-updating outlet answers not-available", async () => {
    const { hash } = await fixture();
    const feedJws = await signFeed(feed(hash));
    const mismatched = await signRecord(record({ seq: 16 }));
    const mismatchFeed = await signFeed(feed(await recordHash(mismatched)));
    const cases: [
      string,
      FetchOutcome,
      { code: string; detail: string | null },
    ][] = [
      [
        feedJws,
        { ok: false, code: "network" },
        { code: "network", detail: null },
      ],
      [
        feedJws,
        { ok: true, body: "x.y.z" },
        { code: "record-rejected", detail: "hash" },
      ],
      [
        mismatchFeed,
        { ok: true, body: mismatched },
        { code: "record-mismatch", detail: null },
      ],
    ];
    for (const [body, recordAnswer, error] of cases) {
      const r = await runUpdateCheck(
        base({ feedAnswer: { ok: true, body }, recordAnswer }),
      );
      expect(r.ok && r.check).toMatchObject({
        record: "none",
        errors: [error],
        decision: { action: "none", reason: "not-available" },
      });
      expect(r.ok && r.cache.releaseRecords).toEqual({});
    }
  });

  it("computes the rollout bucket from the install's entry", async () => {
    const { recordJws, hash } = await fixture();
    const f = feed(hash);
    f.app.targets[0]!.outlets.direct!.rollout = {
      bp: 6871,
      salt: "00112233445566778899aabbccddeeff",
    };
    const body = await signFeed(f);
    const out = await runUpdateCheck(
      base({
        feedAnswer: { ok: true, body },
        recordAnswer: { ok: true, body: recordJws },
      }),
    );
    // The corpus device's bucket is 6871, and a bucket equal to bp is out.
    expect(out.ok && out.check.decision).toMatchObject({
      action: "none",
      reason: "out-of-bucket",
    });
  });
});
