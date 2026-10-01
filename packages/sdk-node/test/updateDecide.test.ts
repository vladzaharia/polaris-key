// @pkey-feature update.feed release.record update.decide
//
// `client.update.decide()`'s wiring (plans/P3-01.md §2.5–§2.6): the options refusals, step 1's
// discovery gate, persistence across a restart through `FileStore`, the effective clock, the
// record-body bound, and where the bearer goes. The decision rows themselves are
// updateMatrixParity.test.ts; the verifier vectors are updateCorpus.test.ts.
//
// The restart tests are the point of the cache slices. After a reload:
//
//   * a feed with a lower `seq` is refused (`feed-rollback`) and the committed one decides, and
//     that floor came from re-verifying the committed JWS — tampering with it, or planting an
//     unsigned floor number beside it, changes nothing an attacker wants;
//   * a record whose SHA-256 is not the pin is refused at step `hash`, before any signature
//     work, and one signed outside `pinnedReleaseKeys` at step `jws`;
//   * an expired committed feed gives `none {stale}`, never an update.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ISSUER } from "@polaris-key/protocol/core";
import type { CacheRecordV3 } from "@polaris-key/client-core";
import { PolarisError, recordHash } from "@polaris-key/client-core";
import { PolarisKeyClient } from "../src/client.js";
import { FileStore } from "../src/core/store.js";
import { UpdateError, type UpdateClientOptions } from "../src/update/client.js";
import {
  BASE,
  MemStore,
  PINS,
  PRODUCT,
  PRODUCT_KID,
  RELEASE_KEYS,
  RELEASE_KID,
  V4_SERVICES,
  corpusKey,
  discoveryDoc,
  fakeWorker,
  feedPayload,
  recordPayload,
  sign,
  signFeed,
  signRecord,
} from "./updateFixtures.js";

const T = 1_700_000_000;
const UPDATE: UpdateClientOptions = {
  pinnedReleaseKeys: RELEASE_KEYS,
  outlet: "direct",
  platform: "macos",
  arch: "arm64",
};
const NEWER = {
  action: "binary",
  method: "download",
  release: { version: "1.5.0", seq: 15 },
  build: "macos-zip",
  mandatory: false,
  critical: false,
  prestage: [],
  discardStaged: false,
} as const;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pkey-update-"));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function at(seconds: number): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(seconds * 1000);
}

async function makeClient(o: {
  fetch: typeof fetch;
  store?: ConstructorParameters<typeof PolarisKeyClient>[0]["store"];
  update?: UpdateClientOptions | undefined;
  services?: readonly string[];
  version?: string;
  channel?: string;
  pins?: Record<string, string>;
}): Promise<PolarisKeyClient> {
  return PolarisKeyClient.create({
    productSlug: PRODUCT,
    baseUrl: BASE,
    version: o.version ?? "1.4.0",
    ...(o.channel !== undefined ? { channel: o.channel } : {}),
    trust: { pinnedKeys: o.pins ?? PINS },
    store: o.store ?? new FileStore(PRODUCT, dir),
    fetchImpl: o.fetch,
    requestTimeoutMs: 0,
    expectedServices: [...(o.services ?? V4_SERVICES)] as never,
    ...("update" in o
      ? o.update
        ? { update: o.update }
        : {}
      : { update: UPDATE }),
  });
}

/** A signed record and a feed (at `seq`, signed at `issuedAt`) that pins it. */
async function release(seq: number, issuedAt: number, channel = "stable") {
  const recordJws = await signRecord(recordPayload());
  const hash = await recordHash(recordJws);
  const feedJws = await signFeed(
    feedPayload({ channel, seq, issuedAt, sha256: hash }),
  );
  return { recordJws, hash, feedJws };
}

function managed(): CacheRecordV3 {
  return JSON.parse(
    readFileSync(join(dir, PRODUCT, "managed.json"), "utf8"),
  ) as CacheRecordV3;
}

function writeManaged(rec: unknown): void {
  writeFileSync(join(dir, PRODUCT, "managed.json"), JSON.stringify(rec));
}

/** The refusal `p` raises: an `UpdateError`, or Core's `PolarisError` for the D-21 gate and
 *  local-only mode (refused by Core before the update client runs). */
async function rejection(p: Promise<unknown>): Promise<UpdateError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof UpdateError) return e;
    if (e instanceof PolarisError)
      return Object.assign(e, { detail: null }) as UpdateError;
    throw e;
  }
  throw new Error("expected a refusal");
}

// ── Options ───────────────────────────────────────────────────────────────────────────────

describe("update options are validated at construction (invalid-options)", () => {
  const worker = fakeWorker({});
  const construct =
    (update: unknown, pins = PINS) =>
    () =>
      new PolarisKeyClient({
        productSlug: PRODUCT,
        baseUrl: BASE,
        version: "1.4.0",
        trust: { pinnedKeys: pins },
        store: new MemStore("dev_x"),
        fetchImpl: worker.fetch,
        update: update as UpdateClientOptions,
      });

  it("refuses a pinned release key that is also a trust pin, compared by its bytes", () => {
    // Same bytes under another kid: a release key is never a product key.
    const e = (() => {
      try {
        construct({
          pinnedReleaseKeys: { "some-release-kid": PINS[PRODUCT_KID] },
        })();
      } catch (err) {
        return err;
      }
      return null;
    })();
    expect(e).toBeInstanceOf(UpdateError);
    expect((e as UpdateError).code).toBe("invalid-options");
  });

  it.each([
    ["an outlet kind outside the vocabulary", { outlet: "floppy-disk" }],
    [
      "an outlet id outside OUTLET_ID_PATTERN",
      { outlet: { id: "Not An Id", kind: "direct" } },
    ],
    [
      "a subkind outside OUTLET_SUBKINDS",
      { outlet: { id: "direct", kind: "direct", subkind: "apt" } },
    ],
    [
      "a detection result of no kind",
      {
        detected: {
          kind: "nope",
          confidence: null,
          source: null,
          subkind: null,
        },
      },
    ],
    ["a method outside BINARY_METHODS", { methods: ["teleport"] }],
    ["a platform outside the enum", { platform: "beos" }],
    ["an arch outside the enum", { arch: "ia32" }],
    ["a non-string format", { format: 7 }],
    ["a non-string release key", { pinnedReleaseKeys: { k: 1 } }],
  ])("refuses %s", (_label, update) => {
    expect(construct({ pinnedReleaseKeys: RELEASE_KEYS, ...update })).toThrow(
      expect.objectContaining({ code: "invalid-options" }),
    );
  });

  it("accepts a kind, an {id, kind, subkind} and a rotation's two release keys", () => {
    expect(construct({ ...UPDATE, outlet: "steam" })).not.toThrow();
    expect(
      construct({
        ...UPDATE,
        outlet: { id: "direct-brew", kind: "direct", subkind: "homebrew" },
        pinnedReleaseKeys: {
          ...RELEASE_KEYS,
          "djdl-release-test-2027": corpusKey("djdl-release-test-2027")
            .publicKeyRaw,
        },
      }),
    ).not.toThrow();
  });
});

describe("decide()'s refusals before dialling", () => {
  it("not-configured without update options, and with an empty pinnedReleaseKeys", async () => {
    at(T);
    const worker = fakeWorker({});
    for (const update of [undefined, { ...UPDATE, pinnedReleaseKeys: {} }]) {
      const client = await makeClient({ fetch: worker.fetch, update });
      const e = await rejection(client.update.decide());
      expect(e.code).toBe("not-configured");
      client.close();
    }
    expect(worker.calls).toEqual([]);
  });

  it("service-unavailable when the product runs no Update service (D-21), with no request", async () => {
    at(T);
    const worker = fakeWorker({});
    const client = await makeClient({
      fetch: worker.fetch,
      services: ["release", "distribution"],
    });
    expect((await rejection(client.update.decide())).code).toBe(
      "service-unavailable",
    );
    expect(worker.calls).toEqual([]);
    client.close();
  });

  it.each([
    ["the feed endpoint", { feed: false }],
    ["the record endpoint", { record: false }],
  ])(
    "service-unavailable when discovery lacks %s (an older Worker): §2.5 step 1",
    async (_label, d) => {
      at(T);
      const worker = fakeWorker({
        discovery: discoveryDoc(d),
        feeds: () => "x",
      });
      const client = await makeClient({ fetch: worker.fetch });
      expect((await rejection(client.update.decide())).code).toBe(
        "service-unavailable",
      );
      // Discovery was loaded (lazily), and nothing else was requested.
      expect(worker.calls.map((c) => new URL(c.url).pathname)).toEqual([
        `/${PRODUCT}/.well-known/polaris.json`,
      ]);
      client.close();
    },
  );

  it("local-only: a transportless client refuses", async () => {
    at(T);
    const worker = fakeWorker({});
    const client = new PolarisKeyClient({
      productSlug: PRODUCT,
      baseUrl: BASE,
      version: "1.4.0",
      trust: { pinnedKeys: PINS },
      store: new MemStore("dev_x"),
      expectedServices: [...V4_SERVICES],
      update: UPDATE,
      localOnly: true,
    });
    await client.init();
    expect((await rejection(client.update.decide())).code).toBe("local-only");
    expect(worker.calls).toEqual([]);
  });
});

// ── The happy path, discovery and the request ─────────────────────────────────────────────

describe("decide() over a v4 Worker", () => {
  it("loads discovery lazily, sends the requested channel and the platform, and returns the UpdateCheck", async () => {
    at(T + 100);
    const r = await release(7, T);
    const worker = fakeWorker({
      feeds: () => r.feedJws,
      records: { [r.hash]: r.recordJws },
    });
    const client = await makeClient({ fetch: worker.fetch });
    const check = await client.update.decide({ channel: "latest" });
    expect(check).toEqual({
      channel: "stable",
      decision: { ...NEWER, release: { ...NEWER.release, sha256: r.hash } },
      feed: "network",
      record: "network",
      errors: [],
    });
    expect(worker.calls.map((c) => c.url)).toEqual([
      `${BASE}/${PRODUCT}/.well-known/polaris.json`,
      `${BASE}/${PRODUCT}/update/latest/feed.jws?platform=macos`,
      `${BASE}/${PRODUCT}/release/records/${r.hash}`,
    ]);
    const feedCall = worker.calls[1]!;
    expect(feedCall.headers.get("accept")).toBe("application/jose");
    expect(feedCall.headers.get("x-pkey-device")).toBeTruthy();
    // `latest` is stored under the canonical channel the feed claims.
    expect(Object.keys(managed().feeds ?? {})).toEqual(["stable"]);
    expect(managed().releaseRecords).toEqual({ [r.hash]: r.recordJws });
    // A build's install URL is the builds route, both parts percent-encoded.
    expect(client.update.buildUrl("1.5.0", "macos zip")).toBe(
      `${BASE}/${PRODUCT}/distribution/builds/1.5.0/macos%20zip`,
    );
    client.close();
  });

  it("defaults the channel to the client's own (CoreOptions.channel)", async () => {
    at(T + 100);
    const r = await release(7, T, "beta");
    const worker = fakeWorker({
      feeds: () => r.feedJws,
      records: { [r.hash]: r.recordJws },
    });
    const client = await makeClient({ fetch: worker.fetch, channel: "beta" });
    const check = await client.update.decide();
    expect(check.channel).toBe("beta");
    expect(worker.calls[1]!.url).toContain("/update/beta/feed.jws");
    client.close();
  });

  it("an unknown outlet (no outlet option) is never offered an update", async () => {
    at(T + 100);
    const r = await release(7, T);
    const worker = fakeWorker({
      feeds: () => r.feedJws,
      records: { [r.hash]: r.recordJws },
    });
    const { outlet: _outlet, ...noOutlet } = UPDATE;
    const client = await makeClient({ fetch: worker.fetch, update: noOutlet });
    const check = await client.update.decide();
    expect(check.decision).toEqual({
      action: "none",
      reason: "not-available",
      behind: false,
      discardStaged: false,
    });
    client.close();
  });

  it("sends the bearer to the control plane's origin only, never to a host discovery named", async () => {
    at(T + 100);
    const r = await release(7, T);
    const doc = discoveryDoc() as {
      services: { update: { endpoints: Record<string, string> } };
    };
    doc.services.update.endpoints.feed =
      "https://cdn.example/djdl/update/{channel}/feed.jws";
    const calls: { url: string; auth: string | null }[] = [];
    const inner = fakeWorker({
      discovery: doc,
      records: { [r.hash]: r.recordJws },
    });
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      calls.push({
        url,
        auth: new Headers(init?.headers).get("authorization"),
      });
      if (url.startsWith("https://cdn.example/"))
        return new Response(r.feedJws);
      return inner.fetch(input, init);
    }) as typeof fetch;
    const store = new MemStore("dev_bearer");
    await store.setToken("pkeyt_secret");
    const client = await makeClient({ fetch: fetchImpl, store });
    const check = await client.update.decide();
    expect(check.feed).toBe("network");
    const feed = calls.find((c) => c.url.startsWith("https://cdn.example/"))!;
    const record = calls.find((c) => c.url.includes("/release/records/"))!;
    expect(feed.auth).toBeNull();
    expect(record.auth).toBe("Bearer pkeyt_secret");
    client.close();
  });

  it("offline, with discovery unreachable, still decides from the committed feed", async () => {
    at(T + 100);
    const r = await release(7, T);
    const worker = fakeWorker({
      feeds: () => r.feedJws,
      records: { [r.hash]: r.recordJws },
    });
    const first = await makeClient({ fetch: worker.fetch });
    await first.update.decide();
    first.close();

    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const client = await makeClient({ fetch: down });
    const check = await client.update.decide();
    expect(check).toMatchObject({
      channel: "stable",
      feed: "committed",
      record: "cache",
      errors: [{ code: "network-error", detail: null }],
    });
    expect(check.decision.action).toBe("binary");
    client.close();
  });

  it("raises the transport code when nothing is committed to decide from", async () => {
    at(T + 100);
    const worker = fakeWorker({ feeds: () => 503 });
    const client = await makeClient({ fetch: worker.fetch });
    const e = await rejection(client.update.decide());
    expect({ code: e.code, detail: e.detail }).toEqual({
      code: "network-error",
      detail: null,
    });
    client.close();
  });

  it("carries the Worker's wire code when its answer names one", async () => {
    at(T + 100);
    const worker = fakeWorker({
      feeds: () =>
        new Response(
          JSON.stringify({ error: { code: "feed_not_composable" } }),
          {
            status: 503,
          },
        ) as never,
    });
    const client = await makeClient({ fetch: worker.fetch });
    expect((await rejection(client.update.decide())).code).toBe(
      "feed_not_composable",
    );
    client.close();
  });

  it("serialises concurrent decisions: each is a read-modify-write of the slices", async () => {
    at(T + 100);
    const a = await release(7, T, "stable");
    const b = await release(9, T, "beta");
    const worker = fakeWorker({
      feeds: (ch) => (ch === "beta" ? b.feedJws : a.feedJws),
      records: { [a.hash]: a.recordJws },
    });
    const client = await makeClient({ fetch: worker.fetch });
    await Promise.all([
      client.update.decide({ channel: "stable" }),
      client.update.decide({ channel: "beta" }),
    ]);
    expect(Object.keys(managed().feeds ?? {}).sort()).toEqual([
      "beta",
      "stable",
    ]);
    client.close();
  });
});

// ── Restarts (FileStore) ──────────────────────────────────────────────────────────────────

describe("the seq floor survives a restart", () => {
  it("after a reload, a feed with a lower seq is refused and the committed feed decides", async () => {
    at(T + 100);
    const high = await release(8, T);
    const w1 = fakeWorker({
      feeds: () => high.feedJws,
      records: { [high.hash]: high.recordJws },
    });
    const first = await makeClient({ fetch: w1.fetch });
    expect((await first.update.decide()).feed).toBe("network");
    first.close();

    // A fresh process: a new client over the same FileStore directory.
    const low = await release(7, T + 50);
    const w2 = fakeWorker({
      feeds: () => low.feedJws,
      records: { [high.hash]: high.recordJws },
    });
    const client = await makeClient({ fetch: w2.fetch });
    // `latest` binds to the committed `stable` entry: the floor is keyed by the canonical channel.
    const check = await client.update.decide({ channel: "latest" });
    expect(check).toMatchObject({
      channel: "stable",
      feed: "committed",
      record: "cache",
      errors: [{ code: "feed-rollback", detail: null }],
    });
    // The record came from the cache: no record request in this process.
    expect(w2.calls.some((c) => c.url.includes("/release/records/"))).toBe(
      false,
    );
    expect(managed().feeds?.stable).toBe(high.feedJws);
    client.close();
  });

  it("the floor comes from the re-verified committed JWS, never from a stored number", async () => {
    at(T + 100);
    const high = await release(8, T);
    const w1 = fakeWorker({
      feeds: () => high.feedJws,
      records: { [high.hash]: high.recordJws },
    });
    const first = await makeClient({ fetch: w1.fetch });
    await first.update.decide();
    first.close();

    // Tamper: break the committed feed's signature and plant an unsigned floor beside it.
    const rec = managed();
    const [h, p] = rec.feeds!.stable!.split(".");
    writeManaged({
      ...rec,
      feeds: { stable: `${h}.${p}.${"A".repeat(86)}` },
      floors: { stable: { seq: 1_000_000, issuedAt: T + 99 } },
      feedFloors: { stable: 1_000_000 },
    });

    const low = await release(7, T + 50);
    const w2 = fakeWorker({
      feeds: () => low.feedJws,
      records: { [low.hash]: low.recordJws },
    });
    const client = await makeClient({ fetch: w2.fetch });
    // The broken JWS no longer verifies, so it sets no floor; the planted numbers are never read.
    const check = await client.update.decide();
    expect(check).toMatchObject({ feed: "network", errors: [] });
    expect(managed().feeds).toEqual({ stable: low.feedJws });
    client.close();
  });

  it("a committed feed signed outside the trust set is dropped on load, with its floor", async () => {
    at(T + 100);
    // An attacker with write access to the cache plants a huge-seq feed signed by a key the
    // client does not trust.
    const planted = await sign(
      feedPayload({ seq: 9_000_000, issuedAt: T, sha256: "f".repeat(64) }),
      RELEASE_KID,
      "pkey-feed+jws",
    );
    const store = new FileStore(PRODUCT, dir);
    await store.writeCache({ v: 3, feeds: { stable: planted } });
    const low = await release(7, T + 50);
    const worker = fakeWorker({
      feeds: () => low.feedJws,
      records: { [low.hash]: low.recordJws },
    });
    const client = await makeClient({ fetch: worker.fetch, store });
    expect((await client.update.decide()).feed).toBe("network");
    client.close();
  });

  it("an expired committed feed yields the stale outcome, never an update", async () => {
    at(T + 100);
    const r = await release(7, T);
    const w1 = fakeWorker({
      feeds: () => r.feedJws,
      records: { [r.hash]: r.recordJws },
    });
    const first = await makeClient({ fetch: w1.fetch });
    expect((await first.update.decide()).decision.action).toBe("binary");
    first.close();

    // Past expiresAt + 300: the network is down, then serves the same expired feed again.
    at(T + 900 + 300);
    for (const answer of [503, r.feedJws] as const) {
      const w2 = fakeWorker({
        feeds: () => answer,
        records: { [r.hash]: r.recordJws },
      });
      const client = await makeClient({ fetch: w2.fetch });
      const check = await client.update.decide();
      expect(check.decision).toEqual({
        action: "none",
        reason: "stale",
        behind: false,
        discardStaged: false,
      });
      client.close();
    }
  });

  it("a deactivation wipes credentials but keeps the floors", async () => {
    at(T + 100);
    const high = await release(8, T);
    const w1 = fakeWorker({
      feeds: () => high.feedJws,
      records: { [high.hash]: high.recordJws },
    });
    const first = await makeClient({ fetch: w1.fetch });
    await first.update.decide();
    await first.license.deactivate();
    first.close();
    expect(managed().feeds?.stable).toBe(high.feedJws);

    const low = await release(7, T + 50);
    const w2 = fakeWorker({
      feeds: () => low.feedJws,
      records: { [high.hash]: high.recordJws },
    });
    const client = await makeClient({ fetch: w2.fetch });
    expect((await client.update.decide()).errors).toEqual([
      { code: "feed-rollback", detail: null },
    ]);
    client.close();
  });
});

// ── The record ────────────────────────────────────────────────────────────────────────────

describe("the release record", () => {
  it("a record whose SHA-256 differs from the pin is refused before any signature check", async () => {
    at(T + 100);
    const genuine = await signRecord(recordPayload());
    const hash = await recordHash(genuine);
    // Other bytes AND a broken signature: the step reported is `hash`, and no Ed25519
    // verification runs on the record at all.
    const [h, p] = genuine.split(".");
    const forged = `${h}.${p}.${"B".repeat(86)}`;
    const worker = fakeWorker({ records: { [hash]: forged } });
    const client = await makeClient({ fetch: worker.fetch });
    const verify = vi.spyOn(crypto.subtle, "verify");
    const e = await rejection(client.update.releaseRecord(hash));
    expect({ code: e.code, detail: e.detail }).toEqual({
      code: "record-rejected",
      detail: "hash",
    });
    expect(verify).not.toHaveBeenCalled();
    verify.mockRestore();
    client.close();
  });

  it("in decide(), a hash mismatch is reported and the record is null for the call", async () => {
    at(T + 100);
    const r = await release(7, T);
    const other = await signRecord(recordPayload({ buildId: "other" }));
    const worker = fakeWorker({
      feeds: () => r.feedJws,
      records: { [r.hash]: other },
    });
    const client = await makeClient({ fetch: worker.fetch });
    const check = await client.update.decide();
    expect(check).toMatchObject({
      record: "none",
      errors: [{ code: "record-rejected", detail: "hash" }],
      decision: { action: "none", reason: "not-available" },
    });
    expect(managed().releaseRecords).toEqual({});
    client.close();
  });

  it("a record signed by a key outside pinnedReleaseKeys is refused", async () => {
    at(T + 100);
    // Signed by a real corpus key — but not one this host pins as a release key.
    const recordJws = await sign(
      recordPayload(),
      "djdl-release-test-2027",
      "pkey-release+jws",
    );
    const hash = await recordHash(recordJws);
    const feedJws = await signFeed(
      feedPayload({ seq: 7, issuedAt: T, sha256: hash }),
    );
    const worker = fakeWorker({
      feeds: () => feedJws,
      records: { [hash]: recordJws },
    });
    const client = await makeClient({ fetch: worker.fetch });
    const check = await client.update.decide();
    expect(check).toMatchObject({
      record: "none",
      errors: [{ code: "record-rejected", detail: "jws" }],
    });
    // …nor does a product key sign records: the feed key is not a release key either.
    const byProduct = await sign(
      recordPayload(),
      PRODUCT_KID,
      "pkey-release+jws",
    );
    const h2 = await recordHash(byProduct);
    const w2 = fakeWorker({ records: { [h2]: byProduct } });
    const c2 = await makeClient({
      fetch: w2.fetch,
      store: new MemStore("dev_y"),
    });
    const e = await rejection(c2.update.releaseRecord(h2));
    expect({ code: e.code, detail: e.detail }).toEqual({
      code: "record-rejected",
      detail: "jws",
    });
    client.close();
    c2.close();
  });

  it("a body over MAX_RECORD_JWS_BYTES whose hash IS the pin is refused at step hash", async () => {
    at(T + 100);
    const body = "a".repeat(88_845);
    const hash = createHash("sha256").update(body).digest("hex");
    const feedJws = await signFeed(
      feedPayload({ seq: 7, issuedAt: T, sha256: hash }),
    );
    const worker = fakeWorker({
      feeds: () => feedJws,
      records: { [hash]: body },
    });
    const client = await makeClient({ fetch: worker.fetch });
    const check = await client.update.decide();
    expect(check.errors).toEqual([{ code: "record-rejected", detail: "hash" }]);
    client.close();
  });

  it("stops reading a record body once it passes the bound", async () => {
    at(T + 100);
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    const huge = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 8 * 1024 * 1024) return controller.close();
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const hash = "c".repeat(64);
    const worker = fakeWorker({ records: { [hash]: new Response(huge) } });
    const client = await makeClient({ fetch: worker.fetch });
    const e = await rejection(client.update.releaseRecord(hash));
    expect(e.detail).toBe("hash");
    expect(pulled).toBeLessThan(512 * 1024);
    client.close();
  });
});

// ── The effective clock ───────────────────────────────────────────────────────────────────

describe("the effective clock, max(system, highWaterMark)", () => {
  /** A trust manifest signed by the pin: a signed lower bound on real time when verified. */
  async function manifestAt(issuedAt: number): Promise<string> {
    return sign(
      {
        schemaVersion: 1,
        aud: PRODUCT,
        iss: ISSUER,
        issuedAt,
        expiresAt: issuedAt + 300,
        jwksUrl: `${BASE}/${PRODUCT}/.well-known/jwks.json`,
        cacheSeconds: 300,
        keys: [],
      },
      PRODUCT_KID,
      "pkey-trust+jws",
    );
  }

  it("a wound-back system clock cannot revive an expired feed", async () => {
    const r = await release(7, T);
    // The client has verified a manifest signed long after the feed expired; then the system
    // clock is wound back to a time at which the feed would look fresh.
    const store = new MemStore("dev_clock", {
      v: 3,
      trustJws: await manifestAt(T + 900 + 3_600),
    });
    at(T + 10);
    const worker = fakeWorker({
      feeds: () => r.feedJws,
      records: { [r.hash]: r.recordJws },
    });
    const client = await makeClient({ fetch: worker.fetch, store });
    expect(client.getSyncState().highWaterMark).toBe(T + 900 + 3_600);
    const e = await rejection(client.update.decide());
    expect({ code: e.code, detail: e.detail }).toEqual({
      code: "feed-rejected",
      detail: "freshness",
    });
    expect(store.cache?.feeds ?? {}).toEqual({});
    client.close();
  });

  it("the same feed at the same system clock is accepted when no floor is ahead of it", async () => {
    const r = await release(7, T);
    at(T + 10);
    const worker = fakeWorker({
      feeds: () => r.feedJws,
      records: { [r.hash]: r.recordJws },
    });
    const client = await makeClient({
      fetch: worker.fetch,
      store: new MemStore("dev_clock"),
    });
    expect((await client.update.decide()).feed).toBe("network");
    client.close();
  });
});

// ── check() and appcastUrl() are unchanged ────────────────────────────────────────────────

describe("the v3 surfaces beside decide()", () => {
  it("appcastUrl() still reads discovery, and buildUrl() is null before discovery", async () => {
    at(T);
    const worker = fakeWorker({});
    const client = await makeClient({ fetch: worker.fetch });
    expect(client.update.appcastUrl()).toBeNull();
    expect(client.update.buildUrl("1.5.0", "macos-zip")).toBeNull();
    await client.discover();
    expect(client.update.appcastUrl()).toBe(
      `${BASE}/${PRODUCT}/update/appcast.xml`,
    );
    client.close();
  });
});
