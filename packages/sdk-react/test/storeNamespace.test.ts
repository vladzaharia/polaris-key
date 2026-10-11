// @vitest-environment node
// Direct persistent browser state must never be shared with a non-default control-plane host:
// the namespaced primitives first, then the BrowserAdapter's own wiring of them (the stores it
// builds when the host passes none).

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { browserAdapter } from "../src/browser/browserAdapter.js";
import { indexedDbStore } from "../src/browser/bearer/store.js";
import {
  indexedDbOfflineStore,
  openPolarisDb,
} from "../src/browser/offline.js";
import { indexedDbPresentationCache } from "../src/core/presentation.js";
import {
  storageNamespace,
  storeNamespace,
} from "../src/core/storeNamespace.js";
import type { PolarisAdapter } from "../src/core/index.js";
import { discoveryBody, newTestKey, services } from "./fixtures.js";

describe("browser durable-state namespaces", () => {
  it("preserves production names and gives each non-default host and port its own suffix", () => {
    expect(storeNamespace("acme")).toBe("acme");
    expect(storeNamespace("acme", "https://KEY.PLRS.IM:443/")).toBe("acme");
    expect(storageNamespace("https://key.plrs.im")).toBe("");
    expect(storeNamespace("acme", "http://localhost:8787")).toBe(
      "acme@localhost_8787",
    );
    expect(storageNamespace("http://localhost:8787")).toBe("@localhost_8787");
    expect(storageNamespace("http://localhost:8788")).toBe("@localhost_8788");
  });

  it("separates offline bundles, bearer tokens, and presentation caches", async () => {
    const factory = new IDBFactory();
    const local = storageNamespace("http://localhost:8787");
    const production = indexedDbOfflineStore(factory)!;
    const development = indexedDbOfflineStore(factory, local)!;

    await production.write("acme", { deviceId: "production-device" });
    await development.write("acme", { deviceId: "development-device" });
    expect(await production.read("acme")).toEqual({
      deviceId: "production-device",
    });
    expect(await development.read("acme")).toEqual({
      deviceId: "development-device",
    });

    const productionTokens = indexedDbStore("acme", { factory })!;
    const developmentTokens = indexedDbStore("acme", {
      factory,
      namespace: local,
    })!;
    await productionTokens.setToken("pkeyt_production");
    await developmentTokens.setToken("pkeyt_development");
    expect(await productionTokens.getToken()).toBe("pkeyt_production");
    expect(await developmentTokens.getToken()).toBe("pkeyt_development");

    const productionPresentation = indexedDbPresentationCache(factory)!;
    const developmentPresentation = indexedDbPresentationCache(factory, local)!;
    await productionPresentation.writeMember("acme", { name: "production" });
    await developmentPresentation.writeMember("acme", { name: "development" });
    await productionPresentation.writeIcon("same-hash", new Uint8Array([1]));
    await developmentPresentation.writeIcon("same-hash", new Uint8Array([2]));
    expect(await productionPresentation.readMember("acme")).toEqual({
      name: "production",
    });
    expect(await developmentPresentation.readMember("acme")).toEqual({
      name: "development",
    });
    expect(await productionPresentation.readIcon("same-hash")).toEqual(
      new Uint8Array([1]),
    );
    expect(await developmentPresentation.readIcon("same-hash")).toEqual(
      new Uint8Array([2]),
    );

    expect((await openPolarisDb(factory)).name).toBe("polaris-key");
    expect((await openPolarisDb(factory, local)).name).toBe(
      "polaris-key@localhost_8787",
    );
  });
});

// A BrowserAdapter handed no store of its own builds IndexedDB ones from its `baseUrl`: the
// offline record (device id, imported bundle, update cache), the bearer token and the
// presentation cache. The real adapter runs here against a fake IndexedDB, and what it created
// is read back raw, so the names asserted are the ones a browser would keep.
describe("BrowserAdapter default durable state", () => {
  const PRODUCT = "acme";
  const LOCAL = "http://localhost:8787";
  type Databases = { offline: string; presentation: string };
  /** [the page, its `baseUrl` (none: the default), the databases it keeps] */
  const hosts: [string, string | undefined, Databases][] = [
    [
      "production by default",
      undefined,
      { offline: "polaris-key", presentation: "polaris-key-presentation" },
    ],
    [
      "production by name",
      "https://KEY.PLRS.IM/",
      { offline: "polaris-key", presentation: "polaris-key-presentation" },
    ],
    [
      "a local Worker",
      LOCAL,
      {
        offline: "polaris-key@localhost_8787",
        presentation: "polaris-key-presentation@localhost_8787",
      },
    ],
  ];
  let pinnedKeys: Record<string, string>;
  /** Sized for a loaded machine, as the package's own timeouts are. */
  const patiently = { timeout: 10_000 };

  beforeAll(async () => {
    const key = await newTestKey("pkey-test-namespace");
    pinnedKeys = { [key.kid]: key.raw };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A fresh fake IndexedDB as the page's own `indexedDB`. */
  function pageIndexedDb(): IDBFactory {
    const factory = new IDBFactory();
    vi.stubGlobal("indexedDB", factory);
    return factory;
  }

  /** A control plane whose discovery names `label` as the product's presentation and which
   *  registers a device keylessly, issuing `pkeyt_<label>`: each host's state is recognisable
   *  wherever it lands. A session is never established. */
  function controlPlane(label: string): typeof fetch {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    return (async (input: RequestInfo | URL) => {
      switch (new URL(String(input)).pathname) {
        case `/${PRODUCT}/.well-known/polaris.json`: {
          const doc = JSON.parse(
            discoveryBody(services("license", "config", "identity")),
          ) as Record<string, unknown>;
          doc.core = { registration: "open", presentation: { name: label } };
          return json(doc);
        }
        case `/${PRODUCT}/identity/session`:
          return json({ authenticated: false, doc: null, csrfToken: "csrf" });
        case `/${PRODUCT}/devices/register`:
          return json({ token: `pkeyt_${label}` });
        default:
          return new Response("not found", { status: 404 });
      }
    }) as typeof fetch;
  }

  /** A page: no `offlineStore`, `store` or `presentationCache`, so the adapter builds them. */
  function page(
    auth: "cookie" | "bearer",
    fetchImpl: typeof fetch,
    baseUrl?: string,
  ): PolarisAdapter {
    return browserAdapter({
      auth,
      productSlug: PRODUCT,
      fetchImpl,
      configStorage: null,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(auth === "bearer" ? { trust: { pinnedKeys } } : {}),
    });
  }

  const loaded = (adapter: PolarisAdapter) =>
    vi.waitFor(
      () => expect(adapter.snapshot().phase).not.toBe("loading"),
      patiently,
    );

  const databaseNames = async (factory: IDBFactory) =>
    (await factory.databases()).map((d) => d.name).sort();

  const settled = <T>(req: IDBRequest<T>) =>
    new Promise<T>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

  /** One record straight from IndexedDB, bypassing the SDK's own database naming. */
  async function raw(
    factory: IDBFactory,
    database: string,
    store: string,
    key: string,
  ): Promise<unknown> {
    const db = await settled(factory.open(database));
    try {
      return await settled(
        db.transaction(store, "readonly").objectStore(store).get(key),
      );
    } finally {
      db.close();
    }
  }

  it.each(hosts)(
    "%s: a cookie page keeps its device id and presentation in that host's databases",
    async (_page, baseUrl, db) => {
      const factory = pageIndexedDb();
      const adapter = page("cookie", controlPlane("page"), baseUrl);
      await loaded(adapter);
      const deviceId = await adapter.offlineDeviceId();

      expect(deviceId).toMatch(/^[\w-]{32}$/);
      expect(await databaseNames(factory)).toEqual(
        [db.offline, db.presentation].sort(),
      );
      expect(await raw(factory, db.offline, "offline", PRODUCT)).toEqual({
        deviceId,
      });
      expect(
        await raw(factory, db.presentation, "members", PRODUCT),
      ).toMatchObject({ product: PRODUCT, presentation: { name: "page" } });
      adapter.dispose();
    },
  );

  it.each(hosts)(
    "%s: a bearer page keeps its token, device id and presentation in that host's databases",
    async (_page, baseUrl, db) => {
      const factory = pageIndexedDb();
      const adapter = page("bearer", controlPlane("page"), baseUrl);
      await loaded(adapter);
      const deviceId = await adapter.offlineDeviceId();

      expect(adapter.snapshot().activation).toBe("token");
      expect(await databaseNames(factory)).toEqual(
        [db.offline, db.presentation].sort(),
      );
      expect(await raw(factory, db.offline, "tokens", PRODUCT)).toBe(
        "pkeyt_page",
      );
      expect(await raw(factory, db.offline, "offline", PRODUCT)).toMatchObject({
        deviceId,
      });
      expect(
        await raw(factory, db.presentation, "members", PRODUCT),
      ).toMatchObject({ product: PRODUCT, presentation: { name: "page" } });
      adapter.dispose();
    },
  );

  it("a production page and a local Worker page of one product share no token, device or presentation", async () => {
    const factory = pageIndexedDb();
    const production = page("bearer", controlPlane("production"));
    const local = page("bearer", controlPlane("local"), LOCAL);
    await Promise.all([loaded(production), loaded(local)]);

    expect(await databaseNames(factory)).toEqual([
      "polaris-key",
      "polaris-key-presentation",
      "polaris-key-presentation@localhost_8787",
      "polaris-key@localhost_8787",
    ]);
    expect(await raw(factory, "polaris-key", "tokens", PRODUCT)).toBe(
      "pkeyt_production",
    );
    expect(
      await raw(factory, "polaris-key@localhost_8787", "tokens", PRODUCT),
    ).toBe("pkeyt_local");
    const productionDevice = await production.offlineDeviceId();
    const localDevice = await local.offlineDeviceId();
    expect(localDevice).not.toBe(productionDevice);
    expect(production.presentationSource().current()?.name).toBe("production");
    expect(local.presentationSource().current()?.name).toBe("local");
    production.dispose();
    local.dispose();

    // A reload with the network down: each page finds its own device and presentation and
    // presents only its own host's token.
    for (const [label, baseUrl, device] of [
      ["production", undefined, productionDevice],
      ["local", LOCAL, localDevice],
    ] as const) {
      const presented = new Set<string>();
      const reloaded = page(
        "bearer",
        (async (_input: RequestInfo | URL, init?: RequestInit) => {
          const bearer = new Headers(init?.headers).get("authorization");
          if (bearer !== null) presented.add(bearer);
          throw new TypeError("Failed to fetch");
        }) as typeof fetch,
        baseUrl,
      );
      await loaded(reloaded);
      expect(await reloaded.offlineDeviceId()).toBe(device);
      await vi.waitFor(
        () => expect(reloaded.presentationSource().current()?.name).toBe(label),
        patiently,
      );
      expect([...presented]).toEqual([`Bearer pkeyt_${label}`]);
      reloaded.dispose();
    }
  });
});
