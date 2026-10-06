// @pkey-feature update.feeds
// The app-updater feed URLs (plans/SP-00.md D5): every row of the corpus's feed-url-matrix.json
// through `client.update.feedUrl()`, against a discovery document carrying the row's endpoint set.

import { describe, expect, it } from "vitest";
import { PolarisKeyClient } from "../src/client.js";
import { MemStore, PINS, readCorpus } from "./updateFixtures.js";

interface Row {
  name: string;
  endpoints: string;
  input: {
    kind: "appcast" | "winsparkle" | "velopack" | "appInstaller" | "zsync";
    channel?: string;
    velopackChannel?: string;
    buildId?: string;
  };
  expect: { url: string } | { unsupported: string };
}

const MATRIX = readCorpus<{
  endpointSets: Record<string, Record<string, string>>;
  rows: Row[];
}>("feed-url-matrix.json");

const BASE = "https://key.plrs.im";
const PRODUCT = "full";

function client(endpoints: Record<string, string>): PolarisKeyClient {
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
    store: new MemStore("dev_feed_matrix"),
    fetchImpl: (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/polaris.json"))
        return new Response(JSON.stringify(discovery));
      return new Response("", { status: 404 });
    }) as typeof fetch,
  });
}

describe("feed-url-matrix.json through update.feedUrl()", () => {
  it("the matrix has rows", () => {
    expect(MATRIX.rows.length).toBeGreaterThan(0);
  });

  for (const row of MATRIX.rows) {
    it(row.name, async () => {
      const c = client(MATRIX.endpointSets[row.endpoints]!);
      const { kind, ...opts } = row.input;
      const got = await c.update.feedUrl(kind, opts);
      if ("url" in row.expect)
        expect(got).toEqual({ supported: true, url: row.expect.url });
      else
        expect(got).toMatchObject({
          supported: false,
          reason: row.expect.unsupported,
        });
      c.close();
    });
  }
});
