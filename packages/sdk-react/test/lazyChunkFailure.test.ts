// @vitest-environment node
//
// The lazily loaded hash-wasm and zstd-wasm chunks (SP-47): when a chunk will not load, the failure
// is a typed error, nothing unverified is accepted, and no unhandled rejection escapes.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReleaseRecordDoc } from "@polaris-key/protocol/release";
import { browserAdapter } from "../src/browser/browserAdapter.js";
import { memoryStore } from "../src/browser/bearer/store.js";
import { PolarisError } from "../src/core/types.js";
import { newTestKey } from "./fixtures.js";

// The chunk (or its wasm) fails to load: the module's loader rejects. Vitest mocks a throwing
// factory for its first access only, so a rejecting export is the stable stand-in.
vi.mock("hash-wasm", () => ({
  createSHA256: () =>
    Promise.reject(new Error("Failed to fetch dynamically imported module")),
}));
vi.mock("@polaris-key/zstd-wasm/browser", () => ({
  loadZstdWasm: () =>
    Promise.reject(new Error("Failed to fetch dynamically imported module")),
}));

const BASE = "https://key.plrs.im";
const PRODUCT = "djdl";
const PAYLOAD = new TextEncoder().encode("a payload that cannot be hashed");

const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => unhandled.push(e);
beforeAll(() => {
  process.on("unhandledRejection", onUnhandled);
});
afterAll(() => {
  process.off("unhandledRejection", onUnhandled);
});
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("a lazy chunk that will not load", () => {
  it("hashWasmSha256: digest() rejects typed; without digest() nothing is unhandled", async () => {
    const { hashWasmSha256 } = await import("../src/packs/browserPacks.js");
    // Never digested: its failed load must not be an unhandled rejection.
    const dropped = hashWasmSha256();
    dropped.update(PAYLOAD);
    await settle();
    const used = hashWasmSha256();
    used.update(PAYLOAD);
    const err = await Promise.resolve(used.digest()).catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe("network-error");
    await settle();
    expect(unhandled).toEqual([]);
  });

  it("browserZstd rejects typed", async () => {
    const { browserZstd } = await import("../src/packs/browserPacks.js");
    const err = await browserZstd().catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe("network-error");
    await settle();
    expect(unhandled).toEqual([]);
  });

  it("releaseFetch throws a typed network error and returns no blob", async () => {
    const product = await newTestKey("pkey-test-lazy");
    const store = memoryStore(PRODUCT);
    await store.setToken("pkeyt_test_token");
    const adapter = browserAdapter({
      productSlug: PRODUCT,
      baseUrl: BASE,
      version: "1.0.0",
      auth: "bearer",
      trust: { pinnedKeys: { [product.kid]: product.raw } },
      store,
      offlineStore: null,
      autoStart: false,
      fetchImpl: (async (input: string | URL | Request) => {
        if (String(input).endsWith("/.well-known/polaris.json"))
          return new Response(
            JSON.stringify({
              version: 2,
              product: PRODUCT,
              core: { registration: "requires-license" },
              services: {
                license: { enabled: true },
                config: { enabled: true },
                release: { enabled: true },
                distribution: {
                  enabled: true,
                  endpoints: {
                    builds: `${BASE}/${PRODUCT}/distribution/builds/{selector}/{buildId}`,
                  },
                },
                update: { enabled: false },
                identity: { enabled: false },
              },
            }),
          );
        return new Response(PAYLOAD as BodyInit, { status: 200 });
      }) as typeof fetch,
    });
    const rec = {
      version: "1.0.0",
      builds: [
        {
          id: "linux-x64",
          platform: "linux",
          arch: "x86_64",
          artifacts: [
            { role: "payload", sha256: "0".repeat(64), size: PAYLOAD.length },
          ],
        },
      ],
    } as unknown as ReleaseRecordDoc;
    const r = await adapter
      .releaseFetch({ record: rec })
      .then((v) => v)
      .catch((e: unknown) => e);
    expect(r).toBeInstanceOf(PolarisError);
    expect((r as PolarisError).code).toBe("network");
    await settle();
    expect(unhandled).toEqual([]);
    adapter.dispose();
  });
});
