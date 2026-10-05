/**
 * P5-02 — the App Store Connect vocabulary mapping and the client, pure (no Worker): state
 * tables, the phased-release schedule, `X-Rate-Limit` parsing, 429 backoff and the fixed host.
 */

import { describe, expect, it } from "vitest";
import {
  AVAILABILITY_STATES,
  SUBMISSION_STATES,
} from "../src/services/distribution/availability.js";
import {
  APP_VERSION_AVAILABILITY,
  APP_VERSION_SUBMISSION,
  ASC_EVENT_EFFECTS,
  ASC_WEBHOOK_EVENT_TYPES,
  BACKGROUND_ASSET_STATES,
  EXTERNAL_BUILD_AVAILABILITY,
  INTERNAL_BUILD_AVAILABILITY,
  PHASED_RELEASE_BP,
  appVersionStateOf,
  byPlatformRank,
  platformsAbove,
  camelEventType,
  eventTypeOf,
  instanceOf,
  phasedDayToBp,
  phasedStateToRollout,
  testflightAvailability,
} from "../src/services/distribution/connectors/asc/map.js";
import {
  AscClient,
  AscError,
  ascPath,
  backoffMillis,
  parseRateLimit,
} from "../src/core/asc/client.js";
import { pollBudget } from "../src/core/storefront/budget.js";

describe("app version states", () => {
  it("READY_FOR_SALE (legacy) and READY_FOR_DISTRIBUTION both yield live", () => {
    expect(APP_VERSION_AVAILABILITY.READY_FOR_SALE).toBe("live");
    expect(APP_VERSION_AVAILABILITY.READY_FOR_DISTRIBUTION).toBe("live");
    expect(APP_VERSION_SUBMISSION.READY_FOR_SALE).toBe("released");
    expect(APP_VERSION_SUBMISSION.READY_FOR_DISTRIBUTION).toBe("released");
  });

  it("maps the brief's proposals onto P2b-03's vocabulary", () => {
    // approved-held
    expect(APP_VERSION_AVAILABILITY.PENDING_DEVELOPER_RELEASE).toBe("approved");
    expect(APP_VERSION_SUBMISSION.PENDING_DEVELOPER_RELEASE).toBe(
      "pending-developer-release",
    );
    expect(APP_VERSION_SUBMISSION.WAITING_FOR_REVIEW).toBe("submitted");
    expect(APP_VERSION_SUBMISSION.IN_REVIEW).toBe("in-review");
    for (const s of ["REJECTED", "METADATA_REJECTED", "INVALID_BINARY"]) {
      expect(APP_VERSION_AVAILABILITY[s], s).toBe("rejected");
      expect(APP_VERSION_SUBMISSION[s], s).toBe("rejected");
    }
    // superseded
    expect(APP_VERSION_AVAILABILITY.REPLACED_WITH_NEW_VERSION).toBe("removed");
  });

  it("covers every AppVersionState and every legacy AppStoreVersionState (notes/E1 §A1)", () => {
    const appVersionState = [
      "ACCEPTED",
      "DEVELOPER_REJECTED",
      "IN_REVIEW",
      "INVALID_BINARY",
      "METADATA_REJECTED",
      "PENDING_APPLE_RELEASE",
      "PENDING_DEVELOPER_RELEASE",
      "PREPARE_FOR_SUBMISSION",
      "PROCESSING_FOR_DISTRIBUTION",
      "READY_FOR_DISTRIBUTION",
      "READY_FOR_REVIEW",
      "REJECTED",
      "REPLACED_WITH_NEW_VERSION",
      "WAITING_FOR_EXPORT_COMPLIANCE",
      "WAITING_FOR_REVIEW",
    ];
    const appStoreVersionState = [
      "ACCEPTED",
      "DEVELOPER_REMOVED_FROM_SALE",
      "DEVELOPER_REJECTED",
      "IN_REVIEW",
      "INVALID_BINARY",
      "METADATA_REJECTED",
      "PENDING_APPLE_RELEASE",
      "PENDING_CONTRACT",
      "PENDING_DEVELOPER_RELEASE",
      "PREPARE_FOR_SUBMISSION",
      "PREORDER_READY_FOR_SALE",
      "PROCESSING_FOR_APP_STORE",
      "READY_FOR_REVIEW",
      "READY_FOR_SALE",
      "REJECTED",
      "REMOVED_FROM_SALE",
      "WAITING_FOR_EXPORT_COMPLIANCE",
      "WAITING_FOR_REVIEW",
      "REPLACED_WITH_NEW_VERSION",
      "NOT_APPLICABLE",
    ];
    for (const s of [...appVersionState, ...appStoreVersionState]) {
      expect(AVAILABILITY_STATES, s).toContain(APP_VERSION_AVAILABILITY[s]);
      const sub = APP_VERSION_SUBMISSION[s];
      if (sub !== undefined) expect(SUBMISSION_STATES, s).toContain(sub);
    }
  });

  it("reads appVersionState first, then the legacy appStoreState", () => {
    expect(
      appVersionStateOf({
        appVersionState: "READY_FOR_DISTRIBUTION",
        appStoreState: "READY_FOR_SALE",
      }),
    ).toBe("READY_FOR_DISTRIBUTION");
    expect(appVersionStateOf({ appStoreState: "READY_FOR_SALE" })).toBe(
      "READY_FOR_SALE",
    );
    expect(appVersionStateOf({})).toBeNull();
  });
});

describe("TestFlight states", () => {
  it("maps every internal and external build state into the vocabulary", () => {
    for (const v of [
      ...Object.values(INTERNAL_BUILD_AVAILABILITY),
      ...Object.values(EXTERNAL_BUILD_AVAILABILITY),
    ])
      expect(AVAILABILITY_STATES).toContain(v);
  });

  it("is live when any tester can install, removed when expired, else the external state", () => {
    expect(
      testflightAvailability("IN_BETA_TESTING", "WAITING_FOR_BETA_REVIEW"),
    ).toBe("live");
    expect(testflightAvailability("PROCESSING", "IN_BETA_TESTING")).toBe(
      "live",
    );
    expect(testflightAvailability("EXPIRED", "IN_BETA_TESTING")).toBe(
      "removed",
    );
    expect(
      testflightAvailability("MISSING_EXPORT_COMPLIANCE", "IN_BETA_REVIEW"),
    ).toBe("in-review");
    expect(testflightAvailability("PROCESSING", "NOT_APPLICABLE")).toBe(
      "processing",
    );
    expect(testflightAvailability(null, null)).toBeNull();
  });
});

describe("Background Asset states (ASC OpenAPI 4.5)", () => {
  it("maps every documented state of every kind into the vocabulary", () => {
    const documented: Record<string, string[]> = {
      backgroundAssetVersions: [
        "AWAITING_UPLOAD",
        "PROCESSING",
        "FAILED",
        "COMPLETE",
      ],
      backgroundAssetVersionInternalBetaReleases: [
        "READY_FOR_TESTING",
        "SUPERSEDED",
      ],
      backgroundAssetVersionExternalBetaReleases: [
        "READY_FOR_BETA_SUBMISSION",
        "WAITING_FOR_REVIEW",
        "IN_REVIEW",
        "REJECTED",
        "PROCESSING_FOR_TESTING",
        "READY_FOR_TESTING",
        "SUPERSEDED",
      ],
      backgroundAssetVersionAppStoreReleases: [
        "PREPARE_FOR_SUBMISSION",
        "READY_FOR_REVIEW",
        "WAITING_FOR_REVIEW",
        "IN_REVIEW",
        "ACCEPTED",
        "REJECTED",
        "PROCESSING_FOR_DISTRIBUTION",
        "READY_FOR_DISTRIBUTION",
        "SUPERSEDED",
      ],
    };
    for (const [type, states] of Object.entries(documented)) {
      const spec =
        BACKGROUND_ASSET_STATES[type as keyof typeof BACKGROUND_ASSET_STATES];
      expect(Object.keys(spec.states).sort(), type).toEqual([...states].sort());
      for (const s of states)
        expect(AVAILABILITY_STATES).toContain(spec.states[s]);
    }
    expect(
      BACKGROUND_ASSET_STATES.backgroundAssetVersionAppStoreReleases.states
        .READY_FOR_DISTRIBUTION,
    ).toBe("live");
    expect(
      BACKGROUND_ASSET_STATES.backgroundAssetVersionExternalBetaReleases.states
        .SUPERSEDED,
    ).toBe("removed");
  });
});

describe("phased release", () => {
  it("day 3 → 500 bp; the schedule is 1, 2, 5, 10, 20, 50, 100 %", () => {
    expect(phasedDayToBp(3)).toBe(500);
    expect([1, 2, 3, 4, 5, 6, 7].map(phasedDayToBp)).toEqual([
      ...PHASED_RELEASE_BP,
    ]);
    expect(PHASED_RELEASE_BP).toEqual([100, 200, 500, 1000, 2000, 5000, 10000]);
    expect(phasedDayToBp(0)).toBe(0);
    expect(phasedDayToBp(null)).toBe(0);
    expect(phasedDayToBp(30)).toBe(10000);
  });

  it("PAUSED mirrors as paused; INACTIVE is not mirrored", () => {
    expect(phasedStateToRollout("PAUSED")).toBe("paused");
    expect(phasedStateToRollout("ACTIVE")).toBe("active");
    expect(phasedStateToRollout("COMPLETE")).toBe("complete");
    expect(phasedStateToRollout("INACTIVE")).toBeNull();
  });
});

describe("event types and payloads", () => {
  it("every one of the 12 has an effect, and Apple's camel-case spelling resolves", () => {
    for (const t of ASC_WEBHOOK_EVENT_TYPES) {
      expect(ASC_EVENT_EFFECTS[t], t).toBeDefined();
      expect(eventTypeOf(camelEventType(t))).toBe(t);
      expect(eventTypeOf(t)).toBe(t);
    }
    expect(camelEventType("APP_STORE_VERSION_APP_VERSION_STATE_UPDATED")).toBe(
      "appStoreVersionAppVersionStateUpdated",
    );
    expect(eventTypeOf("webhookPingCreated")).toBeNull();
    expect(eventTypeOf(42)).toBeNull();
  });

  it("reads the instance in both shapes and refuses anything that is not a plain segment", () => {
    expect(
      instanceOf({
        relationships: { instance: { data: { type: "builds", id: "b-1" } } },
      }),
    ).toEqual({ type: "builds", id: "b-1" });
    expect(
      instanceOf({
        relationships: {
          instance: { type: "backgroundAssetVersions", id: "v-1", links: {} },
        },
      }),
    ).toEqual({ type: "backgroundAssetVersions", id: "v-1" });
    expect(
      instanceOf({
        relationships: { instance: { data: { type: "builds", id: "../x" } } },
      }),
    ).toBeNull();
    expect(instanceOf({})).toBeNull();
  });
});

describe("the client", () => {
  it("parses X-Rate-Limit", () => {
    expect(parseRateLimit("user-hour-lim:3500;user-hour-rem:500;")).toEqual({
      limit: 3500,
      remaining: 500,
    });
    expect(parseRateLimit(null)).toBeNull();
    expect(parseRateLimit("garbage")).toBeNull();
  });

  it("slows the poller as the remainder drops", () => {
    expect(pollBudget(null)).toBe("full");
    expect(pollBudget({ limit: 3500, remaining: 3000 })).toBe("full");
    expect(pollBudget({ limit: 3500, remaining: 500 })).toBe("reduced");
    expect(pollBudget({ limit: 3500, remaining: 100 })).toBe("skip");
  });

  it("a 429 backs off (Retry-After, else exponential) and retries", async () => {
    const waits: number[] = [];
    let n = 0;
    const client = new AscClient({
      token: async () => "jwt",
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetchImpl: async () => {
        n++;
        if (n === 1)
          return new Response("{}", {
            status: 429,
            headers: {
              "Retry-After": "3",
              "X-Rate-Limit": "user-hour-lim:3500;user-hour-rem:0;",
            },
          });
        if (n === 2) return new Response("{}", { status: 429 });
        return new Response(
          JSON.stringify({ data: { type: "apps", id: "1" } }),
          {
            status: 200,
            headers: { "X-Rate-Limit": "user-hour-lim:3500;user-hour-rem:42;" },
          },
        );
      },
    });
    const doc = await client.get(ascPath("apps", "1"));
    expect(doc?.data).toEqual({ type: "apps", id: "1" });
    expect(n).toBe(3);
    expect(waits[0]).toBe(3000);
    expect(waits[1]).toBeGreaterThanOrEqual(2000); // attempt 1: 2 s + jitter
    expect(client.lastRate).toEqual({ limit: 3500, remaining: 42 });
    expect(client.calls).toBe(3);
  });

  it("gives up after its retries with an AscError that carries the status, not the body", async () => {
    const client = new AscClient({
      token: async () => "jwt",
      sleep: async () => {},
      fetchImpl: async () =>
        new Response("secret-looking body", { status: 429 }),
    });
    const err = await client.get(ascPath("apps", "1")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AscError);
    expect((err as AscError).status).toBe(429);
    expect((err as AscError).message).not.toContain("secret-looking");
  });

  it("caps Retry-After", () => {
    const res = new Response(null, {
      status: 429,
      headers: { "Retry-After": "3600" },
    });
    expect(backoffMillis(res, 0)).toBe(10_000);
  });

  it("only ever talks to api.appstoreconnect.apple.com", async () => {
    const urls: string[] = [];
    const client = new AscClient({
      token: async () => "jwt",
      fetchImpl: async (u) => {
        urls.push(u);
        return new Response(
          JSON.stringify({
            data: [{ type: "builds", id: "1" }],
            links: { next: "https://evil.example/v1/builds?cursor=x" },
          }),
          { status: 200 },
        );
      },
    });
    const { data } = await client.getAll(ascPath("builds"), {}, 5);
    expect(data).toHaveLength(1);
    expect(urls).toEqual(["https://api.appstoreconnect.apple.com/v1/builds"]);
    expect(() => ascPath("..", "x")).toThrow();
    expect(() => ascPath("builds", "a/b")).toThrow();
    await expect(
      client.request("GET", "//evil.example/v1/x"),
    ).rejects.toThrow();
  });

  it("follows a same-host next link (JSON:API paging)", async () => {
    let page = 0;
    const client = new AscClient({
      token: async () => "jwt",
      fetchImpl: async () => {
        page++;
        return new Response(
          JSON.stringify({
            data: [{ type: "builds", id: String(page) }],
            ...(page < 3
              ? {
                  links: {
                    next: `https://api.appstoreconnect.apple.com/v1/builds?cursor=${page}`,
                  },
                }
              : {}),
          }),
          { status: 200 },
        );
      },
    });
    const { data } = await client.getAll(ascPath("builds"), {}, 5);
    expect(data.map((d) => d.id)).toEqual(["1", "2", "3"]);
  });

  it("fails closed without a token", async () => {
    const client = new AscClient({
      token: async () => null,
      fetchImpl: async () => new Response("{}"),
    });
    await expect(client.get(ascPath("apps"))).rejects.toMatchObject({
      status: 401,
    });
    expect(client.calls).toBe(0);
  });
});

describe("platform rank (one platform speaks for a release)", () => {
  it("iOS leads, then macOS; an unknown platform ranks below all", () => {
    expect(platformsAbove("IOS")).toEqual([]);
    expect(platformsAbove("MAC_OS")).toEqual(["IOS"]);
    expect(platformsAbove("TV_OS")).toEqual(["IOS", "MAC_OS", "VISION_OS"]);
    expect(platformsAbove("CAR_OS")).toEqual([
      "IOS",
      "MAC_OS",
      "VISION_OS",
      "TV_OS",
    ]);
  });

  it("orders by rank, keeping the list's order within a platform", () => {
    const items = [
      { id: "mac-new", p: "MAC_OS" },
      { id: "ios-new", p: "IOS" },
      { id: "mac-old", p: "MAC_OS" },
      { id: "none", p: null },
      { id: "ios-old", p: "IOS" },
    ];
    expect(byPlatformRank(items, (i) => i.p).map((i) => i.id)).toEqual([
      "ios-new",
      "none",
      "ios-old",
      "mac-new",
      "mac-old",
    ]);
  });
});
