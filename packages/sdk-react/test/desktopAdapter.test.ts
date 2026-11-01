import { describe, expect, it, vi } from "vitest";
import {
  desktopAdapter,
  DesktopAdapter,
} from "../src/desktop/desktopAdapter.js";
import { resolveBridge } from "../src/desktop/bridge.js";
import type {
  BridgeActivation,
  BridgeNearbyAsk,
  BridgeNearbyRequester,
  BridgeOidcPoll,
  BridgeState,
  BridgeUpdateProgress,
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
    // The renderer never holds secrets, whatever the bridge sends: the typed config.secret
    // desktop-bridge refusal (P1b-10).
    expect(() => adapter.getSecret("api.token")).toThrow(
      expect.objectContaining({
        code: "unsupported",
        feature: "config.secret",
        reason: "runtime",
      }),
    );
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
    expect(adapter.snapshot().error.license?.message).toMatch(
      /already on all its devices/i,
    );
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
    expect(adapter.snapshot().error.license?.message).toMatch(
      /license key wasn't accepted/i,
    );
    adapter.dispose();
  });

  it.each([
    [
      { kind: "refused", code: "license_owned" },
      "licenseOwned",
      "license_owned",
    ],
    [{ kind: "refused", code: "no_such_code" }, "refused", "no_such_code"],
    [
      { kind: "refused", code: "enroll_claimed" },
      "enrollClaimed",
      "enroll_claimed",
    ],
    [
      { kind: "fingerprint-required" },
      "fingerprintRequired",
      "fingerprint_required",
    ],
    // Code-less: a 429, a 5xx or a transport failure on the host, so never "offline".
    [{ kind: "error", message: "boom" }, "error", "server"],
  ])(
    "a v4 host's %j is classified by code, never as the device limit",
    async (result, kind, code) => {
      const bridge = makeFakeBridge(emptyBridgeState());
      bridge.submitKey = vi.fn(async () => result as BridgeActivation);
      const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
      await ready(adapter);
      const err = await adapter.submitKey("k").catch((e: unknown) => e);
      expect(err).toMatchObject({ activation: { kind, code } });
      if ("message" in result)
        expect(err).toMatchObject({ activation: { message: result.message } });
      expect((err as Error).message).not.toMatch(/all its devices/i);
      adapter.dispose();
    },
  );

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
    distribution: { enabled: false },
    update: { enabled: false },
    identity: { enabled: false },
    sync: { enabled: false },
    commerce: { enabled: false },
    connect: { enabled: false },
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
    expect(handle).toMatchObject({
      verificationUrl: "https://v",
      userCode: "ABCD",
    });
    expect(typeof (handle as { cancel?: unknown }).cancel).toBe("function");
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

// @pkey-feature identity.devicecode
describe("DesktopAdapter — signIn.start over the bridge (UK-06.16)", () => {
  const begin = () => ({
    flowId: "f1",
    verificationUrl: "https://v",
    userCode: "ABCD",
  });
  async function started(opts: Record<string, unknown>, version = 6) {
    const bridge = makeFakeBridge(emptyBridgeState());
    (bridge as { version?: number }).version = version;
    bridge.beginSignIn = vi.fn(async () => begin());
    bridge.pollSignIn = () => new Promise(() => {});
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);
    return {
      bridge,
      adapter,
      start: () => adapter.signIn.start(opts as never),
    };
  }

  it("the kit's browser channel is the device-code session, licenseChoice card accepted", async () => {
    const { bridge, adapter, start } = await started({
      channel: "browser",
      licenseChoice: "card",
    });
    await expect(start()).resolves.toMatchObject({ userCode: "ABCD" });
    expect(bridge.beginSignIn).toHaveBeenCalledTimes(1);
    adapter.dispose();
  });

  it("carries the hints, purpose attach and licenseChoice app in the beginSignIn bag (UK-42.17)", async () => {
    const { bridge, adapter, start } = await started({
      channel: "device-code",
      deviceName: "Den",
      loginHint: "ada@example.com",
      nameHint: "Ada",
      purpose: "attach",
      licenseChoice: "app",
    });
    await expect(start()).resolves.toMatchObject({ userCode: "ABCD" });
    expect(bridge.beginSignIn).toHaveBeenCalledWith({
      deviceName: "Den",
      loginHint: "ada@example.com",
      nameHint: "Ada",
      purpose: "attach",
      licenseChoice: "app",
    });
    adapter.dispose();
  });

  it("sends no bag when there is nothing to carry", async () => {
    const { bridge, adapter, start } = await started({
      channel: "device-code",
    });
    await start();
    expect(bridge.beginSignIn).toHaveBeenCalledWith(undefined);
    adapter.dispose();
  });

  it("refuses a scope typed, and a malformed hint, before the bridge is called", async () => {
    for (const [extra, name] of [
      [{ scope: "openid" }, "UnsupportedError"],
      [{ loginHint: "a".repeat(255) }, "PolarisError"],
      [{ nameHint: "a\nb" }, "PolarisError"],
      [{ purpose: "signin" }, "PolarisError"],
      [{ licenseChoice: "x" }, "PolarisError"],
    ] as const) {
      const { bridge, adapter, start } = await started({
        channel: "device-code",
        ...extra,
      });
      await expect(start()).rejects.toMatchObject({ name });
      expect(bridge.beginSignIn).not.toHaveBeenCalled();
      adapter.dispose();
    }
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

// @pkey-feature config.mint commerce.receipt
describe("DesktopAdapter — bridge v4 verbs are gated on the host's protocol version", () => {
  function hostAt(version: number | undefined) {
    const calls: string[] = [];
    const base = makeFakeBridge(okBridgeState());
    const bridge: PolarisBridge = {
      ...base,
      ...(version === undefined ? {} : { version }),
      async invoke(service: string, method: string) {
        calls.push(`${service}.${method}`);
        if (service === "config" && method === "mint")
          return { token: "edge", expiresAt: NOW_SEC + 60 };
        if (service === "commerce" && method === "binding")
          return { bindingId: "b1", products: [] };
        if (service === "commerce" && method === "claim")
          return { kind: "error", message: "nope" };
        if (service === "core" && method === "discovery") return { v: 1 };
        if (service === "core" && method === "storeStatus")
          return { backend: "keyring" };
        if (service === "devices" && method === "id") return "DEV1";
        throw new Error(`unexpected ${service}.${method}`);
      },
    };
    if (version === undefined) delete (bridge as { version?: number }).version;
    const adapter = new DesktopAdapter({ bridge, now: () => NOW_SEC });
    return { adapter, calls };
  }

  const verbs: [string, (a: DesktopAdapter) => Promise<unknown>][] = [
    ["mintToken", (a) => a.mintToken("r1")],
    ["commerceBinding", (a) => a.commerceBinding()],
    [
      "commerceClaim",
      (a) => a.commerceClaim("steam", { ticket: "t" } as never),
    ],
  ];

  for (const v of [3, undefined]) {
    it.each(verbs)(
      `a v${v ?? "1 (absent)"} host refuses %s typed, without invoking`,
      async (_name, call) => {
        const { adapter, calls } = hostAt(v);
        await ready(adapter);
        await expect(call(adapter)).rejects.toMatchObject({
          name: "UnsupportedError",
          code: "unsupported",
          reason: "version",
        });
        expect(calls).toEqual([]);
      },
    );
  }

  it("a v3 host answers the nullable v4 reads with null, without invoking", async () => {
    const { adapter, calls } = hostAt(3);
    await ready(adapter);
    expect(await adapter.discovery()).toBeNull();
    expect(await adapter.storeStatus()).toBeNull();
    expect(await adapter.offlineDeviceId()).toBeNull();
    expect(calls).toEqual([]);
  });

  it("a v3 host's supports()/caps() report the v4 features as a version N/A", async () => {
    const { adapter } = hostAt(3);
    await ready(adapter);
    for (const f of ["config.mint", "commerce.receipt", "config.local"]) {
      expect(adapter.supports(f)).toMatchObject({
        supported: false,
        reason: "version",
      });
      expect(adapter.caps()).not.toContain(f);
    }
  });

  it("a v4 host gets every v4 verb through invoke", async () => {
    const { adapter, calls } = hostAt(4);
    await ready(adapter);
    expect(await adapter.mintToken("r1")).toEqual({
      token: "edge",
      expiresAt: NOW_SEC + 60,
    });
    expect(await adapter.commerceBinding()).toEqual({
      bindingId: "b1",
      products: [],
    });
    expect(
      await adapter.commerceClaim("steam", { ticket: "t" } as never),
    ).toMatchObject({ kind: "error" });
    expect(await adapter.discovery()).toEqual({ v: 1 });
    expect(await adapter.storeStatus()).toEqual({ backend: "keyring" });
    expect(await adapter.offlineDeviceId()).toBe("DEV1");
    expect(calls).toEqual([
      "config.mint",
      "commerce.binding",
      "commerce.claim",
      "core.discovery",
      "core.storeStatus",
      "devices.id",
    ]);
  });
});

// @pkey-feature core.errors
describe("DesktopAdapter — the bridge's refusal codes stay typed (B-152)", () => {
  it("keeps invalid-argument, invoke-not-allowed and sender-refused as their own codes", async () => {
    for (const code of [
      "invalid-argument",
      "invoke-not-allowed",
      "sender-refused",
    ]) {
      const bridge: PolarisBridge = {
        ...makeFakeBridge(okBridgeState()),
        version: 4,
        async invoke() {
          throw Object.assign(new Error("refused"), { code });
        },
      };
      const adapter = new DesktopAdapter({ bridge, now: () => NOW_SEC });
      await expect(
        adapter.releaseFetch({ record: "r" } as never, { to: "a/b" }),
      ).rejects.toMatchObject({ code });
    }
  });
});

// UK-06.3: real install progress, pushed by a v4 host to the window that started the install.
describe("DesktopAdapter — installUpdate progress and host facts (UK-06.3)", () => {
  const binary = {
    action: "binary",
    method: "direct",
    release: { version: "2.0.0" },
    build: "b2",
    mandatory: false,
    critical: false,
    prestage: [],
    discardStaged: false,
  } as unknown as Parameters<DesktopAdapter["installUpdate"]>[0];

  function host(opts: { push?: boolean } = {}) {
    const subs = new Set<(p: BridgeUpdateProgress) => void>();
    const bridge: PolarisBridge = {
      ...makeFakeBridge(emptyBridgeState()),
      version: 4,
      invoke: async (_s: string, method: string) => {
        if (method === "install") {
          for (const cb of subs) cb({ done: 10, total: 100, version: "2.0.0" });
          for (const cb of subs) cb({ done: 20, total: null });
          for (const cb of subs) cb({ done: 30, total: 0 });
          return { kind: "handedOff", version: "2.0.0" };
        }
        return undefined;
      },
      ...(opts.push === false
        ? {}
        : {
            onUpdateProgress: (cb: (p: BridgeUpdateProgress) => void) => {
              subs.add(cb);
              return () => void subs.delete(cb);
            },
          }),
    };
    return { bridge, subs };
  }

  it("feeds onProgress the host's bytes, null for an unknown total, and unsubscribes", async () => {
    const { bridge, subs } = host();
    const a = desktopAdapter({ bridge, now: () => NOW_SEC });
    const seen: Array<[number, number | null]> = [];
    const out = await a.installUpdate(binary, {
      onProgress: (d, t) => seen.push([d, t]),
    });
    expect(out).toMatchObject({ kind: "handedOff" });
    expect(seen).toEqual([
      [10, 100],
      [20, null],
      [30, null],
    ]);
    expect(subs.size).toBe(0);
    a.dispose();
  });

  it("unsubscribes when the install fails, and subscribes only when asked", async () => {
    const { bridge, subs } = host();
    (bridge as { invoke: unknown }).invoke = async () => {
      throw new Error("boom");
    };
    const a = desktopAdapter({ bridge, now: () => NOW_SEC });
    await expect(
      a.installUpdate(binary, { onProgress: () => undefined }),
    ).rejects.toThrow();
    expect(subs.size).toBe(0);
    a.dispose();
  });

  it("an older host (no push) installs as before and never calls onProgress", async () => {
    const { bridge } = host({ push: false });
    const a = desktopAdapter({ bridge, now: () => NOW_SEC });
    const onProgress = vi.fn();
    expect(await a.installUpdate(binary, { onProgress })).toMatchObject({
      kind: "handedOff",
    });
    expect(onProgress).not.toHaveBeenCalled();
    a.dispose();
  });

  it("a state without host keeps today's snapshot", async () => {
    const withHost = {
      ...okBridgeState(),
      host: { os: "windows", accentColor: "#112233" },
    } as BridgeState;
    const a = desktopAdapter({
      bridge: makeFakeBridge(okBridgeState()),
      now: () => NOW_SEC,
    });
    const b = desktopAdapter({
      bridge: makeFakeBridge(withHost),
      now: () => NOW_SEC,
    });
    await ready(a);
    await ready(b);
    expect(b.snapshot().status).toBe(a.snapshot().status);
    a.dispose();
    b.dispose();
  });
});

describe("DesktopAdapter — onOpen (UK-06.4)", () => {
  it("forwards the host's open requests for the two views it knows", () => {
    const subs = new Set<(v: string) => void>();
    const bridge = {
      ...makeFakeBridge(emptyBridgeState()),
      version: 4,
      onOpen: (cb: (v: never) => void) => {
        subs.add(cb as (v: string) => void);
        return () => void subs.delete(cb as (v: string) => void);
      },
    } as PolarisBridge;
    const a = desktopAdapter({ bridge, now: () => NOW_SEC });
    const seen: string[] = [];
    const off = a.onOpen!((v) => seen.push(v));
    for (const f of subs) {
      f("settings");
      f("update");
      f("admin");
    }
    expect(seen).toEqual(["settings", "update"]);
    off();
    expect(subs.size).toBe(0);
    a.dispose();
  });

  it("an older host (no onOpen) gives an inert unsubscribe", () => {
    const a = desktopAdapter({
      bridge: makeFakeBridge(emptyBridgeState()),
      now: () => NOW_SEC,
    });
    expect(() => a.onOpen!(() => undefined)()).not.toThrow();
    a.dispose();
  });
});

// ── Bridge v5 (I-47b.2): automatic and nearby sign-in ────────────────────────────────────────

const ASK: BridgeNearbyAsk = {
  askId: "ask-1",
  device: "Studio PC",
  platform: "windows",
  codes: ["111 111", "222 222", "333 333"],
};

function v5Bridge(
  over: Partial<PolarisBridge> = {},
): PolarisBridge & { push(s: BridgeState): void } {
  return Object.assign(makeFakeBridge(emptyBridgeState()), {
    version: 5,
    ...over,
  }) as PolarisBridge & { push(s: BridgeState): void };
}

// @pkey-feature identity.autosignin
describe("DesktopAdapter — automatic sign-in over bridge v5", () => {
  it("maps the host's ladder onto AutoSignInResult", async () => {
    const answers = [
      {
        kind: "signedIn",
        via: "stored",
        subject: "ps_abc",
        activation: { licenseId: "lic_1" },
      },
      { kind: "needsSignIn", reason: "signed_out" },
      { kind: "needsSignIn", reason: "no_credential" },
      { kind: "unavailable", code: "product" },
    ] as const;
    let i = 0;
    const autoSignIn = vi.fn(async () => answers[i++]!);
    const a = new DesktopAdapter({
      bridge: v5Bridge({ autoSignIn }),
      now: () => NOW_SEC,
    });
    await ready(a);
    expect(await a.autoSignIn({ prompt: "none", deviceName: "Mac" })).toEqual({
      kind: "signedIn",
      via: "stored",
      subject: "ps_abc",
      activation: { licenseId: "lic_1" },
    });
    expect(autoSignIn).toHaveBeenCalledWith({
      prompt: "none",
      deviceName: "Mac",
    });
    expect(await a.autoSignIn()).toEqual({
      kind: "needsSignIn",
      reason: "signedOut",
    });
    expect(await a.autoSignIn()).toEqual({
      kind: "needsSignIn",
      reason: "noCredential",
    });
    expect(await a.autoSignIn()).toEqual({
      kind: "unavailable",
      code: "product",
    });
    a.dispose();
  });

  it("a host failure is a result, never a throw", async () => {
    const a = new DesktopAdapter({
      bridge: v5Bridge({
        autoSignIn: async () => {
          throw new Error("ipc down");
        },
      }),
      now: () => NOW_SEC,
    });
    await ready(a);
    expect(await a.autoSignIn()).toEqual({
      kind: "unavailable",
      code: "refused",
    });
    a.dispose();
  });

  it("a v4 host is unsupported and is never called", async () => {
    const autoSignIn = vi.fn();
    const a = new DesktopAdapter({
      bridge: v5Bridge({ version: 4, autoSignIn } as never),
      now: () => NOW_SEC,
    });
    await ready(a);
    expect(await a.autoSignIn()).toEqual({
      kind: "unavailable",
      code: "runtime",
    });
    expect(autoSignIn).not.toHaveBeenCalled();
    expect(a.supports("identity.autosignin")).toMatchObject({
      supported: false,
      reason: "version",
    });
    expect(a.caps()).not.toContain("identity.autosignin");
    a.dispose();
  });
});

// @pkey-feature identity.nearby
describe("DesktopAdapter — nearby sign-in over bridge v5", () => {
  it("D: searches, picks an approver, shows the code and ends done", async () => {
    const requester = (
      phase: BridgeNearbyRequester["phase"],
      extra: Partial<BridgeNearbyRequester> = {},
    ): BridgeNearbyRequester => ({
      sessionId: "s-1",
      phase,
      approvers: [{ id: "ref-1", device: "Mac", platform: "macos" }],
      ...extra,
    });
    const bridge = v5Bridge({
      nearbyStart: vi.fn(async () => requester("choose-approver")),
      nearbyChoose: vi.fn(async () =>
        requester("waiting", { code: "123 456" }),
      ),
      nearbyConfirm: vi.fn(async () => requester("done")),
    });
    const a = new DesktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(a);
    const s = await a.nearby.request({ deviceName: "Studio PC" });
    expect(bridge.nearbyStart).toHaveBeenCalledWith({
      deviceName: "Studio PC",
    });
    expect(s.input).toEqual({ step: "nearby-wait" });
    expect(s.state?.approvers[0]!.id).toBe("ref-1");
    await s.choose("ref-1");
    expect(bridge.nearbyChoose).toHaveBeenCalledWith("s-1", "ref-1");
    expect(s.input).toEqual({ step: "nearby-wait", code: "123 456" });
    // A push for the same session moves it; one for another session does not.
    bridge.push(
      emptyBridgeState({
        nearby: { requester: requester("confirm-account", { email: "a@b.c" }) },
      }),
    );
    expect(s.input).toEqual({ step: "confirm", email: "a@b.c" });
    bridge.push(
      emptyBridgeState({
        nearby: { requester: { ...requester("done"), sessionId: "other" } },
      }),
    );
    expect(s.phase).toBe("confirm-account");
    await s.confirm();
    expect(bridge.nearbyConfirm).toHaveBeenCalledWith("s-1");
    expect(s.input).toEqual({ step: "nearby-done" });
    a.dispose();
  });

  it("D: decline and cancel go to the host with the host's session id", async () => {
    const r: BridgeNearbyRequester = {
      sessionId: "s-2",
      phase: "confirm-account",
      approvers: [],
      email: "a@b.c",
    };
    const bridge = v5Bridge({
      nearbyStart: vi.fn(async () => r),
      nearbyDecline: vi.fn(async () => ({ ...r, phase: "cancelled" as const })),
      nearbyCancel: vi.fn(async () => undefined),
    });
    const a = new DesktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(a);
    const s = await a.nearby.request();
    await s.decline();
    expect(bridge.nearbyDecline).toHaveBeenCalledWith("s-2");
    expect(s.phase).toBe("cancelled");
    expect(s.input).toBeNull();
    await s.cancel();
    expect(bridge.nearbyCancel).toHaveBeenCalledWith("s-2");
    expect(s.state).toBeNull();
    a.dispose();
  });

  it("M: shows pushed asks, picks a code and reports each outcome", async () => {
    const pick = vi
      .fn()
      .mockResolvedValueOnce({ kind: "approved" })
      .mockResolvedValueOnce({ kind: "mismatch" });
    const bridge = v5Bridge({
      approverStart: vi.fn(async () => ({ listening: true, asks: [] })),
      approverStop: vi.fn(async () => undefined),
      approverPick: pick,
    });
    const a = new DesktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(a);
    const m = await a.nearby.approver();
    await m.start();
    expect(m.listening).toBe(true);
    bridge.push(
      emptyBridgeState({
        nearby: {
          approver: {
            listening: true,
            asks: [ASK, { ...ASK, askId: "ask-2", device: null }],
          },
        },
      }),
    );
    expect(m.asks.map((x) => x.askId)).toEqual(["ask-1", "ask-2"]);
    expect(m.input("ask-1")).toEqual({ step: "ask", device: "Studio PC" });
    expect(m.input("ask-2")).toEqual({ step: "ask" });
    expect(await m.pick("ask-1", "222 222")).toEqual({ kind: "approved" });
    expect(pick).toHaveBeenCalledWith("ask-1", "222 222");
    expect(m.input("ask-1")).toEqual({ step: "approved", device: "Studio PC" });
    await m.pick("ask-2", "333 333");
    expect(m.input("ask-2")).toEqual({ step: "mismatch" });
    await m.stop();
    expect(m.listening).toBe(false);
    expect(m.input("ask-1")).toBeNull();
    a.dispose();
  });

  it("M: a licence choice, then Choose or Deny", async () => {
    const choose = vi.fn(async () => ({ kind: "approved" }) as const);
    const deny = vi.fn(async () => undefined);
    const bridge = v5Bridge({
      approverStart: vi.fn(async () => ({ listening: true, asks: [ASK] })),
      approverPick: vi.fn(async () => ({
        kind: "choose" as const,
        choices: [
          { licenseId: "l1", name: "Pro" },
          { licenseId: "l2", name: "Team" },
        ],
      })),
      approverChoose: choose,
      approverDeny: deny,
    });
    const a = new DesktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(a);
    const m = await a.nearby.approver();
    await m.start();
    await m.pick("ask-1", "111 111");
    expect(m.input("ask-1")).toEqual({ step: "choose", device: "Studio PC" });
    expect(m.choices("ask-1").map((c) => c.licenseId)).toEqual(["l1", "l2"]);
    await m.choose("ask-1", { kind: "license", licenseId: "l2" });
    expect(choose).toHaveBeenCalledWith("ask-1", {
      kind: "license",
      licenseId: "l2",
    });
    expect(m.input("ask-1")?.step).toBe("approved");
    await m.deny("ask-1");
    expect(deny).toHaveBeenCalledWith("ask-1");
    expect(m.input("ask-1")?.step).toBe("denied");
    a.dispose();
  });

  it("M: Deny sends the host's ask and shows Denied", async () => {
    const deny = vi.fn(async () => undefined);
    const bridge = v5Bridge({
      approverStart: vi.fn(async () => ({ listening: true, asks: [ASK] })),
      approverDeny: deny,
    });
    const a = new DesktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(a);
    const m = await a.nearby.approver();
    await m.start();
    await m.deny("ask-1");
    expect(deny).toHaveBeenCalledWith("ask-1");
    expect(m.input("ask-1")).toEqual({ step: "denied", device: "Studio PC" });
    // The host drops the ask on deny; closing the outcome clears what is left.
    bridge.push(
      emptyBridgeState({ nearby: { approver: { listening: true, asks: [] } } }),
    );
    m.dismiss("ask-1");
    expect(m.input("ask-1")).toBeNull();
    a.dispose();
  });

  it("M: a stale askId refused by the host surfaces as invalid-argument", async () => {
    const refusal = Object.assign(
      new Error("That nearby request is not open."),
      {
        code: "invalid-argument",
      },
    );
    const bridge = v5Bridge({
      approverStart: vi.fn(async () => ({ listening: true, asks: [ASK] })),
      approverPick: vi.fn(async () => {
        throw refusal;
      }),
    });
    const a = new DesktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(a);
    const m = await a.nearby.approver();
    await m.start();
    await expect(m.pick("ask-1", "111 111")).rejects.toMatchObject({
      code: "invalid-argument",
      message: "That nearby request is not open.",
    });
    // Nothing is kept for the refused ask.
    expect(m.input("ask-1")?.step).toBe("ask");
    a.dispose();
  });

  it("a host push without the approver ends listening", async () => {
    const bridge = v5Bridge({
      approverStart: vi.fn(async () => ({ listening: true, asks: [ASK] })),
    });
    const a = new DesktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(a);
    const m = await a.nearby.approver();
    await m.start();
    bridge.push(emptyBridgeState({ nearby: {} }));
    expect(m.listening).toBe(false);
    expect(m.asks).toEqual([]);
    a.dispose();
  });

  it("a v4 host is unsupported for both roles and nothing crosses", async () => {
    const nearbyStart = vi.fn();
    const approverStart = vi.fn();
    const a = new DesktopAdapter({
      bridge: v5Bridge({ version: 4, nearbyStart, approverStart } as never),
      now: () => NOW_SEC,
    });
    await ready(a);
    await expect(a.nearby.request()).rejects.toMatchObject({
      unsupported: { supported: false, reason: "version" },
    });
    await expect(a.nearby.approver()).rejects.toThrowError(/protocol v5/);
    expect(nearbyStart).not.toHaveBeenCalled();
    expect(approverStart).not.toHaveBeenCalled();
    expect(a.supports("identity.nearby")).toMatchObject({
      supported: false,
      reason: "version",
    });
    a.dispose();
  });
});

// UK-42.22.7 (bridge v6): a device sign-in that ends in `choose`, and the choice verbs.
describe("DesktopAdapter — licence and device choice over bridge v6", () => {
  // @pkey-feature identity.devicecode.choice
  const CHOOSE = {
    kind: "choose",
    grant: "ref0123456789abcdef0123456789abcd",
    expiresIn: 300,
    choices: { state: "choose", choices: [] },
  } as const;

  async function mounted(version: number, invoke?: PolarisBridge["invoke"]) {
    const bridge = makeFakeBridge(emptyBridgeState());
    (bridge as { version?: number }).version = version;
    if (invoke) bridge.invoke = invoke;
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(adapter);
    return { bridge, adapter };
  }

  it("a poll that answers choose settles the session as choose, with the ref", async () => {
    const { bridge, adapter } = await mounted(6);
    bridge.beginSignIn = vi.fn(async () => ({
      flowId: "f",
      userCode: "ABCD",
      verificationUrl: "https://key.plrs.im/x",
    }));
    bridge.pollSignIn = vi.fn(async () => CHOOSE);
    const session = (await adapter.signIn.start({
      channel: "device-code",
      licenseChoice: "app",
    } as never)) as { wait(): Promise<unknown> };
    expect(await session.wait()).toEqual(CHOOSE);
    adapter.dispose();
  });

  it("refuses licenseChoice app, typed, on a host below v6", async () => {
    const { adapter } = await mounted(5);
    await expect(
      adapter.signIn.start({
        channel: "device-code",
        licenseChoice: "app",
      } as never),
    ).rejects.toMatchObject({ unsupported: { reason: "version" } });
    adapter.dispose();
  });

  it("choice.* go over invoke(identity, choice.*) and complete re-reads the state", async () => {
    const invoke = vi.fn(async (_s: string, m: string) =>
      m === "choice.complete"
        ? { kind: "ok", licenseId: "l1", subject: "ps_x", scope: "openid" }
        : { kind: "ok", view: { state: "choose", choices: [] } },
    );
    const { bridge, adapter } = await mounted(6, invoke);
    const get = vi.spyOn(bridge, "getSyncState");
    await adapter.choice.licenses("ref");
    expect(invoke).toHaveBeenLastCalledWith("identity", "choice.licenses", {
      grant: "ref",
    });
    await adapter.choice.devices("ref", "l1");
    expect(invoke).toHaveBeenLastCalledWith("identity", "choice.devices", {
      grant: "ref",
      licenseId: "l1",
    });
    const before = get.mock.calls.length;
    expect(
      await adapter.choice.complete("ref", { kind: "keep" }),
    ).toMatchObject({ kind: "ok" });
    expect(invoke).toHaveBeenLastCalledWith("identity", "choice.complete", {
      grant: "ref",
      choice: { kind: "keep" },
    });
    expect(get.mock.calls.length).toBeGreaterThan(before);
    await adapter.choice.cancel("ref");
    expect(invoke).toHaveBeenLastCalledWith("identity", "choice.cancel", {
      grant: "ref",
    });
    adapter.dispose();
  });

  it("choice.* are the typed version N/A below v6 and send nothing", async () => {
    const invoke = vi.fn(async () => ({ kind: "ok" }));
    const { adapter } = await mounted(5, invoke);
    await expect(adapter.choice.licenses("ref")).rejects.toMatchObject({
      unsupported: { reason: "version", feature: "identity.choice" },
    });
    expect(invoke).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it("discovery keeps deviceChoice from a v6 host and drops it from an older one", async () => {
    const disc = {
      services: { identity: { enabled: true, deviceChoice: true } },
    };
    for (const [version, kept] of [
      [6, true],
      [5, false],
    ] as const) {
      const { adapter } = await mounted(
        version,
        vi.fn(async () => disc),
      );
      const d = (await adapter.discovery()) as typeof disc | null;
      expect("deviceChoice" in (d?.services.identity ?? {})).toBe(kept);
      adapter.dispose();
    }
  });
});
