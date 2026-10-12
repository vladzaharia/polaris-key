// @pkey-feature core.store
// SP-41: a non-default base URL keeps its state under `<slug>@<host>`, so a `pkey dev` run never
// touches production state on the same machine; production names are unchanged.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CoreContext } from "../src/core/context.js";
import { FileStore } from "../src/core/store.js";
import { storeNamespace } from "../src/core/slug.js";

describe("storeNamespace", () => {
  it("leaves production names alone", () => {
    expect(storeNamespace("djdl", undefined)).toBe("djdl");
    expect(storeNamespace("djdl", "https://key.plrs.im")).toBe("djdl");
    expect(storeNamespace("djdl", "https://KEY.plrs.im/")).toBe("djdl");
  });
  it("namespaces any other host, port included", () => {
    expect(storeNamespace("djdl", "http://127.0.0.1:8787")).toBe(
      "djdl@127.0.0.1_8787",
    );
    expect(storeNamespace("djdl", "https://key.example.com")).toBe(
      "djdl@key.example.com",
    );
  });
});

describe("a dev base URL and production state", () => {
  const trust = { pinnedKeys: { k: "A".repeat(43) } };
  it("uses different directories and never writes the production one", () => {
    const base = mkdtempSync(join(tmpdir(), "pk-ns-"));
    const dirs = (baseUrl?: string) =>
      new CoreContext({
        productSlug: "djdl",
        version: "1.0.0",
        trust,
        configDir: base,
        dataDir: base,
        cacheDir: base,
        stateDir: base,
        ...(baseUrl ? { baseUrl } : {}),
        store: new FileStore("djdl", base, {
          readAnchor: () => null,
          namespace: storeNamespace("djdl", baseUrl),
        }),
      }).dirs;
    expect(dirs().config).toBe(join(base, "djdl"));
    expect(dirs("http://127.0.0.1:8787").config).toBe(
      join(base, "djdl@127.0.0.1_8787"),
    );
  });
  it("keeps the dev token out of the production file store", async () => {
    const base = mkdtempSync(join(tmpdir(), "pk-ns-"));
    const prod = new FileStore("djdl", base, { readAnchor: () => null });
    const dev = new FileStore("djdl", base, {
      readAnchor: () => null,
      namespace: storeNamespace("djdl", "http://127.0.0.1:8787"),
    });
    await prod.setToken("prod-token");
    await dev.setToken("dev-token");
    expect(await prod.getToken()).toBe("prod-token");
    expect(await dev.getToken()).toBe("dev-token");
    await dev.clearToken();
    expect(await prod.getToken()).toBe("prod-token");
  });
});
