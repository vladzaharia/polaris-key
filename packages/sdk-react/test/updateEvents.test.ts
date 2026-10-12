// @vitest-environment node
//
// @pkey-feature telemetry.updates
//
// The update-health record call (SDK-PARITY-PASS §3.13, SP-14) on both adapters: what the
// telemetry-report-updates replay (transcripts.test.ts, which records its journal through the
// same `BearerSession.recordUpdateEvent`) does not see — the entry's defaults and validation
// (Node's `UpdateJournal`, field for field), the browser adapter's bearer journal and its typed
// refusal on a cookie page, and the desktop renderer forwarding to the host's journal over
// bridge v4 (refused typed on an older host).

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CacheRecordV3, Store } from "@polaris-key/client-core";
import { BrowserAdapter } from "../src/browser/browserAdapter.js";
import {
  BearerSession,
  FLUSH_WAIT_SECONDS,
  MAX_JOURNAL,
  MAX_REPORT_UPDATES,
} from "../src/browser/bearer/session.js";
import { memoryStore } from "../src/browser/bearer/store.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import { Feature, UpdateEvent } from "../src/constants.generated.js";
import { UnsupportedError } from "../src/core/caps.js";
import { buildUpdateEvent } from "../src/core/updateEvents.js";
import {
  emptyBridgeState,
  makeFakeBridge,
  newTestKey,
  type TestKey,
} from "./fixtures.js";

const NOW = 1_700_000_000;

/** A store holding a device id and a token, nothing cached. */
function tokenStore(): Store {
  let token: string | null = "pkeyt_x";
  let cache: CacheRecordV3 | null = null;
  return {
    getToken: async () => token,
    setToken: async (t: string) => {
      token = t;
    },
    clearToken: async () => {
      token = null;
    },
    getDeviceId: async () => "DEV",
    readCache: async () => cache,
    writeCache: async (r: CacheRecordV3) => {
      cache = r;
    },
    clearCache: async () => {
      cache = null;
    },
  };
}
const CTX = { outlet: "steam", channel: "beta", now: NOW, eventId: "e-1" };

describe("buildUpdateEvent: Node's defaults and validation", () => {
  it("fills the id, the outlet, the channel and the time; the deliverable defaults to app", () => {
    expect(
      buildUpdateEvent(
        UpdateEvent.updateOffered,
        { release: "v1.1.0", fromRelease: "v1.0.0" },
        CTX,
      ),
    ).toEqual({
      eventId: "e-1",
      event: "update_offered",
      deliverable: "app",
      release: "v1.1.0",
      fromRelease: "v1.0.0",
      outlet: "steam",
      channel: "beta",
      at: NOW,
    });
  });

  it("keeps a pack's deliverable, its set and a short code; drops a fromRelease equal to release", () => {
    expect(
      buildUpdateEvent(
        UpdateEvent.packFailed,
        {
          release: "1.2.0",
          fromRelease: "1.2.0",
          deliverable: "pack.music",
          packSetId: "set-1",
          code: "hash_mismatch",
          channel: "stable",
        },
        { ...CTX, outlet: null },
      ),
    ).toEqual({
      eventId: "e-1",
      event: "pack_failed",
      deliverable: "pack.music",
      release: "1.2.0",
      outlet: "unknown",
      channel: "stable",
      packSetId: "set-1",
      at: NOW,
      code: "hash_mismatch",
    });
  });

  it("refuses an unknown event name or a malformed release or deliverable: nothing is recorded", () => {
    expect(
      buildUpdateEvent("update_exploded" as never, { release: "1.0.0" }, CTX),
    ).toBeNull();
    expect(
      buildUpdateEvent(
        UpdateEvent.updateApplied,
        { release: "has space" },
        CTX,
      ),
    ).toBeNull();
    expect(
      buildUpdateEvent(
        UpdateEvent.updateApplied,
        { release: "1.0.0", deliverable: "Bad" },
        CTX,
      ),
    ).toBeNull();
  });

  it("a malformed channel falls back to stable and a malformed code is left off", () => {
    expect(
      buildUpdateEvent(
        UpdateEvent.updateReverted,
        { release: "1.0.0", channel: "Not A Channel", code: "x y" },
        CTX,
      ),
    ).toMatchObject({ channel: "stable" });
    expect(
      buildUpdateEvent(
        UpdateEvent.updateReverted,
        { release: "1.0.0", code: "x y" },
        CTX,
      ),
    ).not.toHaveProperty("code");
  });
});

describe("BearerSession's in-page journal", () => {
  let key: TestKey;
  const session = async (seen: unknown[], fetchImpl?: typeof fetch) => {
    key ??= await newTestKey("pkey-test-journal");
    let n = 0;
    return new BearerSession({
      baseUrl: "https://key.plrs.im",
      product: "acme",
      version: "2.0.0",
      channel: "beta",
      fetchImpl:
        fetchImpl ??
        ((async (_: RequestInfo | URL, init: RequestInit = {}) => {
          seen.push(JSON.parse(String(init.body)));
          return new Response("{}", { status: 200 });
        }) as typeof fetch),
      now: () => NOW,
      pinned: { [key.kid]: key.raw },
      store: tokenStore(),
      enabled: () => true,
      outlet: () => ({ id: "web", kind: "web" }),
      eventId: (e) => `id-${(n += 1)}-${e}`,
    });
  };

  /** A fetch whose requests are answered when the test says so, in any order. */
  const gatedFetch = () => {
    const answers: Array<(res: Response) => void> = [];
    const waiting: Array<() => void> = [];
    const fetchImpl = (async () =>
      new Promise<Response>((resolve) => {
        answers.push(resolve);
        for (const wake of waiting.splice(0)) wake();
      })) as unknown as typeof fetch;
    return {
      fetchImpl,
      /** Answer the `i`th request (0-based). */
      answer: (i: number, res: Response): void => answers[i]!(res),
      /** Resolves once `n` requests have gone out. */
      arrived: (n: number): Promise<void> =>
        new Promise<void>((resolve) => {
          const check = (): void => {
            if (answers.length >= n) resolve();
            else waiting.push(check);
          };
          check();
        }),
    };
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records with the report's outlet id and the session's channel, and a report drains it", async () => {
    const seen: Record<string, unknown>[] = [];
    const s = await session(seen);
    expect(
      s.recordUpdateEvent(UpdateEvent.updateConfirmed, { release: "2.0.0" }),
    ).toEqual({
      eventId: "id-1-update_confirmed",
      event: "update_confirmed",
      deliverable: "app",
      release: "2.0.0",
      outlet: "web",
      channel: "beta",
      at: NOW,
    });
    expect(
      s.recordUpdateEvent(UpdateEvent.updateApplied, { release: "" }),
    ).toBeNull();
    expect(s.pendingUpdateEvents()).toHaveLength(1);
    expect(await s.report()).toBe(true);
    expect(seen.at(-1)?.updates).toEqual([
      expect.objectContaining({ eventId: "id-1-update_confirmed" }),
    ]);
    expect(s.pendingUpdateEvents()).toHaveLength(0);
  });

  it("keeps at most MAX_JOURNAL unsent events, dropping the oldest", async () => {
    const s = await session([]);
    for (let i = 0; i < MAX_JOURNAL + 3; i += 1)
      s.recordUpdateEvent(UpdateEvent.updateOffered, { release: `1.0.${i}` });
    const pending = s.pendingUpdateEvents();
    expect(pending).toHaveLength(MAX_JOURNAL);
    expect(pending[0]!.release).toBe("1.0.3");
  });

  it("a report answered late removes only the events it carried: one recorded meanwhile stays", async () => {
    const net = gatedFetch();
    const s = await session([], net.fetchImpl);
    s.recordUpdateEvent(UpdateEvent.updateOffered, { release: "1.0.1" });
    const first = s.report(); // carries [offered]
    await net.arrived(1);
    s.recordUpdateEvent(UpdateEvent.updateDownloaded, { release: "1.0.1" });
    const second = s.report(); // carries [offered, downloaded]
    await net.arrived(2);
    net.answer(0, new Response("{}"));
    expect(await first).toBe(true);
    // Recorded while the second report is still out: it was never sent.
    s.recordUpdateEvent(UpdateEvent.updateApplied, { release: "1.0.1" });
    net.answer(1, new Response("{}"));
    expect(await second).toBe(true);
    expect(s.pendingUpdateEvents().map((e) => e.event)).toEqual([
      "update_applied",
    ]);
  });

  it("flushUpdateEvents reports until nothing is waiting: 16 per report, the newest included", async () => {
    const seen: Array<{ updates?: unknown[] }> = [];
    const s = await session(seen);
    for (let i = 0; i < MAX_REPORT_UPDATES + 4; i += 1)
      s.recordUpdateEvent(UpdateEvent.updateOffered, { release: `1.0.${i}` });
    await s.flushUpdateEvents();
    expect(seen.map((b) => b.updates?.length)).toEqual([MAX_REPORT_UPDATES, 4]);
    expect(s.pendingUpdateEvents()).toEqual([]);
  });

  it("flushUpdateEvents sends nothing when nothing is waiting", async () => {
    const seen: unknown[] = [];
    const s = await session(seen);
    await s.flushUpdateEvents();
    expect(seen).toEqual([]);
  });

  it("flushUpdateEvents stops at a report that fails; the events wait for the next one", async () => {
    let up = false;
    let requests = 0;
    const s = await session([], (async () => {
      requests += 1;
      return new Response("{}", { status: up ? 200 : 503 });
    }) as unknown as typeof fetch);
    s.recordUpdateEvent(UpdateEvent.updateOffered, { release: "1.0.1" });
    await s.flushUpdateEvents();
    expect(requests).toBe(1);
    expect(s.pendingUpdateEvents()).toHaveLength(1);
    up = true;
    expect(await s.report()).toBe(true);
    expect(s.pendingUpdateEvents()).toHaveLength(0);
  });

  it("flushUpdateEvents stops waiting after FLUSH_WAIT_SECONDS; a report that lands later still removes what it carried", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const net = gatedFetch();
    const s = await session([], net.fetchImpl);
    s.recordUpdateEvent(UpdateEvent.updateOffered, { release: "1.0.1" });
    let gaveUp = false;
    const flush = s.flushUpdateEvents().then(() => (gaveUp = true));
    await net.arrived(1);
    await vi.advanceTimersByTimeAsync(FLUSH_WAIT_SECONDS * 1000 - 1);
    expect(gaveUp).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(gaveUp).toBe(true);
    await flush;
    expect(s.pendingUpdateEvents()).toHaveLength(1);
    net.answer(0, new Response("{}"));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.pendingUpdateEvents()).toHaveLength(0);
  });
});

describe("BrowserAdapter.recordUpdateEvent", () => {
  it("a cookie page answers telemetry.updates runtime-unsupported and refuses the call typed", async () => {
    const adapter = new BrowserAdapter({
      auth: "cookie",
      productSlug: "acme",
      offlineStore: null,
      autoStart: false,
    });
    expect(adapter.supports(Feature.telemetryUpdates)).toMatchObject({
      supported: false,
      reason: "runtime",
    });
    expect(adapter.caps()).not.toContain(Feature.telemetryUpdates);
    const err = await adapter
      .recordUpdateEvent(UpdateEvent.updateOffered, { release: "1.0.0" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(UnsupportedError);
    expect(err).toMatchObject({
      feature: Feature.telemetryUpdates,
      reason: "runtime",
    });
    adapter.dispose();
  });

  it("bearer mode journals into the session the report drains", async () => {
    const key = await newTestKey("pkey-test-journal-adapter");
    const adapter = new BrowserAdapter({
      auth: "bearer",
      productSlug: "acme",
      offlineStore: null,
      autoStart: false,
      version: "1.0.0",
      now: () => NOW,
      trust: { pinnedKeys: { [key.kid]: key.raw } },
      store: memoryStore("acme"),
      fetchImpl: (async () => new Response("{}")) as typeof fetch,
    });
    expect(adapter.supports(Feature.telemetryUpdates)).toMatchObject({
      supported: true,
    });
    const entry = await adapter.recordUpdateEvent(UpdateEvent.updateApplied, {
      release: "1.1.0",
      fromRelease: "1.0.0",
    });
    expect(entry).toMatchObject({
      event: "update_applied",
      release: "1.1.0",
      fromRelease: "1.0.0",
      channel: "stable",
      at: NOW,
    });
    expect(entry!.eventId).toMatch(/^[0-9a-f]{32}-update_applied$/);
    adapter.dispose();
  });
});

describe("DesktopAdapter.recordUpdateEvent: forwarded to the host's journal", () => {
  it("a v4 host gets invoke('update', 'journal', {event, ...input}) and answers the entry", async () => {
    const calls: unknown[] = [];
    const entry = {
      eventId: "h-1",
      event: "update_downloaded",
      deliverable: "app",
      release: "1.1.0",
      outlet: "steam",
      channel: "stable",
      at: NOW,
    };
    const adapter = desktopAdapter({
      bridge: {
        ...makeFakeBridge(emptyBridgeState()),
        version: 4,
        invoke: async (service: string, method: string, args?: unknown) => {
          calls.push({ service, method, args });
          return entry;
        },
      },
    });
    expect(adapter.supports(Feature.telemetryUpdates).supported).toBe(true);
    expect(
      await adapter.recordUpdateEvent(UpdateEvent.updateDownloaded, {
        release: "1.1.0",
      }),
    ).toEqual(entry);
    expect(calls).toEqual([
      {
        service: "update",
        method: "journal",
        args: { release: "1.1.0", event: "update_downloaded" },
      },
    ]);
    adapter.dispose();
  });

  it("a v3 host is refused typed (version) without the call crossing the bridge", async () => {
    const calls: unknown[] = [];
    const adapter = desktopAdapter({
      bridge: {
        ...makeFakeBridge(emptyBridgeState()),
        version: 3,
        invoke: async (service: string, method: string) => {
          calls.push({ service, method });
          return null;
        },
      },
    });
    expect(adapter.supports(Feature.telemetryUpdates)).toMatchObject({
      supported: false,
      reason: "version",
    });
    await expect(
      adapter.recordUpdateEvent(UpdateEvent.updateOffered, {
        release: "1.0.0",
      }),
    ).rejects.toMatchObject({
      feature: Feature.telemetryUpdates,
      reason: "version",
    });
    expect(calls).toEqual([]);
    adapter.dispose();
  });
});
