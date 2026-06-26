import { describe, expect, it, vi } from "vitest";
import {
  desktopAdapter,
  DesktopAdapter,
} from "../src/desktop/desktopAdapter.js";
import { resolveBridge } from "../src/desktop/bridge.js";
import type {
  BridgeActivation,
  BridgeOidcPoll,
  BridgeState,
  PolarisBridge,
} from "../src/desktop/bridge.js";
import {
  entry,
  makeConfigDoc,
  makeDoc,
  makeFakeBridge,
  NOW_SEC,
} from "./fixtures.js";

// The desktop adapter is a thin renderer-side proxy over a PolarisBridge. These drive it
// directly with a fake bridge so the proxying, the push channel, and the error mapping are
// all covered without React.

async function ready(
  adapter: ReturnType<typeof desktopAdapter>,
): Promise<void> {
  for (let i = 0; i < 50 && adapter.snapshot().phase === "loading"; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("DesktopAdapter — construction", () => {
  it("loads the bridge state and projects it to an ok snapshot", async () => {
    const bridge = makeFakeBridge({
      hasToken: true,
      doc: makeDoc(),
      lastVerifiedAt: NOW_SEC * 1000,
    });
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
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
    const fake = makeFakeBridge({ hasToken: false, doc: null });
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
    const bridge = makeFakeBridge({ hasToken: false, doc: null });
    bridge.getState = vi.fn(async () => {
      throw new Error("ipc down");
    });
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);
    const s = adapter.snapshot();
    expect(s.phase).toBe("ready");
    expect(s.status).toBe("needs-activation");
    expect(s.error?.code).toBe("network");
    adapter.dispose();
  });
});

describe("DesktopAdapter — bridge method proxying", () => {
  it("refresh re-pulls state through the bridge", async () => {
    const bridge = makeFakeBridge({
      hasToken: true,
      doc: makeDoc(),
      lastVerifiedAt: NOW_SEC * 1000,
    });
    const refreshSpy = vi.spyOn(bridge, "refresh");
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);
    await adapter.refresh();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(adapter.snapshot().status).toBe("ok");
    adapter.dispose();
  });

  it("refresh failure rejects with refresh-failed + clears busy", async () => {
    const bridge = makeFakeBridge({ hasToken: true, doc: makeDoc() });
    bridge.refresh = vi.fn(async () => {
      throw new Error("offline");
    });
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);
    await expect(adapter.refresh()).rejects.toMatchObject({
      code: "refresh-failed",
    });
    expect(adapter.snapshot().busy).toBe(false);
    adapter.dispose();
  });

  it("signOut delegates to the bridge and re-applies the wiped state", async () => {
    const bridge = makeFakeBridge({ hasToken: true, doc: makeDoc() });
    const signOutSpy = vi.spyOn(bridge, "signOut");
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);
    await adapter.signOut();
    expect(signOutSpy).toHaveBeenCalledTimes(1);
    expect(adapter.snapshot().status).toBe("needs-activation");
    adapter.dispose();
  });

  it("signOut failure rejects with sign-out-failed", async () => {
    const bridge = makeFakeBridge({ hasToken: true, doc: makeDoc() });
    bridge.signOut = vi.fn(async () => {
      throw new Error("locked");
    });
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);
    await expect(adapter.signOut()).rejects.toMatchObject({
      code: "sign-out-failed",
    });
    adapter.dispose();
  });

  it("reports the current device and rejects remote device inventory", async () => {
    const bridge = makeFakeBridge({
      hasToken: true,
      doc: makeDoc(),
      lastVerifiedAt: NOW_SEC * 1000,
    });
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
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
    const bridge = makeFakeBridge({
      hasToken: true,
      doc: makeDoc(),
      lastVerifiedAt: NOW_SEC * 1000,
    });
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);
    expect(adapter.getConfig("theme.mode", "x")).toBe("dark");
    // Secrets aren't in the config map (the fixture only mirrors config), so getSecret is null.
    expect(adapter.getSecret("api.token")).toBeNull();
    expect(adapter.isEntitled("polarisVpn")).toBe(true);
    adapter.dispose();
  });
});

describe("DesktopAdapter — submitKey", () => {
  it("submitKey applies the fresh state on an ok result", async () => {
    const bridge = makeFakeBridge({ hasToken: false, doc: null });
    const submitSpy = vi.spyOn(bridge, "submitKey");
    // After a successful key, the bridge surfaces an authorized state.
    bridge.submitKey = vi.fn(async () => {
      bridge.push({
        hasToken: true,
        doc: makeDoc(),
        lastVerifiedAt: NOW_SEC * 1000,
      });
      return { kind: "ok" } as const;
    });
    void submitSpy;
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);
    await adapter.submitKey("PK-XXXX");
    expect(bridge.submitKey).toHaveBeenCalledWith("PK-XXXX");
    expect(adapter.snapshot().status).toBe("ok");
    adapter.dispose();
  });

  it("a device-limit result throws a friendly sign-in-failed message", async () => {
    const bridge = makeFakeBridge({ hasToken: false, doc: null });
    bridge.submitKey = vi.fn(
      async () => ({ kind: "device-limit", limit: 3 }) as BridgeActivation,
    );
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);
    await expect(adapter.submitKey("k")).rejects.toMatchObject({
      code: "sign-in-failed",
    });
    expect(adapter.snapshot().error?.message).toMatch(/device limit/i);
    adapter.dispose();
  });

  it("an unauthorized result throws a not-accepted message", async () => {
    const bridge = makeFakeBridge({ hasToken: false, doc: null });
    bridge.submitKey = vi.fn(
      async () => ({ kind: "unauthorized" }) as BridgeActivation,
    );
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);
    await expect(adapter.submitKey("k")).rejects.toMatchObject({
      code: "sign-in-failed",
    });
    expect(adapter.snapshot().error?.message).toMatch(/not accepted/i);
    adapter.dispose();
  });
});

describe("DesktopAdapter — OIDC sign-in", () => {
  it("returns a verification handle and applies state once polling settles", async () => {
    const bridge = makeFakeBridge({ hasToken: false, doc: null });
    bridge.beginSignIn = vi.fn(async () => ({
      flowId: "f1",
      verificationUrl: "https://v",
      userCode: "ABCD",
    }));
    bridge.pollSignIn = vi.fn(async () => {
      bridge.push({
        hasToken: true,
        doc: makeDoc(),
        lastVerifiedAt: NOW_SEC * 1000,
      });
      return { kind: "ok" } as BridgeOidcPoll;
    });
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);
    const handle = await adapter.signInWithOidc();
    expect(handle).toEqual({ verificationUrl: "https://v", userCode: "ABCD" });
    // Polling pushed an authorized state.
    await ready(adapter);
    await new Promise((r) => setTimeout(r, 0));
    expect(adapter.snapshot().status).toBe("ok");
    adapter.dispose();
  });

  it("a begin-sign-in failure rejects with sign-in-failed", async () => {
    const bridge = makeFakeBridge({ hasToken: false, doc: null });
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
});

describe("DesktopAdapter — stateChanged push channel", () => {
  it("a pushed state updates the snapshot (hot reload)", async () => {
    const bridge = makeFakeBridge({
      hasToken: true,
      doc: makeDoc(),
      lastVerifiedAt: NOW_SEC * 1000,
    });
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);
    expect(adapter.snapshot().config["theme.mode"]).toBe("dark");
    // Push a new doc with a different config value.
    const doc2 = makeDoc({
      payload: {
        config: {
          "theme.mode": { state: "enforced", value: "light", updatedAt: 950 },
        },
        secrets: {},
        entitlements: {},
      },
    });
    bridge.push({ hasToken: true, doc: doc2, lastVerifiedAt: NOW_SEC * 1000 });
    expect(adapter.snapshot().config["theme.mode"]).toBe("light");
    adapter.dispose();
  });

  it("dispose unsubscribes from the push channel (no further updates)", async () => {
    const offSpy = vi.fn();
    const bridge = makeFakeBridge({ hasToken: true, doc: makeDoc() });
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
    // A push after dispose must not change the (now-detached) snapshot.
    const before = adapter.snapshot();
    bridge.push({ hasToken: false, doc: null });
    expect(adapter.snapshot()).toBe(before);
  });
});

describe("DesktopAdapter — v2 config read APIs", () => {
  const doc = makeConfigDoc({
    enforcedKey: entry("enforced", "srv"),
    hiddenKey: entry("hidden", "srv-hidden"),
    defaultKey: entry("default", "remote"),
  });

  function adapterWith(localOverrides: Record<string, unknown>) {
    return desktopAdapter({
      bridge: makeFakeBridge({
        hasToken: true,
        doc,
        lastVerifiedAt: NOW_SEC * 1000,
      }),
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
});

describe("resolveBridge", () => {
  it("prefers an explicit bridge over the global", () => {
    const explicit = makeFakeBridge({ hasToken: false, doc: null });
    expect(resolveBridge(explicit)).toBe(explicit);
  });

  it("returns null when neither explicit nor global is present", () => {
    expect(resolveBridge()).toBeNull();
  });
});
