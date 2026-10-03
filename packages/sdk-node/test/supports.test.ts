// @pkey-feature core.caps
// `client.supports(feature)` and the `caps` device-telemetry key (P1b-10, PARITY §2.2).
//
// Node's capability table is generated from packages/sdk-node/parity.json, so these assertions
// are the manifest's rows seen through the client: implemented features are Supported, `planned`
// ones answer `version`, the headless N/A answers `runtime`, a service discovery has off answers
// `product`, and the one conditional N/A Node declares (`core.store` without a loadable OS
// keyring) answers `dependency`.

import { afterEach, describe, expect, it } from "vitest";
import {
  UnsupportedError,
  type StoreStatus,
  type Support,
} from "@polaris-key/client-core";
import { PolarisKeyClient } from "../src/client.js";
import {
  CAPABILITIES,
  Feature,
  FEATURE_VALUES,
  UnsupportedReason,
} from "../src/constants.generated.js";
import { InMemoryStore } from "../src/core/store.js";
import type { ServiceSlug } from "../src/discovery.js";
import * as barrel from "../src/index.js";

const PRODUCT = "djdl";
const TEST_KID = "pkey-test-prod-2026";
const TEST_PUB = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";
const BASE_URL = "https://k.test";

class StatusStore extends InMemoryStore {
  constructor(private readonly answer: StoreStatus) {
    super(PRODUCT);
  }
  override async status(): Promise<StoreStatus> {
    return this.answer;
  }
}

const KEYRING_MISSING: StoreStatus = {
  backend: "file",
  degraded: {
    reason: "keyring-unavailable",
    detail: "the @napi-rs/keyring module could not be loaded",
  },
};

interface Captured {
  impl: typeof fetch;
  reports: Record<string, unknown>[];
}

function mockFetch(services?: Partial<Record<ServiceSlug, boolean>>): Captured {
  const reports: Record<string, unknown>[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(typeof input === "string" ? input : String(input))
      .pathname;
    if (path.endsWith("/devices/report")) {
      reports.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("{}", { status: 200 });
    }
    if (path.endsWith("/.well-known/polaris.json") && services) {
      const map: Record<string, { enabled: boolean }> = {};
      for (const [slug, on] of Object.entries(services))
        map[slug] = { enabled: on === true };
      return new Response(
        JSON.stringify({
          version: 2,
          protocolVersion: 4,
          product: PRODUCT,
          baseUrl: BASE_URL,
          services: map,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, reports };
}

const open: PolarisKeyClient[] = [];
afterEach(() => {
  for (const c of open.splice(0)) c.close();
});

async function client(
  opts: {
    store?: InMemoryStore;
    fetch?: Captured;
    expectedServices?: ServiceSlug[];
  } = {},
): Promise<PolarisKeyClient> {
  const c = await PolarisKeyClient.create({
    productSlug: PRODUCT,
    baseUrl: BASE_URL,
    version: "1.2.3",
    trust: { pinnedKeys: { [TEST_KID]: TEST_PUB } },
    trustRefresh: false,
    license: { fingerprint: false },
    devices: { fingerprint: false },
    config: { env: {} },
    store: opts.store ?? new InMemoryStore(PRODUCT),
    fetchImpl: (opts.fetch ?? mockFetch()).impl,
    ...(opts.expectedServices
      ? { expectedServices: opts.expectedServices }
      : {}),
  });
  open.push(c);
  return c;
}

const reasonOf = (s: Support): string | null => (s.supported ? null : s.reason);

describe("supports() — Node's capability table", () => {
  it("config.secret is Supported in Node", async () => {
    const c = await client();
    expect(c.supports(Feature.configSecret)).toEqual({
      supported: true,
      feature: "config.secret",
    });
  });

  it("every implemented feature of a core or default service is Supported", async () => {
    const c = await client();
    for (const id of FEATURE_VALUES) {
      const row = CAPABILITIES[id];
      if (row.status !== "implemented") continue;
      if (!["core", "sdk", "license", "config"].includes(row.service)) continue;
      expect(c.supports(id), id).toMatchObject({ supported: true });
    }
  });

  it("the headless ui.kit and the platform transports are runtime", async () => {
    const c = await client();
    expect(reasonOf(c.supports(Feature.uiKit))).toBe(UnsupportedReason.runtime);
    expect(reasonOf(c.supports(Feature.packsTransportApple))).toBe(
      UnsupportedReason.runtime,
    );
  });

  it("a planned feature, and an id this SDK does not know, are version", async () => {
    const c = await client();
    const planned = c.supports(Feature.updateBootguard);
    expect(planned).toMatchObject({ supported: false, reason: "version" });
    expect(!planned.supported && planned.detail).toMatch(
      /^@polaris-key\/node \S+ does not implement update\.bootguard yet$/,
    );
    expect(reasonOf(c.supports("future.feature"))).toBe(
      UnsupportedReason.version,
    );
  });

  it("a service discovery has off is product for its features; on, they are Supported", async () => {
    const off = await client({
      fetch: mockFetch({ license: true, config: true, update: false }),
    });
    expect((await off.discover()).kind).toBe("ok");
    expect(off.supports(Feature.updateDecide)).toEqual({
      supported: false,
      feature: "update.decide",
      reason: "product",
      detail: "the product does not run the update service",
    });
    // Core is always on.
    expect(off.supports(Feature.coreVerify).supported).toBe(true);

    const on = await client({
      fetch: mockFetch({ license: true, config: true, update: true }),
    });
    await on.discover();
    expect(on.supports(Feature.updateDecide).supported).toBe(true);
  });

  it("before discovery the fail-closed fallback decides product", async () => {
    // The suite default runs no Update service, so the client refuses its sub-client and
    // supports() says so; expecting it flips both.
    expect(reasonOf((await client()).supports(Feature.updateCheck))).toBe(
      "product",
    );
    expect(
      (await client({ expectedServices: ["update"] })).supports(
        Feature.updateCheck,
      ).supported,
    ).toBe(true);
  });

  it("core.store without a loadable OS keyring is dependency; with one it is Supported", async () => {
    const missing = await client({ store: new StatusStore(KEYRING_MISSING) });
    const r = missing.supports(Feature.coreStore);
    expect(r).toMatchObject({ supported: false, reason: "dependency" });
    expect(!r.supported && r.detail).toContain("0600 file");

    const keyring = await client({
      store: new StatusStore({ backend: "keyring" }),
    });
    expect(keyring.supports(Feature.coreStore).supported).toBe(true);

    // A keyring that loaded but failed once is a degraded store, not a missing dependency.
    const flaky = await client({
      store: new StatusStore({
        backend: "file",
        degraded: { reason: "keyring-error" },
      }),
    });
    expect(flaky.supports(Feature.coreStore).supported).toBe(true);
  });

  it("caps() lists exactly the Supported ids, in registry order", async () => {
    const c = await client({ store: new StatusStore(KEYRING_MISSING) });
    const caps = c.caps();
    expect(caps).toEqual(
      FEATURE_VALUES.filter((id) => c.supports(id).supported),
    );
    expect(caps).toContain("core.verify");
    expect(caps).not.toContain("core.store");
    expect(caps).not.toContain("ui.kit");
  });

  it("is reachable from the package barrel", () => {
    expect(barrel.UnsupportedError).toBe(UnsupportedError);
  });
});

describe("a refused call carries supports()'s fields", () => {
  it("a sub-client of a service that is off throws UnsupportedError(product), code service-unavailable", async () => {
    const c = await client({ expectedServices: ["license", "config"] });
    let thrown: unknown;
    try {
      await c.release.changelog();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UnsupportedError);
    expect(thrown).toMatchObject({
      code: "service-unavailable",
      feature: "release.changelog",
      reason: "product",
      detail: "the product does not run the release service",
    });
    // The same fields supports() answers.
    expect(c.supports(Feature.releaseChangelog)).toEqual(
      (thrown as UnsupportedError).unsupported,
    );
    await expect(c.identity.beginSignIn()).rejects.toMatchObject({
      code: "service-unavailable",
      feature: "identity.devicecode",
      reason: "product",
    });
  });
});

describe("caps in device telemetry", () => {
  it("every report carries caps, re-read from the store status of the moment", async () => {
    let status: StoreStatus = { backend: "keyring" };
    class Flipping extends InMemoryStore {
      override async status(): Promise<StoreStatus> {
        return status;
      }
    }
    const store = new Flipping(PRODUCT);
    await store.setToken("pkeyt_test");
    const fetch = mockFetch();
    const c = await client({ store, fetch, expectedServices: [] });
    await c.sync();
    expect(fetch.reports).toHaveLength(1);
    expect(fetch.reports[0]!.caps).toEqual(c.caps());
    expect(fetch.reports[0]!.caps).toContain("core.store");

    status = KEYRING_MISSING;
    await c.sync();
    expect(fetch.reports).toHaveLength(2);
    expect(fetch.reports[1]!.caps).not.toContain("core.store");
  });

  it("an explicit devices.report() carries caps too", async () => {
    const store = new InMemoryStore(PRODUCT);
    await store.setToken("pkeyt_test");
    const fetch = mockFetch();
    const c = await client({ store, fetch, expectedServices: [] });
    expect(await c.devices.report()).toBe(true);
    expect(fetch.reports).toHaveLength(1);
    expect(fetch.reports[0]!.caps).toEqual(c.caps());
    expect(fetch.reports[0]!.caps).toContain("core.verify");
  });
});
