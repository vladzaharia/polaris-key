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

import { describe, expect, it } from "vitest";
import type { CacheRecordV3, Store } from "@polaris-key/client-core";
import { BrowserAdapter } from "../src/browser/browserAdapter.js";
import { BearerSession, MAX_JOURNAL } from "../src/browser/bearer/session.js";
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
  const session = async (seen: unknown[]) => {
    key ??= await newTestKey("pkey-test-journal");
    let n = 0;
    return new BearerSession({
      baseUrl: "https://key.plrs.im",
      product: "acme",
      version: "2.0.0",
      channel: "beta",
      fetchImpl: (async (_: RequestInfo | URL, init: RequestInit = {}) => {
        seen.push(JSON.parse(String(init.body)));
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      now: () => NOW,
      pinned: { [key.kid]: key.raw },
      store: tokenStore(),
      enabled: () => true,
      outlet: () => ({ id: "web", kind: "web" }),
      eventId: (e) => `id-${(n += 1)}-${e}`,
    });
  };

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
