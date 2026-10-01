// `config.fetchSchema()` — the catalog fetch (P1b-07, PARITY §5.3 `config.schema`).
//
// @pkey-feature config.schema
//
// The conversation itself is pinned by the config-schema-fetch transcript (replayed in
// conformance/runners/node/transcripts.test.ts). This file holds the failures a transcript cannot
// record: a dropped connection, a body that is not a catalog, a product without Config (D-21: not
// even probed), and local-only mode. Every one of them is `null`, never a throw — the catalog is
// unsigned and diagnostic.

import { describe, expect, it } from "vitest";
import { PolarisKeyClient } from "../src/client.js";
import { InMemoryStore } from "../src/core/store.js";
import { createLocalClient } from "../src/local/index.js";

const PRODUCT = "djdl";
const BASE = "https://k.test";
const PINS = {
  "pkey-test-prod-2026": "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI",
};
const CATALOG = {
  schemaVersion: 3,
  entries: [
    {
      key: "ui.theme",
      kind: "config",
      category: "Interface",
      label: "Theme",
      description: "Theme.",
      schema: { type: "string" },
    },
  ],
};

async function client(
  respond: () => Response | Promise<Response>,
  opts: { services?: ("license" | "config")[]; local?: boolean } = {},
): Promise<{ c: PolarisKeyClient; calls: string[] }> {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return respond();
  }) as typeof fetch;
  const options = {
    productSlug: PRODUCT,
    baseUrl: BASE,
    version: "1.0.0",
    trust: { pinnedKeys: PINS },
    trustRefresh: false,
    store: new InMemoryStore(PRODUCT),
    fetchImpl,
    expectedServices: opts.services ?? ["license", "config"],
    license: { fingerprint: false },
    devices: { fingerprint: false },
  };
  const c = opts.local
    ? await createLocalClient(options)
    : await PolarisKeyClient.create(options);
  return { c, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("config.fetchSchema()", () => {
  it("GETs /<p>/config/schema with no credential and returns the catalog", async () => {
    const { c, calls } = await client(() => json(CATALOG));
    await expect(c.config.fetchSchema()).resolves.toEqual(CATALOG);
    expect(calls).toEqual([`${BASE}/${PRODUCT}/config/schema`]);
    c.close();
  });

  it("a refusal is null", async () => {
    const { c } = await client(() => json({ error: "not_found" }, 404));
    await expect(c.config.fetchSchema()).resolves.toBeNull();
    c.close();
  });

  it("a network failure is null, not a throw", async () => {
    const { c } = await client(() => {
      throw new TypeError("fetch failed");
    });
    await expect(c.config.fetchSchema()).resolves.toBeNull();
    c.close();
  });

  it("a body that is not JSON, or not a catalog, is null", async () => {
    for (const res of [
      () => new Response("<html>", { status: 200 }),
      () => json({ entries: [] }),
      () => json([CATALOG]),
    ]) {
      const { c } = await client(res);
      await expect(c.config.fetchSchema()).resolves.toBeNull();
      c.close();
    }
  });

  it("a product without Config is null and is never probed (D-21)", async () => {
    const { c, calls } = await client(() => json(CATALOG), {
      services: ["license"],
    });
    await expect(c.config.fetchSchema()).resolves.toBeNull();
    expect(calls).toEqual([]);
    c.close();
  });

  it("local-only mode is null and makes no request", async () => {
    const { c, calls } = await client(() => json(CATALOG), { local: true });
    await expect(c.config.fetchSchema()).resolves.toBeNull();
    expect(calls).toEqual([]);
    c.close();
  });
});
