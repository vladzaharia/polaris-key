// @vitest-environment jsdom
//
// @pkey-feature connect.app
//
// CC-09.2: `useCloudConnect` over a scripted client (the engine is tested in connectRelay.test.ts):
// it follows the relay's changes, hands back the verbs, and answers the typed N/A of a transport
// with no relay.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { PolarisContext } from "../src/react/context.js";
import { useCloudConnect } from "../src/react/useCloudConnect.js";
import type { PolarisAdapter } from "../src/core/index.js";
import {
  unsupportedCloudConnect,
  type CloudConnectClient,
  type CloudPeer,
} from "../src/browser/connect/index.js";

afterEach(() => cleanup());

function scripted() {
  let peers: CloudPeer[] = [];
  let relay: ReturnType<CloudConnectClient["status"]>["relay"] = "off";
  const listeners = new Set<() => void>();
  const client: CloudConnectClient = {
    ...unsupportedCloudConnect("runtime", "x"),
    unsupported: null,
    start: vi.fn(async () => {
      relay = "open";
      for (const l of listeners) l();
    }),
    peers: () => peers,
    status: () => ({
      running: relay === "open",
      lan: "off",
      lanError: null,
      relay,
      relayError: null,
    }),
    onChange: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return {
    client,
    listeners,
    join(id: string) {
      peers = [{ deviceId: id, lan: false, relay: true }];
      for (const l of listeners) l();
    },
  };
}

const wrapperFor = (cc: CloudConnectClient) => {
  const adapter = { cloudConnect: cc } as unknown as PolarisAdapter;
  return ({ children }: { children: ReactNode }) => (
    <PolarisContext.Provider value={{ adapter }}>
      {children}
    </PolarisContext.Provider>
  );
};

describe("useCloudConnect", () => {
  it("follows the relay and the devices online, and stops following on unmount", async () => {
    const s = scripted();
    const { result } = renderHook(() => useCloudConnect(), {
      wrapper: wrapperFor(s.client),
    });
    expect(result.current.status.relay).toBe("off");
    expect(result.current.peers).toEqual([]);
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status.relay).toBe("open");
    act(() => s.join("D".repeat(32)));
    expect(result.current.peers).toEqual([
      { deviceId: "D".repeat(32), lan: false, relay: true },
    ]);
    cleanup();
    expect(s.listeners.size).toBe(0);
  });

  it("says why Connect is unavailable, and its verbs refuse typed", async () => {
    const { result } = renderHook(() => useCloudConnect(), {
      wrapper: wrapperFor(unsupportedCloudConnect("version", "no verb")),
    });
    expect(result.current.unsupported).toMatchObject({
      reason: "version",
      feature: "connect.app",
    });
    await expect(result.current.start()).rejects.toMatchObject({
      name: "UnsupportedError",
    });
    expect(result.current.peers).toEqual([]);
  });
});
