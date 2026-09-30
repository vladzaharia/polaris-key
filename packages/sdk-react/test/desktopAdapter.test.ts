import { describe, expect, it, vi } from "vitest";
import {
  desktopAdapter,
  DesktopAdapter,
} from "../src/desktop/desktopAdapter.js";
import { resolveBridge } from "../src/desktop/bridge.js";
import type {
  BridgeActivation,
  BridgeOidcPoll,
  PolarisBridge,
} from "../src/desktop/bridge.js";
import {
  emptyBridgeState,
  entry,
  makeFakeBridge,
  NOW_SEC,
  okBridgeState,
} from "./fixtures.js";

// The desktop adapter is a thin renderer-side proxy over a PolarisBridge (protocol v2). These
// drive it directly with a fake bridge so the proxying, the push channel, and the error mapping
// are all covered without React.

async function ready(
  adapter: ReturnType<typeof desktopAdapter>,
): Promise<void> {
  for (let i = 0; i < 50 && adapter.snapshot().phase === "loading"; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("DesktopAdapter — construction", () => {
  it("loads the bridge state and projects it to an ok snapshot", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(okBridgeState()),
      now: () => NOW_SEC,
    });
    await ready(adapter);
    const s = adapter.snapshot();
    expect(s.mode).toBe("desktop");
    expect(s.status).toBe("ok");
    expect(s.config["theme.mode"]).toBe("dark");
    adapter.dispose();
  });

  it("throws bridge-missing when no bridge is available", () => {
    expect(() => desktopAdapter({})).toThrowError(/PolarisBridge/);
  });

  it("resolves window.polarisKey when no explicit bridge is passed", () => {
    const fake = makeFakeBridge(emptyBridgeState());
    (globalThis as unknown as { polarisKey?: PolarisBridge }).polarisKey = fake;
    try {
      expect(resolveBridge()).toBe(fake);
      const adapter = desktopAdapter({});
      expect(adapter).toBeInstanceOf(DesktopAdapter);
      adapter.dispose();
    } finally {
      delete (globalThis as unknown as { polarisKey?: PolarisBridge })
        .polarisKey;
    }
  });

  it("a first-load throw lands on a ready, error-bearing needs-activation state", async () => {
    const bridge = makeFakeBridge(emptyBridgeState());
    bridge.getSyncState = vi.fn(async () => {
      throw new Error("ipc down");
    });
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);
    const s = adapter.snapshot();
    expect(s.phase).toBe("ready");
    expect(s.status).toBe("needs-activation");
    expect(s.error.license?.code).toBe("network");
    adapter.dispose();
  });
});

// @pkey-feature core.sync license.deactivate
describe("DesktopAdapter — bridge method proxying", () => {
  it("refresh re-pulls state through the bridge", async () => {
    const bridge = makeFakeBridge(okBridgeState());
    const refreshSpy = vi.spyOn(bridge, "refresh");
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);
    await adapter.refresh();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(adapter.snapshot().status).toBe("ok");
    adapter.dispose();
  });

  it("refresh failure rejects with refresh-failed + clears both document busies", async () => {
    const bridge = makeFakeBridge(okBridgeState());
    bridge.refresh = vi.fn(async () => {
      throw new Error("offline");
    });
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);
    await expect(adapter.refresh()).rejects.toMatchObject({
      code: "refresh-failed",
    });
    expect(adapter.snapshot().busy.license).toBe(false);
    expect(adapter.snapshot().busy.config).toBe(false);
    adapter.dispose();
  });

  it("signOut delegates to the bridge and re-applies the wiped state", async () => {
    const bridge = makeFakeBridge(okBridgeState());
    const signOutSpy = vi.spyOn(bridge, "signOut");
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);
    await adapter.signOut();
    expect(signOutSpy).toHaveBeenCalledTimes(1);
    expect(adapter.snapshot().status).toBe("needs-activation");
    adapter.dispose();
  });

  it("signOut failure rejects with sign-out-failed on the IDENTITY slice", async () => {
    const bridge = makeFakeBridge(okBridgeState());
    bridge.signOut = vi.fn(async () => {
      throw new Error("locked");
    });
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);
    await expect(adapter.signOut()).rejects.toMatchObject({
      code: "sign-out-failed",
    });
    expect(adapter.snapshot().error.identity?.code).toBe("sign-out-failed");
    expect(adapter.snapshot().error.license).toBeNull();
    adapter.dispose();
  });

  it("reports the current device and rejects remote inventory without invoke()", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(okBridgeState()),
      now: () => NOW_SEC,
    });
    await ready(adapter);
    expect(adapter.currentDevice()).toMatchObject({
      id: "dev-1",
      current: true,
      status: "ok",
      licenseId: "lic-1",
    });
    await expect(adapter.listDevices()).rejects.toMatchObject({
      code: "device-management-unsupported",
    });
    await expect(adapter.deauthorizeDevice("other")).rejects.toMatchObject({
      code: "device-management-unsupported",
    });
    adapter.dispose();
  });

  it("getConfig / getSecret / isEntitled read off the snapshot", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(okBridgeState()),
      now: () => NOW_SEC,
    });
    await ready(adapter);
    expect(adapter.getConfig("theme.mode", "x")).toBe("dark");
    // The renderer never holds secrets, whatever the bridge sends.
    expect(adapter.getSecret("api.token")).toBeNull();
    expect(adapter.isEntitled("polarisVpn")).toBe(true);
    adapter.dispose();
  });
});

// @pkey-feature license.activate
describe("DesktopAdapter — submitKey", () => {
  it("submitKey applies the fresh state on an ok result", async () => {
    const bridge = makeFakeBridge(emptyBridgeState());
    bridge.submitKey = vi.fn(async () => {
      bridge.push(okBridgeState());
      return { kind: "ok" } as const;
    });
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);
    await adapter.submitKey("PK-XXXX");
    expect(bridge.submitKey).toHaveBeenCalledWith("PK-XXXX");
    expect(adapter.snapshot().status).toBe("ok");
    adapter.dispose();
  });

  it("a device-limit result throws a friendly sign-in-failed message", async () => {
    const bridge = makeFakeBridge(emptyBridgeState());
    bridge.submitKey = vi.fn(
      async () => ({ kind: "device-limit", limit: 3 }) as BridgeActivation,
    );
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);
    await expect(adapter.submitKey("k")).rejects.toMatchObject({
      code: "sign-in-failed",
    });
    expect(adapter.snapshot().error.license?.message).toMatch(/device limit/i);
    adapter.dispose();
  });

  it("an unauthorized result throws a not-accepted message", async () => {
    const bridge = makeFakeBridge(emptyBridgeState());
    bridge.submitKey = vi.fn(
      async () => ({ kind: "unauthorized" }) as BridgeActivation,
    );
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);
    await expect(adapter.submitKey("k")).rejects.toMatchObject({
      code: "sign-in-failed",
    });
    expect(adapter.snapshot().error.license?.message).toMatch(/not accepted/i);
    adapter.dispose();
  });

  it("refuses key entry outright when the license service is off", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(
        emptyBridgeState({
          capabilities: { ...emptyCaps(), config: { enabled: true } },
        }),
      ),
      now: () => NOW_SEC,
    });
    await ready(adapter);
    await expect(adapter.submitKey("k")).rejects.toMatchObject({
      code: "key-entry-unsupported",
    });
    adapter.dispose();
  });
});

function emptyCaps() {
  return {
    license: { enabled: false },
    config: { enabled: false },
    release: { enabled: false },
    update: { enabled: false },
    identity: { enabled: false },
  };
}

// @pkey-feature identity.devicecode
describe("DesktopAdapter — OIDC sign-in", () => {
  it("returns a verification handle and applies state once polling settles", async () => {
    const bridge = makeFakeBridge(emptyBridgeState());
    bridge.beginSignIn = vi.fn(async () => ({
      flowId: "f1",
      verificationUrl: "https://v",
      userCode: "ABCD",
    }));
    bridge.pollSignIn = vi.fn(async () => {
      bridge.push(okBridgeState());
      return { kind: "ok" } as BridgeOidcPoll;
    });
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);
    const handle = await adapter.signInWithOidc();
    expect(handle).toEqual({ verificationUrl: "https://v", userCode: "ABCD" });
    await ready(adapter);
    await new Promise((r) => setTimeout(r, 0));
    expect(adapter.snapshot().status).toBe("ok");
    adapter.dispose();
  });

  it("a begin-sign-in failure rejects with sign-in-failed", async () => {
    const bridge = makeFakeBridge(emptyBridgeState());
    bridge.beginSignIn = vi.fn(async () => {
      throw new Error("no browser");
    });
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);
    await expect(adapter.signInWithOidc()).rejects.toMatchObject({
      code: "sign-in-failed",
    });
    adapter.dispose();
  });

  it("refuses OIDC outright when the identity service is off", async () => {
    const bridge = makeFakeBridge(
      emptyBridgeState({
        capabilities: { ...emptyCaps(), license: { enabled: true } },
      }),
    );
    const beginSpy = vi.spyOn(bridge, "beginSignIn");
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);
    await expect(adapter.signInWithOidc()).rejects.toMatchObject({
      code: "service-disabled",
    });
    expect(beginSpy).not.toHaveBeenCalled();
    adapter.dispose();
  });
});

// @pkey-feature core.sync
describe("DesktopAdapter — stateChanged push channel", () => {
  it("a pushed state updates the snapshot (hot reload)", async () => {
    const bridge = makeFakeBridge(okBridgeState());
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);
    expect(adapter.snapshot().config["theme.mode"]).toBe("dark");
    bridge.push(
      okBridgeState({
        config: { "theme.mode": entry("enforced", "light") },
      }),
    );
    expect(adapter.snapshot().config["theme.mode"]).toBe("light");
    adapter.dispose();
  });

  it("dispose unsubscribes from the push channel (no further updates)", async () => {
    const offSpy = vi.fn();
    const bridge = makeFakeBridge(okBridgeState());
    const realOn = bridge.on.bind(bridge);
    bridge.on = (event, cb) => {
      const off = realOn(event, cb);
      return () => {
        offSpy();
        off();
      };
    };
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);
    adapter.dispose();
    expect(offSpy).toHaveBeenCalledTimes(1);
    const before = adapter.snapshot();
    bridge.push(emptyBridgeState());
    expect(adapter.snapshot()).toBe(before);
  });
});

describe("DesktopAdapter — config read APIs", () => {
  const config = {
    enforcedKey: entry("enforced", "srv"),
    hiddenKey: entry("hidden", "srv-hidden"),
    defaultKey: entry("default", "remote"),
  };

  function adapterWith(localOverrides: Record<string, unknown>) {
    return desktopAdapter({
      bridge: makeFakeBridge(okBridgeState({ config })),
      now: () => NOW_SEC,
      localOverrides: localOverrides as Record<string, never>,
    });
  }

  it("getConfig honors enforced-beats-local and default<-local precedence", async () => {
    const adapter = adapterWith({
      enforcedKey: "mine",
      defaultKey: "mine",
      onlyLocal: "z",
    });
    await ready(adapter);
    expect(adapter.getConfig("enforcedKey", "fb")).toBe("srv"); // locked
    expect(adapter.getConfig("defaultKey", "fb")).toBe("mine"); // local wins
    expect(adapter.getConfig("onlyLocal", "fb")).toBe("z"); // override-only
    expect(adapter.getConfig("absent", "fb")).toBe("fb"); // fallback
    adapter.dispose();
  });

  it("listUserConfig excludes hidden and flags enforced rows", async () => {
    const adapter = adapterWith({ defaultKey: "local" });
    await ready(adapter);
    const byKey = Object.fromEntries(
      adapter.listUserConfig().map((r) => [r.key, r]),
    );
    expect(byKey.hiddenKey).toBeUndefined();
    expect(byKey.enforcedKey?.enforced).toBe(true);
    expect(byKey.defaultKey).toEqual({
      key: "defaultKey",
      value: "local",
      enforced: false,
    });
    adapter.dispose();
  });

  it("getConfigSource reports provenance", async () => {
    const adapter = adapterWith({ defaultKey: "local" });
    await ready(adapter);
    expect(adapter.getConfigSource("enforcedKey")).toBe("enforced");
    expect(adapter.getConfigSource("hiddenKey")).toBe("hidden");
    expect(adapter.getConfigSource("defaultKey")).toBe("local");
    expect(adapter.getConfigSource("absent")).toBe("fallback");
    adapter.dispose();
  });

  it("never reports `env` provenance — a renderer has no environment to layer", async () => {
    const adapter = adapterWith({ defaultKey: "local" });
    await ready(adapter);
    for (const key of ["enforcedKey", "defaultKey", "absent"]) {
      expect(adapter.getConfigSource(key)).not.toBe("env");
    }
    adapter.dispose();
  });
});

describe("resolveBridge", () => {
  it("returns null when neither explicit nor global is present", () => {
    expect(resolveBridge()).toBeNull();
  });
});
