// Bridge protocol v2 — the contract an Electron/Tauri host implements.
//
// The load-bearing assertion here is the MIRROR: `@polaris-key/node`'s `PolarisKeyClient.getSyncState()`
// must satisfy this package's `BridgeState` with nothing in between, so a host can write
// `getSyncState: () => client.getSyncState()` in its preload and be done. `@polaris-key/node` is a
// Node-only package (keyring, `node:fs`) and cannot be a dependency of a browser bundle, so the
// mirror is pinned by re-declaring its `SyncState` here — copied from
// `packages/sdk-node/src/client.ts` — and asserting assignability at the type level. A field
// rename on either side then stops COMPILING rather than drifting quietly.

import { describe, expect, it, vi } from "vitest";
import type {
  ActivationSource,
  LicenseDoc,
} from "@polaris-key/protocol/license";
import type { BlockedState } from "@polaris-key/client-core";
import { BRIDGE_VERSION, resolveBridge } from "../src/desktop/bridge.js";
import type { BridgeState, PolarisBridge } from "../src/desktop/bridge.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import {
  emptyBridgeState,
  makeDoc,
  makeFakeBridge,
  NOW_SEC,
  okBridgeState,
  services,
} from "./fixtures.js";

/**
 * VERBATIM from `packages/sdk-node/src/client.ts`. Do not "fix" a mismatch here — fix whichever
 * side is wrong.
 */
interface NodeSyncState {
  activation: ActivationSource | null;
  doc: LicenseDoc | null;
  lastSyncUnauthorized: boolean;
  blocked: BlockedState | null;
  lastVerifiedAt: number | null;
  highWaterMark: number;
}

async function ready(adapter: {
  snapshot(): { phase: string };
}): Promise<void> {
  for (let i = 0; i < 50 && adapter.snapshot().phase === "loading"; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("BridgeState mirrors @polaris-key/node's SyncState", () => {
  it("a Node SyncState is assignable to a BridgeState, field for field", () => {
    const fromNode: NodeSyncState = {
      activation: "bundle",
      doc: makeDoc(),
      lastSyncUnauthorized: false,
      blocked: null,
      lastVerifiedAt: 1_700_000_000_000,
      highWaterMark: 1_700_000_000,
    };
    // The assignment IS the assertion: it does not compile if a field is renamed, retyped, or
    // made required on the React side without the Node side supplying it.
    const asBridge: BridgeState = fromNode;
    expect(asBridge.activation).toBe("bundle");
    expect(asBridge.highWaterMark).toBe(1_700_000_000);
  });

  it("declares its protocol revision", () => {
    expect(BRIDGE_VERSION).toBe(2);
    expect(makeFakeBridge(emptyBridgeState()).version).toBe(2);
  });

  it("v1's `hasToken` is gone outright — activation is the only credential signal", () => {
    const state = okBridgeState();
    expect("hasToken" in state).toBe(false);
    expect(state.activation).toBe("token");
  });
});

describe("desktopAdapter reads the v2 additions", () => {
  it("threads highWaterMark into the gate (a rolled-back clock stays expired)", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(
        okBridgeState({
          doc: makeDoc({ issuedAt: 1000, expiresAt: 4600, graceUntil: 10_000 }),
          highWaterMark: 20_000,
        }),
      ),
      // The host clock claims we are back inside the document's grace window.
      now: () => 5_000,
    });
    await ready(adapter);
    expect(adapter.snapshot().status).toBe("expired");
    expect(adapter.snapshot().highWaterMark).toBe(20_000);
    adapter.dispose();
  });

  it("a bundle activation is activated (no token required)", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(okBridgeState({ activation: "bundle" })),
      now: () => NOW_SEC,
    });
    await ready(adapter);
    expect(adapter.snapshot().status).toBe("ok");
    expect(adapter.snapshot().activation).toBe("bundle");
    adapter.dispose();
  });

  it("installs the bridge's capability map, and keeps expectServices when absent", async () => {
    const reported = desktopAdapter({
      bridge: makeFakeBridge(
        okBridgeState({
          capabilities: services("license", "config", "update"),
        }),
      ),
      now: () => NOW_SEC,
    });
    await ready(reported);
    expect(reported.snapshot().capabilities.update.enabled).toBe(true);
    expect(reported.snapshot().capabilities.identity.enabled).toBe(false);
    reported.dispose();

    const silent = desktopAdapter({
      bridge: makeFakeBridge({ activation: "token", doc: makeDoc() }),
      now: () => NOW_SEC,
      expectServices: services("license"),
    });
    await ready(silent);
    expect(silent.snapshot().capabilities).toEqual(services("license"));
    silent.dispose();
  });

  it("reads config entries off the CONFIG half of the v3 split", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(
        okBridgeState({
          config: {
            "theme.mode": { state: "default", value: "light", updatedAt: 1 },
          },
        }),
      ),
      now: () => NOW_SEC,
    });
    await ready(adapter);
    expect(adapter.snapshot().config["theme.mode"]).toBe("light");
    // Entitlements ride the LICENSE document (D-20), never the config one.
    expect(adapter.isEntitled("polarisVpn")).toBe(true);
    adapter.dispose();
  });
});

describe("the invoke() escape hatch", () => {
  it('routes device verbs through invoke("devices", …)', async () => {
    const bridge = makeFakeBridge(okBridgeState());
    const invoke = vi.fn(async (service: string, method: string) => {
      if (service === "devices" && method === "list") {
        return [
          { id: "dev-1", current: true, status: "ok", label: "Laptop" },
          { id: "dev-2", current: false, status: "ok", label: null },
        ];
      }
      return undefined;
    });
    bridge.invoke = invoke as PolarisBridge["invoke"];
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);

    expect(await adapter.listDevices()).toHaveLength(2);
    await adapter.renameDevice("dev-2", "Studio");
    expect(invoke).toHaveBeenCalledWith("devices", "rename", {
      deviceId: "dev-2",
      label: "Studio",
    });
    await adapter.deauthorizeDevice("dev-2");
    expect(invoke).toHaveBeenCalledWith("devices", "deauthorize", {
      deviceId: "dev-2",
    });
    adapter.dispose();
  });

  it('routes update checks through invoke("update", "check")', async () => {
    const bridge = makeFakeBridge(
      okBridgeState({ capabilities: services("license", "config", "update") }),
    );
    bridge.invoke = (async () => ({
      version: "2.0.0",
      tag: "v2.0.0",
      url: "https://dl.example/2.0.0",
      updateAvailable: true,
    })) as PolarisBridge["invoke"];
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);
    await expect(adapter.checkUpdate({ channel: "stable" })).resolves.toEqual({
      version: "2.0.0",
      tag: "v2.0.0",
      url: "https://dl.example/2.0.0",
      updateAvailable: true,
    });
    adapter.dispose();
  });

  it("a bridge without invoke reports the capability unsupported, not a TypeError", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(okBridgeState()),
      now: () => NOW_SEC,
    });
    await ready(adapter);
    await expect(adapter.listDevices()).rejects.toMatchObject({
      code: "device-management-unsupported",
    });
    await expect(adapter.renameDevice("dev-2", "x")).rejects.toMatchObject({
      code: "device-management-unsupported",
    });
    adapter.dispose();
  });

  it("deauthorizing THIS device is a local sign-out, never an invoke", async () => {
    const bridge = makeFakeBridge(okBridgeState());
    const invoke = vi.fn(async () => undefined);
    bridge.invoke = invoke as PolarisBridge["invoke"];
    const signOut = vi.spyOn(bridge, "signOut");
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);
    await adapter.deauthorizeDevice("dev-1");
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
    adapter.dispose();
  });
});

describe("resolveBridge", () => {
  it("prefers an explicit bridge over the global", () => {
    const explicit = makeFakeBridge(emptyBridgeState());
    expect(resolveBridge(explicit)).toBe(explicit);
  });

  it("returns null when neither explicit nor global is present", () => {
    expect(resolveBridge()).toBeNull();
  });
});
