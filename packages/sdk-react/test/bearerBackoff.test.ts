// @vitest-environment node
//
// @pkey-feature core.sync
//
// Bearer mode's sync backoff and request deadline (SP-R02): after a 5xx, a 429 or a network
// failure, `sync()` stays off the network until the next allowed time (exponential with jitter,
// capped, a server's Retry-After honoured), and every request carries Node's 15 s deadline.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CacheRecordV3, Store } from "@polaris-key/client-core";
import {
  BearerSession,
  REQUEST_TIMEOUT_MS,
  SYNC_BACKOFF_BASE_SECONDS,
  SYNC_BACKOFF_MAX_SECONDS,
  parseRetryAfter,
  syncBackoffSeconds,
} from "../src/browser/bearer/session.js";

const NOW = 1_700_000_000;

class MemStore implements Store {
  private cache: CacheRecordV3 | null = null;
  constructor(private token: string | null) {}
  async getToken() {
    return this.token;
  }
  async setToken(t: string) {
    this.token = t;
  }
  async clearToken() {
    this.token = null;
  }
  async getDeviceId() {
    return "BACKOFFDEVICE000000000000000001";
  }
  async readCache() {
    return this.cache;
  }
  async writeCache(rec: CacheRecordV3) {
    this.cache = rec;
  }
  async clearCache() {
    this.cache = null;
  }
}

type Answer = Response | Error | "hang";

function harness(answers: Answer[]) {
  let clock = NOW;
  const docRequests: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    signals.push(init?.signal ?? undefined);
    if (!url.includes("/license/document"))
      return new Response("", { status: 404 });
    docRequests.push(url);
    const a = answers.shift() ?? new Response(null, { status: 304 });
    if (a === "hang")
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal!.reason as Error),
        );
      });
    if (a instanceof Error) throw a;
    return a;
  }) as typeof fetch;
  const session = new BearerSession({
    baseUrl: "https://key.plrs.im",
    product: "acme",
    version: "1.0.0",
    fetchImpl,
    now: () => clock,
    pinned: { k: "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI" },
    store: new MemStore("pkeyt_test"),
    enabled: (slug) => slug === "license",
    random: () => 0,
  });
  return {
    session,
    docRequests,
    signals,
    advance(seconds: number) {
      clock += seconds;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("sync backoff (SP-R02)", () => {
  it("a 5xx backs off: the next sync skips the network until the allowed time", async () => {
    const h = harness([new Response("", { status: 503 })]);
    const first = await h.session.sync();
    expect(first.documents.license).toEqual({ kind: "error" });
    expect(h.docRequests).toHaveLength(1);

    // random() = 0: equal jitter gives half the 30 s base.
    const skipped = await h.session.sync();
    expect(skipped).toEqual({
      applied: false,
      documents: {},
      deferredUntil: NOW + SYNC_BACKOFF_BASE_SECONDS / 2,
    });
    expect(h.docRequests).toHaveLength(1);

    h.advance(SYNC_BACKOFF_BASE_SECONDS / 2);
    const retried = await h.session.sync();
    expect(retried.documents.license).toEqual({ kind: "unchanged" });
    expect(h.docRequests).toHaveLength(2);
    // A pass that reached the server reset the counter: the next sync goes straight out.
    await h.session.sync();
    expect(h.docRequests).toHaveLength(3);
  });

  it("consecutive failures double the wait", async () => {
    const h = harness([
      new Response("", { status: 500 }),
      new Response("", { status: 502 }),
    ]);
    await h.session.sync();
    h.advance(15);
    await h.session.sync();
    expect(h.docRequests).toHaveLength(2);
    // Second failure: exp = 60, random() = 0 ⇒ 30.
    expect((await h.session.sync()).deferredUntil).toBe(NOW + 15 + 30);
  });

  it("a 429 honours Retry-After", async () => {
    const h = harness([
      new Response("{}", { status: 429, headers: { "retry-after": "120" } }),
    ]);
    const r = await h.session.sync();
    expect(r.deviceCap).toBe(true);
    expect((await h.session.sync()).deferredUntil).toBe(NOW + 120);
    h.advance(119);
    await h.session.sync();
    expect(h.docRequests).toHaveLength(1);
    h.advance(1);
    await h.session.sync();
    expect(h.docRequests).toHaveLength(2);
  });

  it("a network failure backs off too; a forced pass goes through", async () => {
    const h = harness([new TypeError("Failed to fetch")]);
    await h.session.sync();
    expect((await h.session.sync()).deferredUntil).toBe(NOW + 15);
    expect(h.docRequests).toHaveLength(1);
    await h.session.sync({ force: true });
    expect(h.docRequests).toHaveLength(2);
  });

  it("a 4xx that is not 429 is not a reason to back off", async () => {
    const h = harness([new Response("", { status: 404 })]);
    await h.session.sync();
    await h.session.sync();
    expect(h.docRequests).toHaveLength(2);
  });

  it("the wait is capped at an hour, Retry-After included", () => {
    expect(syncBackoffSeconds(30, undefined, () => 1)).toBe(
      SYNC_BACKOFF_MAX_SECONDS,
    );
    expect(syncBackoffSeconds(1, 99_999)).toBe(SYNC_BACKOFF_MAX_SECONDS);
    expect(syncBackoffSeconds(1, undefined, () => 1)).toBe(30);
    expect(syncBackoffSeconds(3, undefined, () => 0.5)).toBe(90);
  });

  it("parses Retry-After as delta-seconds or an HTTP date", () => {
    expect(parseRetryAfter("42", NOW)).toBe(42);
    expect(
      parseRetryAfter(new Date((NOW + 90) * 1000).toUTCString(), NOW),
    ).toBe(90);
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
    expect(parseRetryAfter("soon", NOW)).toBeUndefined();
  });
});

describe("request deadline", () => {
  it("every request carries a signal, and a hung document request fails after 15 s and backs off", async () => {
    vi.useFakeTimers();
    const h = harness(["hang"]);
    const pending = h.session.sync();
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    let done = false;
    void pending.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const r = await pending;
    expect(r.documents.license).toEqual({ kind: "error" });
    expect(h.signals.length).toBeGreaterThan(0);
    expect(h.signals.every((s) => s instanceof AbortSignal)).toBe(true);
    expect((await h.session.sync()).deferredUntil).toBe(NOW + 15);
  });
});
