import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { PolarisKeyProvider } from "../src/react/Provider.js";
import { defaultTheme } from "../src/components/theme.js";
import {
  useEntitlement,
  useLicense,
  useLicenseGate,
  useManagedConfig,
  usePolarisAuth,
  usePolarisKey,
  usePolarisTheme,
} from "../src/react/hooks.js";
import { useBoot } from "../src/react/useBoot.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import type { BridgeState } from "../src/desktop/bridge.js";
import type { PolarisAdapter } from "../src/core/index.js";
import {
  emptyBridgeState,
  entry,
  makeDoc,
  makeFakeBridge,
  makeFakeFetch,
  NOW_SEC,
  okBridgeState,
} from "./fixtures.js";

afterEach(cleanup);

function wrapperFor(adapter: PolarisAdapter) {
  return ({ children }: { children: ReactNode }) => (
    <PolarisKeyProvider productSlug="acme" adapter={adapter}>
      {children}
    </PolarisKeyProvider>
  );
}

function okBridge(): BridgeState {
  return okBridgeState();
}

describe("usePolarisKey", () => {
  it("exposes the merged surface (mode, gate, status, usable, actions)", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(okBridge()),
      now: () => NOW_SEC,
    });
    const { result } = renderHook(() => usePolarisKey(), {
      wrapper: wrapperFor(adapter),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.mode).toBe("desktop");
    expect(result.current.status).toBe("ok");
    expect(result.current.usable).toBe(true);
    expect(result.current.gate.status).toBe("ok");
    expect(typeof result.current.refresh).toBe("function");
    expect(typeof result.current.signOut).toBe("function");
    expect(result.current.getConfig("theme.mode", "x")).toBe("dark");
    expect(result.current.isEntitled("polarisVpn")).toBe(true);
    adapter.dispose();
  });
});

describe("useLicense", () => {
  it("returns the gate, status, usable, and loading flag", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(okBridge()),
      now: () => NOW_SEC,
    });
    const { result } = renderHook(() => useLicense(), {
      wrapper: wrapperFor(adapter),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({ status: "ok", usable: true });
    expect(result.current.gate.graceUntil).toBeGreaterThan(0);
    adapter.dispose();
  });
});

// @pkey-feature config.resolve
describe("useManagedConfig", () => {
  it("returns the config map + a typed getter", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(okBridge()),
      now: () => NOW_SEC,
    });
    const { result } = renderHook(() => useManagedConfig(), {
      wrapper: wrapperFor(adapter),
    });
    await waitFor(() =>
      expect(result.current.config["theme.mode"]).toBe("dark"),
    );
    expect(result.current.get("theme.mode", "light")).toBe("dark");
    expect(result.current.get("nope", "fallback")).toBe("fallback");
    adapter.dispose();
  });

  it("exposes listUserConfig + getConfigSource honoring the v3 precedence", async () => {
    const config = {
      enforcedKey: entry("enforced", "srv"),
      hiddenKey: entry("hidden", "srv-hidden"),
      defaultKey: entry("default", "remote"),
    };
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(okBridgeState({ config })),
      now: () => NOW_SEC,
      localOverrides: { enforcedKey: "ignored", defaultKey: "local" },
    });
    const { result } = renderHook(() => useManagedConfig(), {
      wrapper: wrapperFor(adapter),
    });
    await waitFor(() => expect(result.current.config.defaultKey).toBe("local"));
    // enforced beats local; default overridden by local.
    expect(result.current.get("enforcedKey", "fb")).toBe("srv");
    expect(result.current.get("defaultKey", "fb")).toBe("local");
    // hidden excluded from the settings-UI enumeration.
    const keys = result.current.listUserConfig().map((r) => r.key);
    expect(keys).toContain("enforcedKey");
    expect(keys).toContain("defaultKey");
    expect(keys).not.toContain("hiddenKey");
    // provenance.
    expect(result.current.getConfigSource("enforcedKey")).toBe("enforced");
    expect(result.current.getConfigSource("defaultKey")).toBe("local");
    adapter.dispose();
  });

  it("Provider forwards localOverrides into a built (browser) adapter", async () => {
    function Probe(): JSX.Element {
      const cfg = useManagedConfig();
      return <span data-testid="v">{String(cfg.get("defaultKey", "fb"))}</span>;
    }
    const { findByTestId } = render(
      <PolarisKeyProvider
        productSlug="acme"
        fetchImpl={makeFakeFetch(makeDoc(), {
          config: { defaultKey: entry("default", "remote") },
        })}
        now={() => NOW_SEC}
        localOverrides={{ defaultKey: "fromProvider" }}
      >
        <Probe />
      </PolarisKeyProvider>,
    );
    const node = await findByTestId("v");
    await waitFor(() => expect(node.textContent).toBe("fromProvider"));
  });
});

// @pkey-feature license.entitlements
describe("useEntitlement", () => {
  it("returns true only for a granted boolean entitlement", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(okBridge()),
      now: () => NOW_SEC,
    });
    const vpn = renderHook(() => useEntitlement("polarisVpn"), {
      wrapper: wrapperFor(adapter),
    });
    await waitFor(() => expect(vpn.result.current).toBe(true));
    adapter.dispose();
  });

  it("returns false for a disabled or unknown entitlement", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(okBridge()),
      now: () => NOW_SEC,
    });
    const beta = renderHook(() => useEntitlement("beta"), {
      wrapper: wrapperFor(adapter),
    });
    const unknown = renderHook(() => useEntitlement("nope"), {
      wrapper: wrapperFor(adapter),
    });
    await waitFor(() => expect(beta.result.current).toBe(false));
    expect(unknown.result.current).toBe(false);
    adapter.dispose();
  });
});

describe("usePolarisAuth", () => {
  it("exposes the profile, busy/error, needsAuth, and auth support flags", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(okBridge()),
      now: () => NOW_SEC,
    });
    const { result } = renderHook(() => usePolarisAuth(), {
      wrapper: wrapperFor(adapter),
    });
    await waitFor(() =>
      expect(result.current.profile?.email).toBe("ada@acme.test"),
    );
    expect(result.current.needsAuth).toBe(false);
    expect(result.current.supportsOidcLogin).toBe(true);
    expect(result.current.supportsKeyEntry).toBe(true);
    expect(result.current.status).toBe("ok");
    adapter.dispose();
  });

  it("needsAuth is true when needs-activation", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(emptyBridgeState()),
      now: () => NOW_SEC,
    });
    const { result } = renderHook(() => usePolarisAuth(), {
      wrapper: wrapperFor(adapter),
    });
    await waitFor(() => expect(result.current.status).toBe("needs-activation"));
    expect(result.current.needsAuth).toBe(true);
    adapter.dispose();
  });
});

describe("useLicenseGate", () => {
  it("maps status ok to the 'ok' screen and exposes the theme", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(okBridge()),
      now: () => NOW_SEC,
    });
    const { result } = renderHook(() => useLicenseGate(), {
      wrapper: wrapperFor(adapter),
    });
    await waitFor(() => expect(result.current.screen).toBe("ok"));
    expect(result.current.usable).toBe(true);
    expect(result.current.theme.copy.productName).toBe(
      defaultTheme.copy.productName,
    );
    adapter.dispose();
  });

  it("maps needs-activation to the 'login' screen", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(emptyBridgeState()),
      now: () => NOW_SEC,
    });
    const { result } = renderHook(() => useLicenseGate(), {
      wrapper: wrapperFor(adapter),
    });
    await waitFor(() => expect(result.current.screen).toBe("login"));
    adapter.dispose();
  });

  it("maps a 403 block to the 'version-block' screen", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(
        okBridgeState({ blocked: { reason: "version-too-old" } }),
      ),
      now: () => NOW_SEC,
    });
    const { result } = renderHook(() => useLicenseGate(), {
      wrapper: wrapperFor(adapter),
    });
    await waitFor(() => expect(result.current.screen).toBe("version-block"));
    adapter.dispose();
  });
});

describe("usePolarisTheme", () => {
  it("returns the resolved (merged) theme", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(emptyBridgeState()),
      now: () => NOW_SEC,
    });
    const { result } = renderHook(() => usePolarisTheme(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <PolarisKeyProvider
          productSlug="acme"
          adapter={adapter}
          theme={{ copy: { productName: "Acme" } }}
        >
          {children}
        </PolarisKeyProvider>
      ),
    });
    expect(result.current.copy.productName).toBe("Acme");
    // Unspecified copy falls back to the default.
    expect(result.current.copy.signInTitle).toBe("Sign in");
    adapter.dispose();
  });
});

describe("hooks outside a provider", () => {
  it("throws a clear error when used without <PolarisKeyProvider>", () => {
    function Bad(): JSX.Element {
      usePolarisKey();
      return <div />;
    }
    // Silence the React error boundary noise for this expected throw.
    const spy = console.error;
    console.error = () => undefined;
    try {
      expect(() => render(<Bad />)).toThrowError(
        /must be used within <PolarisKeyProvider>/,
      );
    } finally {
      console.error = spy;
    }
  });
});

// @pkey-feature ui.boot
describe("useBoot", () => {
  it("boots once from an effect and reports the outcome", async () => {
    const calls: string[] = [];
    const bridge = {
      ...makeFakeBridge(okBridge()),
      version: 4,
      invoke: async (service: string, method: string) => {
        calls.push(`${service}.${method}`);
        return {
          outcome: "ready",
          state: { stage: "ready", outcome: "ready" },
          license: { status: "ok" },
          decision: null,
          emits: [{ type: "boot_ready" }],
        };
      },
    };
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    const { result } = renderHook(() => useBoot(), {
      wrapper: wrapperFor(adapter),
    });
    await waitFor(() => expect(result.current.result?.outcome).toBe("ready"));
    expect(result.current.running).toBe(false);
    expect(result.current.emits).toEqual([{ type: "boot_ready" }]);
    expect(result.current.state?.stage).toBe("ready");
    expect(calls).toEqual(["core.boot"]);
    adapter.dispose();
  });

  it("auto: false waits for boot(), and a v3 host's refusal lands in error", async () => {
    const adapter = desktopAdapter({
      bridge: { ...makeFakeBridge(okBridge()), version: 3 },
      now: () => NOW_SEC,
    });
    const { result } = renderHook(() => useBoot({ auto: false }), {
      wrapper: wrapperFor(adapter),
    });
    expect(result.current.running).toBe(false);
    expect(result.current.result).toBeNull();
    await result.current.boot();
    await waitFor(() =>
      expect(result.current.error).toMatchObject({ reason: "version" }),
    );
    adapter.dispose();
  });
});
