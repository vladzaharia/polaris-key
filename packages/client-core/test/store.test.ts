// The store-status vocabulary (P1b-09 plan §2.3). Every SDK reports these exact strings, so
// the lists are pinned here and a change to them is a deliberate, reviewed edit.

import { describe, expect, it } from "vitest";
import {
  STORE_BACKENDS,
  STORE_DEGRADED_REASONS,
  type Store,
  type StoreStatus,
} from "../src/index.js";

describe("store status vocabulary", () => {
  it("pins the backends", () => {
    expect([...STORE_BACKENDS]).toEqual([
      "keyring",
      "keychain",
      "keystore",
      "file",
      "memory",
      "indexeddb",
      "custom",
    ]);
  });

  it("pins the degraded reasons", () => {
    expect([...STORE_DEGRADED_REASONS]).toEqual([
      "keyring-unavailable",
      "keyring-error",
      "legacy-keychain",
      "not-persistent",
    ]);
  });

  it("keeps status() optional on Store", async () => {
    const base = {
      getToken: async () => null,
      setToken: async () => {},
      clearToken: async () => {},
      getDeviceId: async () => "d",
      readCache: async () => null,
      writeCache: async () => {},
      clearCache: async () => {},
    };
    // A store without status() still satisfies the contract.
    const plain: Store = base;
    expect(plain.status).toBeUndefined();
    const reporting: Store = {
      ...base,
      status: async (): Promise<StoreStatus> => ({
        backend: "file",
        degraded: {
          reason: "keyring-unavailable",
          detail: "no Secret Service",
        },
      }),
    };
    expect(await reporting.status?.()).toEqual({
      backend: "file",
      degraded: { reason: "keyring-unavailable", detail: "no Secret Service" },
    });
  });
});
