// @vitest-environment node
//
// @pkey-feature update.feed release.record update.decide telemetry.updates
//
// `decideUpdate()` in both React transports (WIRE-CONTRACT-V4 §2.5, plans/P3-01.md §2.6): what
// the update-matrix parity suite does not cover — the options refusals, step 1's endpoints, the
// slices persisting across a reload (the `seq` floor of the CANONICAL channel survives, an alias
// answer removes the requested name's entry), the record-body bound at the transport, and the
// desktop bridge's forwarding and error mapping.
//
// Runs in the NODE environment, like bundleImport.test.ts: under jsdom WebCrypto's Ed25519
// `verify` rejects every signature.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { recordHash } from "@polaris-key/client-core";
import type { ChannelFeedDoc } from "@polaris-key/protocol/update";
import type { ReleaseRecordDoc } from "@polaris-key/protocol/release";
import { BrowserAdapter } from "../src/browser/browserAdapter.js";
import { BearerSession } from "../src/browser/bearer/session.js";
import { memoryStore as bearerMemoryStore } from "../src/browser/bearer/store.js";
import type { OfflineRecord, OfflineStore } from "../src/browser/offline.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import type { PolarisBridge } from "../src/desktop/bridge.js";
import { PolarisError } from "../src/core/types.js";
import {
  makeFakeBridge,
  newTestKey,
  okBridgeState,
  services,
  signCompact,
  type TestKey,
} from "./fixtures.js";

const PRODUCT = "djdl";
const BASE = "https://key.plrs.im";
const NOW = 1_700_000_100;

let productKey: TestKey;
let releaseKey: TestKey;
beforeAll(async () => {
  productKey = await newTestKey("djdl-test");
  releaseKey = await newTestKey("djdl-release-test");
});

function record(): ReleaseRecordDoc {
  return {
    schemaVersion: 1,
    aud: PRODUCT,
    deliverable: "app",
    kind: "app",
    version: "1.5.0",
    seq: 15,
    issuedAt: 1_699_990_000,
    builds: [
      {
        id: "web",
        platform: "web",
        arch: "wasm32",
        format: "zip",
        artifacts: [
          { name: "w.zip", role: "payload", sha256: "a".repeat(64), size: 1 },
        ],
      },
    ],
  };
}

function feed(
  sha256: string,
  over: Partial<ChannelFeedDoc> = {},
): ChannelFeedDoc {
  return {
    schemaVersion: 1,
    iss: "key.plrs.im",
    aud: PRODUCT,
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
          platform: "web",
          release: { sha256, seq: 15, version: "1.5.0" },
          floor: null,
          critical: false,
          outlets: {
            web: {
              kind: "web",
              live: { version: "1.5.0", seq: 15 },
              halted: false,
            },
          },
        },
      ],
    },
    ...over,
  };
}

function discovery(v4 = true): string {
  return JSON.stringify({
    version: 2,
    protocolVersion: 4,
    product: PRODUCT,
    services: {
      release: {
        enabled: true,
        endpoints: v4
          ? { record: `${BASE}/${PRODUCT}/release/records/{sha256}` }
          : {},
      },
      update: {
        enabled: true,
        endpoints: {
          version: `${BASE}/${PRODUCT}/update/version`,
          ...(v4
            ? { feed: `${BASE}/${PRODUCT}/update/{channel}/feed.jws` }
            : {}),
        },
      },
      distribution: {
        enabled: true,
        endpoints: {
          builds: `${BASE}/${PRODUCT}/distribution/builds/{selector}/{buildId}`,
        },
      },
    },
  });
}

function memoryStore(seed?: OfflineRecord): OfflineStore & {
  records: Map<string, OfflineRecord>;
} {
  const records = new Map<string, OfflineRecord>();
  if (seed) records.set(PRODUCT, seed);
  return {
    records,
    async read(p) {
      return records.get(p) ?? null;
    },
    async write(p, r) {
      records.set(p, structuredClone(r));
    },
  };
}

interface Server {
  fetchImpl: typeof fetch;
  urls: string[];
  feedBody: string | null;
  records: Map<string, Response | (() => Response)>;
}

function server(v4 = true): Server {
  const s: Server = {
    urls: [],
    feedBody: null,
    records: new Map(),
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      s.urls.push(url);
      if (url.endsWith("/.well-known/polaris.json"))
        return new Response(discovery(v4), { status: 200 });
      if (url.includes("/feed.jws"))
        return s.feedBody === null
          ? new Response(
              JSON.stringify({ error: { code: "feed_not_composable" } }),
              {
                status: 503,
              },
            )
          : new Response(s.feedBody, { status: 200 });
      const m = /\/release\/records\/([0-9a-f]+)$/.exec(url);
      if (m) {
        const r = s.records.get(m[1]!);
        if (!r) return new Response("nf", { status: 404 });
        return typeof r === "function" ? r() : r;
      }
      return new Response(null, { status: 401 });
    }) as unknown as typeof fetch,
  };
  return s;
}

function adapterFor(
  srv: Server,
  store: OfflineStore | null,
  over: Partial<ConstructorParameters<typeof BrowserAdapter>[0]> = {},
): BrowserAdapter {
  return new BrowserAdapter({
    auth: "cookie",
    productSlug: PRODUCT,
    baseUrl: BASE,
    fetchImpl: srv.fetchImpl,
    now: () => NOW,
    version: "1.4.0",
    trust: { pinnedKeys: { [productKey.kid]: productKey.raw } },
    offlineStore: store,
    update: { pinnedReleaseKeys: { [releaseKey.kid]: releaseKey.raw } },
    ...over,
  });
}

async function signedPair(over: Partial<ChannelFeedDoc> = {}) {
  const recordJws = await signCompact(record(), releaseKey, "pkey-release+jws");
  const hash = await recordHash(recordJws);
  const feedJws = await signCompact(
    feed(hash, over),
    productKey,
    "pkey-feed+jws",
  );
  return { recordJws, hash, feedJws };
}

describe("BrowserAdapter.decideUpdate() — options and step 1", () => {
  it("throws invalid-options at construction for a release key that is a trust pin, or a bad outlet", () => {
    const srv = server();
    expect(() =>
      adapterFor(srv, null, {
        update: { pinnedReleaseKeys: { other: productKey.raw } },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-options" }));
    expect(() =>
      adapterFor(srv, null, {
        update: {
          pinnedReleaseKeys: { [releaseKey.kid]: releaseKey.raw },
          outlet: "epic" as never,
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-options" }));
  });

  it("throws invalid-options for a pinned pkd1- kid (plans/P4-19.md §2.2)", () => {
    // @pkey-feature packs.delegation
    const srv = server();
    expect(() =>
      adapterFor(srv, null, {
        update: {
          pinnedReleaseKeys: {
            [releaseKey.kid]: releaseKey.raw,
            [`pkd1-${"a".repeat(64)}`]: releaseKey.raw,
          },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-options" }));
  });

  it("throws not-configured without release keys, with an empty map, or without product pins", async () => {
    const srv = server();
    for (const over of [
      { update: undefined },
      { update: { pinnedReleaseKeys: {} } },
      { trust: undefined },
    ]) {
      const a = adapterFor(srv, null, over);
      await expect(a.decideUpdate()).rejects.toMatchObject({
        code: "not-configured",
      });
      expect(a.snapshot().error.update?.code).toBe("not-configured");
    }
    expect(srv.urls.some((u) => u.includes("/feed.jws"))).toBe(false);
  });

  it("refuses with service-unavailable before dialling when discovery lacks the v4 endpoints", async () => {
    const srv = server(false);
    const a = adapterFor(srv, null);
    await expect(a.decideUpdate()).rejects.toMatchObject({
      code: "service-unavailable",
    });
    expect(srv.urls.some((u) => u.includes("/feed.jws"))).toBe(false);
  });

  it("raises the transport failure with nothing committed, carrying the Worker's wire code", async () => {
    const srv = server();
    const a = adapterFor(srv, null);
    const err = (await a.decideUpdate().catch((e) => e)) as PolarisError;
    expect(err).toBeInstanceOf(PolarisError);
    expect(err.code).toBe("network");
    expect(err.wireCode).toBe("feed_not_composable");
  });

  it("raises feed-rejected with the refused step as detail", async () => {
    const srv = server();
    srv.feedBody = (await signedPair({ channel: "beta" })).feedJws;
    const err = (await adapterFor(srv, null)
      .decideUpdate()
      .catch((e) => e)) as PolarisError;
    expect(err.code).toBe("feed-rejected");
    expect(err.detail).toBe("channel");
  });
});

describe("BrowserAdapter.decideUpdate() — update_offered (telemetry.updates, SP-14)", () => {
  it("bearer mode journals update_offered once per offered release; a cookie page journals nothing", async () => {
    const recorded = vi.spyOn(BearerSession.prototype, "recordUpdateEvent");
    try {
      const srv = server();
      const { recordJws, hash, feedJws } = await signedPair();
      srv.feedBody = feedJws;
      srv.records.set(hash, () => new Response(recordJws, { status: 200 }));
      const bearer = adapterFor(srv, null, {
        auth: "bearer",
        store: bearerMemoryStore(PRODUCT),
      });
      await bearer.decideUpdate();
      await bearer.decideUpdate();
      expect(recorded).toHaveBeenCalledTimes(1);
      expect(recorded.mock.calls[0]).toEqual([
        "update_offered",
        { release: "1.5.0", fromRelease: "1.4.0", channel: "stable" },
      ]);
      expect(recorded.mock.results[0]!.value).toMatchObject({
        event: "update_offered",
        release: "1.5.0",
        fromRelease: "1.4.0",
        outlet: "web",
        channel: "stable",
        at: NOW,
      });
      bearer.dispose();

      recorded.mockClear();
      const cookie = adapterFor(srv, memoryStore({ deviceId: "dev_1" }));
      await cookie.decideUpdate();
      expect(recorded).not.toHaveBeenCalled();
      cookie.dispose();
    } finally {
      recorded.mockRestore();
    }
  });
});

describe("BrowserAdapter.decideUpdate() — the slices across a reload", () => {
  it("decides, persists, and reads the record from the cache next time", async () => {
    const srv = server();
    const { recordJws, hash, feedJws } = await signedPair();
    srv.feedBody = feedJws;
    srv.records.set(hash, new Response(recordJws, { status: 200 }));
    const store = memoryStore({ deviceId: "dev_1" });
    const first = await adapterFor(srv, store).decideUpdate();
    expect(first).toMatchObject({
      channel: "stable",
      feed: "network",
      record: "network",
      errors: [],
      decision: { action: "platform", release: { version: "1.5.0", seq: 15 } },
    });
    expect(store.records.get(PRODUCT)?.cache).toEqual({
      v: 3,
      feeds: { stable: feedJws },
      releaseRecords: { [hash]: recordJws },
    });
    // A fresh adapter over the same store: no record request this time.
    srv.records.clear();
    const second = await adapterFor(srv, store).decideUpdate({
      channel: "latest",
    });
    expect(second).toMatchObject({
      channel: "stable",
      record: "cache",
      errors: [],
    });
  });

  it("keeps the floor of the canonical channel across a reload: a lower seq is a rollback", async () => {
    const srv = server();
    const newer = await signedPair({ seq: 8 });
    const store = memoryStore({
      deviceId: "dev_1",
      cache: {
        v: 3,
        feeds: { stable: newer.feedJws },
        releaseRecords: { [newer.hash]: newer.recordJws },
      },
    });
    srv.feedBody = (await signedPair({ seq: 7 })).feedJws;
    const check = await adapterFor(srv, store).decideUpdate({
      channel: "latest",
    });
    expect(check).toMatchObject({
      channel: "stable",
      feed: "committed",
      record: "cache",
      errors: [{ code: "feed-rollback", detail: null }],
    });
    expect(store.records.get(PRODUCT)?.cache?.feeds).toEqual({
      stable: newer.feedJws,
    });
  });

  it("stores an alias answer under the claim, removing the requested name's stale entry", async () => {
    const srv = server();
    const oldStaging = await signedPair({ channel: "staging", seq: 2 });
    const beta = await signedPair({ channel: "beta", seq: 3 });
    srv.feedBody = beta.feedJws;
    srv.records.set(beta.hash, new Response(beta.recordJws, { status: 200 }));
    const store = memoryStore({
      deviceId: "dev_1",
      cache: { v: 3, feeds: { staging: oldStaging.feedJws } },
    });
    const check = await adapterFor(srv, store).decideUpdate({
      channel: "staging",
    });
    expect(check.channel).toBe("beta");
    expect(store.records.get(PRODUCT)?.cache?.feeds).toEqual({
      beta: beta.feedJws,
    });
  });

  it("keeps the update slices through a bundle-session sign-out", async () => {
    const srv = server();
    const { feedJws } = await signedPair();
    const store = memoryStore({
      deviceId: "dev_1",
      cache: { v: 3, feeds: { stable: feedJws } },
    });
    const a = adapterFor(srv, store);
    (a as unknown as { offlineState: unknown }).offlineState = {
      deviceId: "dev_1",
      importedBundle: { bundleId: "b", importedAt: 1 },
    };
    await a.signOut().catch(() => undefined);
    expect(store.records.get(PRODUCT)).toEqual({
      deviceId: "dev_1",
      cache: { v: 3, feeds: { stable: feedJws } },
    });
  });

  it("stops reading a record body past the bound: record-rejected {hash}, and the decision goes on", async () => {
    const srv = server();
    const { hash, feedJws } = await signedPair();
    srv.feedBody = feedJws;
    const cancel = vi.fn();
    srv.records.set(hash, () => {
      const body = new ReadableStream({ cancel });
      return new Response(body, {
        status: 200,
        headers: { "content-length": "88845" },
      });
    });
    const check = await adapterFor(srv, null).decideUpdate();
    expect(check).toMatchObject({
      record: "none",
      errors: [{ code: "record-rejected", detail: "hash" }],
    });
    expect(cancel).toHaveBeenCalled();
  });

  it("builds a download URL from discovery's builds template", async () => {
    const a = adapterFor(server(), null);
    expect(await a.buildUrl("1.6.0-beta.2", "macos-dmg")).toBe(
      `${BASE}/${PRODUCT}/distribution/builds/1.6.0-beta.2/macos-dmg`,
    );
  });
});

// @pkey-feature packs.delta.feed
describe("BrowserAdapter.decideUpdate() — the feed's delta menu (plans/P4-29.md §2.4 step 1)", () => {
  it("hands the decided feed's menu to the pack facet, and null for a feed without one", async () => {
    const menu = {
      ["b".repeat(64)]: [
        {
          from: "c".repeat(64),
          method: "zstd-patch-from",
          scope: "payload" as const,
          memBytes: 2048,
          artifact: { sha256: "d".repeat(64), bytes: 512 },
        },
      ],
    };
    const got: unknown[] = [];
    const packs = {
      contentInput: async () => null,
      recordRevocations: async () => undefined,
      recordFeedDeltas: (d: unknown) => void got.push(d),
    };
    for (const over of [{ deltas: menu }, {}]) {
      const srv = server();
      const { recordJws, hash, feedJws } = await signedPair(
        over as Partial<ChannelFeedDoc>,
      );
      srv.feedBody = feedJws;
      srv.records.set(hash, new Response(recordJws, { status: 200 }));
      await adapterFor(srv, memoryStore({ deviceId: "dev_1" }), {
        update: {
          pinnedReleaseKeys: { [releaseKey.kid]: releaseKey.raw },
          packs,
        },
      }).decideUpdate();
    }
    expect(got).toEqual([menu, null]);
  });

  it("seeds the pack facet at construction with the most recently committed feed's menu (P4-29 follow-up)", async () => {
    const menu = {
      ["b".repeat(64)]: [
        {
          from: "c".repeat(64),
          method: "zstd-patch-from",
          scope: "payload" as const,
          memBytes: 2048,
          artifact: { sha256: "d".repeat(64), bytes: 512 },
        },
      ],
    };
    const loaders: (() => Promise<unknown>)[] = [];
    const packs = {
      contentInput: async () => null,
      recordRevocations: async () => undefined,
      recordFeedDeltas: () => undefined,
      seedFeedDeltas: (load: () => Promise<unknown>) => void loaders.push(load),
    };
    const older = (
      await signedPair({ issuedAt: 1_699_999_000, expiresAt: 1_699_999_900 })
    ).feedJws;
    const newer = (
      await signedPair({
        channel: "beta",
        deltas: menu,
      } as Partial<ChannelFeedDoc>)
    ).feedJws;
    const cases: [Record<string, string> | undefined, unknown][] = [
      // The newest committed feed's menu, stale or not, whatever its channel.
      [{ stable: older, beta: newer }, menu],
      // A newest feed without a menu: none.
      [{ stable: older }, null],
      // A stored feed that does not verify (here: filed under the wrong channel) is skipped.
      [{ stable: newer }, null],
      // No cache: none.
      [undefined, null],
    ];
    for (const [feeds, want] of cases) {
      loaders.length = 0;
      adapterFor(
        server(),
        memoryStore({
          deviceId: "dev_1",
          ...(feeds ? { cache: { v: 3, feeds } } : {}),
        }),
        {
          update: {
            pinnedReleaseKeys: { [releaseKey.kid]: releaseKey.raw },
            packs,
          },
        },
      );
      expect(loaders).toHaveLength(1);
      expect(await loaders[0]!()).toEqual(want);
    }
  });
});

describe("BrowserAdapter.decideUpdate() — the effective clock", () => {
  // plans/P3-01.md §2.5: `now` is max(system, highWaterMark) (V3 §4.2), so winding the system
  // clock back cannot revive an expired feed (§2.3). The floor here comes from a re-verified
  // imported config document dated after the feed's expiresAt + 300.
  const FLOOR = 1_700_002_000;

  async function storeWithFloor(
    cache: Record<string, unknown> = {},
  ): Promise<ReturnType<typeof memoryStore>> {
    const config = await signCompact(
      {
        iss: "key.plrs.im",
        aud: PRODUCT,
        deviceId: "dev_1",
        issuedAt: FLOOR,
        expiresAt: FLOOR + 3_600,
        graceUntil: FLOOR + 7_200,
        schemaVersion: 1,
        config: {},
        secrets: {},
      },
      productKey,
      "pkey-config+jws",
    );
    return memoryStore({
      deviceId: "dev_1",
      cache: {
        v: 3,
        docs: { config },
        importedBundle: { bundleId: "b", importedAt: FLOOR },
        ...cache,
      },
    } as OfflineRecord);
  }

  async function settled(a: BrowserAdapter): Promise<void> {
    for (let i = 0; i < 100 && a.snapshot().phase === "loading"; i++)
      await new Promise((r) => setTimeout(r, 0));
  }

  it("a rewound system clock under the floor refuses the expired feed: feed-rejected {freshness}", async () => {
    const srv = server();
    srv.feedBody = (await signedPair()).feedJws;
    const a = adapterFor(srv, await storeWithFloor());
    await settled(a);
    expect(a.snapshot().highWaterMark).toBe(FLOOR);
    const err = (await a.decideUpdate().catch((e) => e)) as PolarisError;
    expect(err).toBeInstanceOf(PolarisError);
    expect(err.code).toBe("feed-rejected");
    expect(err.detail).toBe("freshness");
  });

  it("the committed feed decides none {stale} at the effective clock", async () => {
    const srv = server();
    const pair = await signedPair();
    srv.feedBody = null;
    const a = adapterFor(
      srv,
      await storeWithFloor({
        feeds: { stable: pair.feedJws },
        releaseRecords: { [pair.hash]: pair.recordJws },
      }),
    );
    await settled(a);
    const check = await a.decideUpdate();
    expect(check).toMatchObject({
      channel: "stable",
      feed: "committed",
      decision: { action: "none", reason: "stale" },
    });
  });

  it("without the floor the same feed is fresh at the system clock", async () => {
    const srv = server();
    const pair = await signedPair();
    srv.feedBody = pair.feedJws;
    srv.records.set(pair.hash, new Response(pair.recordJws, { status: 200 }));
    const check = await adapterFor(
      srv,
      memoryStore({ deviceId: "dev_1" }),
    ).decideUpdate();
    expect(check).toMatchObject({ feed: "network", errors: [] });
  });
});

describe("desktop decideUpdate() — the host decides", () => {
  function desktop(invoke?: PolarisBridge["invoke"], update = true) {
    const caps = update ? services("update") : services();
    const bridge = makeFakeBridge(okBridgeState({ capabilities: caps }));
    if (invoke) bridge.invoke = invoke;
    return desktopAdapter({ bridge, expectServices: caps });
  }

  it("forwards only the arguments given", async () => {
    const answer = {
      channel: "stable",
      decision: {
        action: "none",
        reason: "up-to-date",
        behind: false,
        discardStaged: false,
      },
      feed: "network",
      record: "cache",
      errors: [],
    };
    const invoke = vi.fn(async () => answer);
    const a = desktop(invoke as PolarisBridge["invoke"]);
    expect(await a.decideUpdate()).toEqual(answer);
    expect(invoke).toHaveBeenCalledWith("update", "decide", {});
    a.dispose();
  });

  it("service-unavailable without Update, or without invoke", async () => {
    for (const a of [desktop(vi.fn() as never, false), desktop(undefined)]) {
      await expect(a.decideUpdate()).rejects.toMatchObject({
        code: "service-unavailable",
      });
      a.dispose();
    }
  });

  it("maps the host's §2.5 codes and keeps detail", async () => {
    const hostError = (code: string, detail?: string) =>
      Object.assign(new Error(code), { code, ...(detail ? { detail } : {}) });
    const cases: [Error, Partial<PolarisError>][] = [
      [
        hostError("feed-rejected", "jws"),
        { code: "feed-rejected", detail: "jws" },
      ],
      [hostError("not-configured"), { code: "not-configured" }],
      [
        hostError("network-error"),
        { code: "network", wireCode: "network-error" },
      ],
      [
        hostError("feed_not_composable"),
        { code: "unknown", wireCode: "feed_not_composable" },
      ],
    ];
    for (const [thrown, want] of cases) {
      const a = desktop(
        vi.fn(async () => {
          throw thrown;
        }) as never,
      );
      await expect(a.decideUpdate()).rejects.toMatchObject(want);
      a.dispose();
    }
  });
});
