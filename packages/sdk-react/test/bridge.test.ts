// Bridge protocol v3 — the contract an Electron/Tauri host implements.
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
import {
  BRIDGE_VERSION,
  BRIDGE_VERSIONS_ACCEPTED,
  resolveBridge,
} from "../src/desktop/bridge.js";
import type {
  BridgeHost,
  BridgeNearbyAsk,
  BridgeNearbyRequester,
  BridgeNearbyStep,
  BridgeState,
  BridgeUpdateProgress,
  KitView,
  PolarisBridge,
} from "../src/desktop/bridge.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import {
  emptyBridgeState,
  makeConfig,
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

  it("declares its protocol revision (the fixture bridge is a v2 host)", () => {
    expect(BRIDGE_VERSION).toBe(5);
    expect(makeFakeBridge(emptyBridgeState()).version).toBe(2);
  });

  it("v5 declares nearby sign-in as optional members, so a v4 host stays a PolarisBridge", () => {
    expect(BRIDGE_VERSIONS_ACCEPTED).toEqual([3, 4, 5]);
    // A v4 host: none of the v5 members. The assignment IS the assertion.
    const v4: PolarisBridge = makeFakeBridge(emptyBridgeState());
    expect(v4.autoSignIn).toBeUndefined();
    const ask: BridgeNearbyAsk = {
      askId: "ask_1",
      device: "Studio PC",
      platform: "windows",
      codes: ["123 456", "234 567", "345 678"],
    };
    const requester: BridgeNearbyRequester = {
      sessionId: "s_1",
      phase: "waiting",
      approvers: [{ id: "a_1", device: null, platform: "macos" }],
      code: "123 456",
    };
    const step: BridgeNearbyStep = { kind: "approved" };
    // A v5 host: every method, every shape, and `BridgeState.nearby` on the state push.
    const v5: PolarisBridge = {
      ...v4,
      version: 5,
      autoSignIn: async () => ({ kind: "needsSignIn", reason: "signed_out" }),
      nearbyStart: async () => requester,
      nearbyChoose: async () => requester,
      nearbyConfirm: async () => requester,
      nearbyDecline: async () => requester,
      nearbyCancel: async () => undefined,
      approverStart: async () => ({ listening: true, asks: [ask] }),
      approverStop: async () => undefined,
      approverPick: async () => step,
      approverDeny: async () => undefined,
      approverChoose: async () => ({ kind: "denied" }),
    };
    const state: BridgeState = {
      ...emptyBridgeState(),
      nearby: { requester, approver: { listening: true, asks: [ask] } },
    };
    expect(state.nearby?.approver?.asks[0]?.askId).toBe("ask_1");
    expect(v5.version).toBe(5);
  });

  it("v3's importBundle mirrors @polaris-key/node's importBundle, field for field", () => {
    /** VERBATIM from `packages/sdk-node/src/core/bundle.ts`. */
    interface NodeImportBundleResult {
      bundleId: string;
      imported: ("license" | "config")[];
    }
    const nodeImport = async (
      _jws: string,
    ): Promise<NodeImportBundleResult> => ({
      bundleId: "b1",
      imported: ["license"],
    });
    // A host writes `importBundle: (jws) => client.importBundle(jws)`; this does not compile if
    // the two shapes drift.
    const asBridge: NonNullable<PolarisBridge["importBundle"]> = nodeImport;
    expect(typeof asBridge).toBe("function");
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

  it("installs the bridge's capability map, and keeps expectedServices when absent", async () => {
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
      expectedServices: ["license"],
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

// @pkey-feature license.reregister
describe("a host-side re-register on 401 (P1b-06)", () => {
  // The renderer holds no device token (license.reregister is `na` on desktop-bridge): the
  // host's Node SDK re-registers inside its own sync. What the renderer owes is to pick up the
  // host's state afterwards, through `refresh()` or a pushed `stateChanged`, with nothing of
  // its own to retry. This fixture is a config-only product (License off) whose registered
  // device's token was revoked: the host's sync re-registers, retries the config document once
  // and reports the new document.
  const revoked = (): BridgeState =>
    okBridgeState({
      doc: null,
      capabilities: services("config"),
      config: makeConfig({
        "theme.mode": { state: "enforced", value: "dark", updatedAt: 950 },
      }),
      lastVerifiedAt: 1_000_000,
      lastSyncUnauthorized: true,
    });
  const reregistered = (): BridgeState =>
    okBridgeState({
      doc: null,
      capabilities: services("config"),
      config: makeConfig({
        "theme.mode": { state: "enforced", value: "light", updatedAt: 1990 },
      }),
      lastVerifiedAt: NOW_SEC * 1000,
      lastSyncUnauthorized: false,
    });

  it("refresh() returns the host's post-re-register state and the renderer applies it", async () => {
    const bridge = makeFakeBridge(revoked());
    const hostSync = vi.fn(async () => {
      // The host's `client.sync()`: config 401 → one POST /devices/register → retry → 200.
      bridge.push(reregistered());
      return reregistered();
    });
    bridge.refresh = hostSync;
    // A config-only build says so; a reported-off licence service never ungates a
    // build that expects it.
    const adapter = desktopAdapter({
      bridge,
      expectedServices: ["config"],
      now: () => NOW_SEC,
    });
    await ready(adapter);
    expect(adapter.snapshot().config["theme.mode"]).toBe("dark");
    expect(adapter.snapshot().status).toBe("not-applicable");

    await adapter.refresh();
    expect(hostSync).toHaveBeenCalledTimes(1);
    expect(adapter.snapshot().config["theme.mode"]).toBe("light");
    expect(adapter.snapshot().configEntries["theme.mode"]?.updatedAt).toBe(
      1990,
    );
    expect(adapter.snapshot().status).toBe("not-applicable");
    expect(adapter.snapshot().error.config).toBeNull();
    adapter.dispose();
  });

  it("a pushed stateChanged from the host's own sync lands without a renderer call", async () => {
    const bridge = makeFakeBridge(revoked());
    const refresh = vi.spyOn(bridge, "refresh");
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);
    expect(adapter.snapshot().config["theme.mode"]).toBe("dark");

    bridge.push(reregistered());
    expect(adapter.snapshot().config["theme.mode"]).toBe("light");
    expect(adapter.snapshot().configEntries["theme.mode"]?.updatedAt).toBe(
      1990,
    );
    expect(refresh).not.toHaveBeenCalled();
    adapter.dispose();
  });
});

// @pkey-feature devices.manage update.check
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

describe("the optional v4 members of UK-06 (host, onUpdateProgress, onOpen)", () => {
  it("a v4 state and bridge without them still type-check, and with them too", () => {
    const host: BridgeHost = {
      os: "linux",
      accentColor: "#3584e4",
      highContrast: false,
      reducedTransparency: true,
    };
    const withHost: BridgeState = { ...emptyBridgeState(), host };
    const without: BridgeState = emptyBridgeState();
    expect(withHost.host?.os).toBe("linux");
    expect(without.host).toBeUndefined();

    const progress: BridgeUpdateProgress = { done: 10, total: 100 };
    const view: KitView = "update";
    const seen: Array<BridgeUpdateProgress | KitView> = [];
    const bridge: PolarisBridge = {
      ...makeFakeBridge(emptyBridgeState()),
      onUpdateProgress: (cb) => {
        cb(progress);
        return () => {};
      },
      onOpen: (cb) => {
        cb(view);
        return () => {};
      },
    };
    bridge.onUpdateProgress?.((p) => seen.push(p));
    bridge.onOpen?.((v) => seen.push(v));
    expect(seen).toEqual([progress, "update"]);
    // The unchanged fake has neither: an older host.
    expect(makeFakeBridge(emptyBridgeState()).onOpen).toBeUndefined();
  });
});
