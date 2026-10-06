// `fetchSchema()` — the catalog fetch in both React transports (P1b-07, PARITY §5.3).
//
// @pkey-feature config.schema
//
// The browser conversation is pinned by the config-schema-fetch transcript (transcripts.test.ts
// replays it over `fetchCatalog`). This file holds what a transcript cannot: the adapters' D-21
// gate, a dropped connection, a body that is not a catalog, and the desktop path through the
// bridge's `fetchSchema`. Every failure is `null`, never a throw.

import { describe, expect, it } from "vitest";
import { browserAdapter } from "../src/browser/browserAdapter.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import {
  makeFakeBridge,
  makeFakeFetch,
  NOW_SEC,
  okBridgeState,
  services,
} from "./fixtures.js";

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

/** The fixture fetch, with `/config/schema` answered by `schema`. Records the schema calls. */
function fetchWith(schema: () => Response): {
  fetchImpl: typeof fetch;
  calls: string[];
} {
  const inner = makeFakeFetch(null);
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/config/schema")) {
      calls.push(url);
      return schema();
    }
    return inner(input, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function browser(fetchImpl: typeof fetch, enabled = true) {
  return browserAdapter({
    auth: "cookie",
    productSlug: "acme",
    fetchImpl,
    now: () => NOW_SEC,
    offlineStore: null,
    expectServices: enabled
      ? services("license", "config")
      : services("license"),
  });
}

describe("browser fetchSchema()", () => {
  it("returns the catalog", async () => {
    const { fetchImpl, calls } = fetchWith(() => json(CATALOG));
    await expect(browser(fetchImpl).fetchSchema()).resolves.toEqual(CATALOG);
    expect(calls).toEqual(["https://key.plrs.im/acme/config/schema"]);
  });

  it("a refusal, a dropped connection and a non-catalog body are all null", async () => {
    for (const respond of [
      () => json({ error: "not_found" }, 404),
      () => {
        throw new TypeError("Failed to fetch");
      },
      () => new Response("<html>", { status: 200 }),
      () => json({ entries: [] }),
    ]) {
      const { fetchImpl } = fetchWith(respond);
      await expect(browser(fetchImpl).fetchSchema()).resolves.toBeNull();
    }
  });

  it("a product without Config is null and is never probed (D-21)", async () => {
    // Discovery never answers here, so the pre-discovery belief (license only) stands.
    const { fetchImpl, calls } = fetchWith(() => json(CATALOG));
    const offline = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("polaris.json")
        ? new Response("", { status: 503 })
        : fetchImpl(input, init)) as typeof fetch;
    const a = browser(offline, false);
    await new Promise((r) => setTimeout(r, 0));
    await expect(a.fetchSchema()).resolves.toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("desktop fetchSchema()", () => {
  it("asks the bridge, and keeps only a catalog-shaped answer", async () => {
    for (const [answer, want] of [
      [CATALOG, CATALOG],
      [null, null],
      [{ nope: true }, null],
    ] as const) {
      const bridge = {
        ...makeFakeBridge(okBridgeState()),
        fetchSchema: async () => answer as never,
      };
      const a = desktopAdapter({ bridge, now: () => NOW_SEC });
      await expect(a.fetchSchema()).resolves.toEqual(want);
      a.dispose();
    }
  });

  it("a throwing bridge, or one without fetchSchema, is null", async () => {
    const throwing = desktopAdapter({
      bridge: {
        ...makeFakeBridge(okBridgeState()),
        fetchSchema: async () => {
          throw new Error("ipc closed");
        },
      },
      now: () => NOW_SEC,
    });
    await expect(throwing.fetchSchema()).resolves.toBeNull();
    const old = desktopAdapter({
      bridge: makeFakeBridge(okBridgeState()),
      now: () => NOW_SEC,
    });
    await expect(old.fetchSchema()).resolves.toBeNull();
  });
});
