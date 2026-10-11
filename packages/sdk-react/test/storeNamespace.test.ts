// @vitest-environment node
// Direct persistent browser state must never be shared with a non-default control-plane host.

import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
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
    expect(await production.read("acme")).toEqual({ deviceId: "production-device" });
    expect(await development.read("acme")).toEqual({ deviceId: "development-device" });

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
