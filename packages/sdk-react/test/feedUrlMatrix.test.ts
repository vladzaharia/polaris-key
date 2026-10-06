// @vitest-environment node
//
// @pkey-feature update.feeds
// The app-updater feed URLs (plans/SP-00.md D5) through the React desktop adapter: every row of
// the corpus's feed-url-matrix.json goes through `desktopAdapter().feedUrl()`, across a bridge
// whose host is the real `@polaris-key/node` client (its `client.update.feedUrl()`, which is what
// an Electron host answers `invoke("update", "feedUrl")` with), against a discovery document
// carrying the row's endpoint set. The web adapter answers the registry's runtime N/A, and a
// host that predates bridge v4 the typed `version` N/A, both as results.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CacheRecordV3, Store } from "@polaris-key/client-core";
import { PolarisKeyClient } from "../../sdk-node/src/client.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import { browserAdapter } from "../src/browser/browserAdapter.js";
import type { BridgeState, PolarisBridge } from "../src/desktop/bridge.js";
import type { FeedKind } from "../src/core/types.js";

interface Row {
  name: string;
  endpoints: string;
  input: {
    kind: FeedKind;
    channel?: string;
    velopackChannel?: string;
    buildId?: string;
  };
  expect: { url: string } | { unsupported: string };
}

const here = dirname(fileURLToPath(import.meta.url));
const MATRIX = JSON.parse(
  readFileSync(
    join(
      here,
      "..",
      "..",
      "..",
      "conformance",
      "corpus",
      "v2",
      "feed-url-matrix.json",
    ),
    "utf8",
  ),
) as { endpointSets: Record<string, Record<string, string>>; rows: Row[] };

const BASE = "https://key.plrs.im";
const PRODUCT = "full";
const PINS = {
  "pkey-test-feeds": "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI",
};

class MemStore implements Store {
  token: string | null = null;
  cache: CacheRecordV3 | null = null;
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
    return "dev_feed_matrix";
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

function hostClient(endpoints: Record<string, string>): PolarisKeyClient {
  const update =
    Object.keys(endpoints).length > 0
      ? { enabled: true, endpoints }
      : { enabled: false };
  const discovery = { product: PRODUCT, services: { update } };
  return new PolarisKeyClient({
    productSlug: PRODUCT,
    baseUrl: BASE,
    version: "1.0.0",
    trust: { pinnedKeys: PINS },
    store: new MemStore(),
    fetchImpl: (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/polaris.json"))
        return new Response(JSON.stringify(discovery));
      return new Response("", { status: 404 });
    }) as typeof fetch,
  });
}

/** A bridge v4 whose `invoke("update", "feedUrl", {kind, ...opts})` is the host client's. */
function bridgeOver(
  client: PolarisKeyClient,
  version = 4,
  calls: unknown[] = [],
): PolarisBridge {
  const state: BridgeState = { activation: null, doc: null };
  return {
    version,
    getSyncState: async () => state,
    refresh: async () => state,
    beginSignIn: async () => ({ flowId: "f" }),
    pollSignIn: async () => ({ kind: "pending" }),
    submitKey: async () => ({ kind: "ok" }),
    signOut: async () => undefined,
    on: () => () => undefined,
    invoke: async (service, method, args) => {
      calls.push({ service, method, args });
      if (service === "update" && method === "feedUrl") {
        const { kind, ...opts } = args as { kind: FeedKind } & Row["input"];
        return client.update.feedUrl(kind, opts);
      }
      throw Object.assign(new Error("invoke-not-allowed"), {
        code: "invoke-not-allowed",
      });
    },
  };
}

describe("feed-url-matrix.json through the desktop adapter's feedUrl()", () => {
  it("the matrix has rows", () => {
    expect(MATRIX.rows.length).toBeGreaterThan(0);
  });

  for (const row of MATRIX.rows) {
    it(row.name, async () => {
      const client = hostClient(MATRIX.endpointSets[row.endpoints]!);
      const calls: unknown[] = [];
      const adapter = desktopAdapter({ bridge: bridgeOver(client, 4, calls) });
      const { kind, ...opts } = row.input;
      const got = await adapter.feedUrl(kind, opts);
      if ("url" in row.expect)
        expect(got).toEqual({ supported: true, url: row.expect.url });
      else
        expect(got).toMatchObject({
          supported: false,
          reason: row.expect.unsupported,
        });
      // The renderer forwards the row's input verbatim; it computes nothing itself.
      expect(calls).toEqual([
        { service: "update", method: "feedUrl", args: { kind, ...opts } },
      ]);
      adapter.dispose();
      client.close();
    });
  }
});

describe("feedUrl() where there is no native updater feed", () => {
  it("a v3 host answers the typed version N/A without crossing the bridge", async () => {
    const client = hostClient(MATRIX.endpointSets["everything"]!);
    const calls: unknown[] = [];
    const adapter = desktopAdapter({ bridge: bridgeOver(client, 3, calls) });
    const got = await adapter.feedUrl("appcast");
    expect(got).toMatchObject({
      supported: false,
      feature: "update.feeds",
      reason: "version",
    });
    expect(calls).toEqual([]);
    expect(adapter.supports("update.feeds")).toMatchObject({
      supported: false,
      reason: "version",
    });
    adapter.dispose();
    client.close();
  });

  it("the web adapter answers the registry's runtime N/A, with no request", async () => {
    let requests = 0;
    const adapter = browserAdapter({
      productSlug: PRODUCT,
      baseUrl: BASE,
      autoStart: false,
      offlineStore: null,
      fetchImpl: (async () => {
        requests += 1;
        return new Response("{}", { status: 404 });
      }) as typeof fetch,
    });
    const got = await adapter.feedUrl("velopack", { channel: "beta" });
    expect(got).toMatchObject({
      supported: false,
      feature: "update.feeds",
      reason: "runtime",
    });
    expect(adapter.supports("update.feeds")).toEqual(got);
    expect(requests).toBe(0);
    adapter.dispose();
  });
});
