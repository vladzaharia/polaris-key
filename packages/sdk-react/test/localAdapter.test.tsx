// @pkey-feature core.local
// The network-free adapter (SDK parity pass §3.1, SP-R12). What this suite pins is that "never"
// is STRUCTURAL: the adapter takes no `fetch`, so a throwing global `fetch` (and a throwing
// `XMLHttpRequest`, `WebSocket` and `sendBeacon`) must never be called, whatever verb is driven.
//
// Two shapes, as `@polaris-key/node/local` documents them: every verb that would DIAL rejects
// `local-only`, loudly and at once; everything offline keeps working (the gate, config,
// `config.local`, crash tags, the boot guard and `boot()`).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { PolarisKeyProvider } from "../src/react/Provider.js";
import { useLicense, useManagedConfig } from "../src/react/hooks.js";
import { localAdapter } from "../src/local/localAdapter.js";
import { UnsupportedError } from "../src/core/caps.js";
import { PolarisError } from "../src/core/types.js";
import { services, makeDoc, makeConfig, entry, NOW_SEC } from "./fixtures.js";

const never = vi.fn(() => {
  throw new Error("the local adapter touched the network");
});

beforeEach(() => {
  vi.stubGlobal("fetch", never);
  vi.stubGlobal("XMLHttpRequest", never);
  vi.stubGlobal("WebSocket", never);
  vi.stubGlobal("EventSource", never);
  Object.defineProperty(globalThis.navigator, "sendBeacon", {
    value: never,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  never.mockClear();
});

function make(over: Parameters<typeof localAdapter>[0] | object = {}) {
  return localAdapter({
    productSlug: "acme",
    license: makeDoc(),
    config: makeConfig({ "theme.mode": entry("default", "dark") }),
    expectServices: services("license", "config"),
    storage: null,
    now: () => NOW_SEC,
    version: "1.0.0",
    ...over,
  });
}

describe("core.local: the adapter never touches the network", () => {
  it("is ready at construction, with a fixed licence state and the bundled documents", () => {
    const a = make();
    const s = a.snapshot();
    expect(s.phase).toBe("ready");
    expect(s.mode).toBe("local");
    expect(s.status).toBe("ok");
    expect(s.profile?.email).toBe("ada@acme.test");
    expect(a.isEntitled("polarisVpn")).toBe(true);
    expect(a.isEntitled("beta")).toBe(false);
    expect(a.getConfig("theme.mode", "light")).toBe("dark");
    expect(a.currentDevice()?.id).toBe("dev-1");
    expect(never).not.toHaveBeenCalled();
    a.dispose();
  });

  it("serves the fixed status the host names, whatever the document says", () => {
    const a = make({ status: "expired" });
    expect(a.snapshot().status).toBe("expired");
    a.dispose();
  });

  it("a product without License is not-applicable", () => {
    const a = make({
      license: null,
      expectServices: services("config"),
    });
    expect(a.snapshot().status).toBe("not-applicable");
    a.dispose();
  });

  it("every verb that would dial rejects local-only and calls nothing", async () => {
    const a = make();
    const dials: Array<[string, () => Promise<unknown>]> = [
      ["signInWithOidc", () => a.signInWithOidc()],
      ["submitKey", () => a.submitKey("pkey_x")],
      ["listDevices", () => a.listDevices()],
      ["renameDevice", () => a.renameDevice("d", "x")],
      ["deauthorizeDevice", () => a.deauthorizeDevice("d")],
      ["checkUpdate", () => a.checkUpdate()],
      ["decideUpdate", () => a.decideUpdate()],
      ["changelog", () => a.changelog()],
      ["installUrl", () => a.installUrl()],
      ["downloadUrl", () => a.downloadUrl("1.0.0", "app", "x64")],
      ["enroll", () => a.enroll()],
      ["beginSignIn", () => a.beginSignIn()],
      ["mintToken", () => a.mintToken("r")],
      ["commerceBinding", () => a.commerceBinding()],
      [
        "commerceClaim",
        () => a.commerceClaim("steam", { ticket: "t", dlcAppId: 1 }),
      ],
      [
        "releaseFetch",
        () => a.releaseFetch({ version: "1.0.0", platform: "web" } as never),
      ],
      ["downloadModel", () => a.downloadModel()],
      ["thisPlatform", () => a.thisPlatform()],
      ["signOut", () => a.signOut()],
    ];
    for (const [name, call] of dials) {
      const err = await call().catch((e: unknown) => e);
      expect(err, name).toBeInstanceOf(PolarisError);
      expect((err as PolarisError).code, name).toBe("local-only");
    }
    expect(never).not.toHaveBeenCalled();
    a.dispose();
  });

  it("refresh, discovery, the schema and the store answer offline", async () => {
    const a = make();
    await a.refresh();
    expect(await a.discovery()).toBeNull();
    expect(await a.fetchSchema()).toBeNull();
    expect(await a.storeStatus()).toBeNull();
    expect(await a.offlineDeviceId()).toBeNull();
    expect(a.presentationSource().current()).toBeNull();
    expect(await a.presentationSource().iconUrl(64, 1)).toBeNull();
    expect(await a.feedUrl("appcast")).toMatchObject({
      supported: false,
      reason: "runtime",
    });
    expect(never).not.toHaveBeenCalled();
    a.dispose();
  });

  it("the typed N/As keep their codes", async () => {
    const a = make();
    expect(() => a.getSecret("k")).toThrow(UnsupportedError);
    expect(await a.report().catch((e: unknown) => e)).toMatchObject({
      code: "report-unsupported",
    });
    expect(await a.importBundle("jws").catch((e: unknown) => e)).toMatchObject({
      code: "bundle-import-unsupported",
    });
    a.dispose();
  });

  it("supports() says runtime N/A for what needs the network, Supported for what does not", () => {
    const a = make({ expectServices: services("license", "config", "update") });
    expect(a.supports("core.local")).toMatchObject({ supported: true });
    expect(a.supports("update.bootguard")).toMatchObject({ supported: true });
    expect(a.supports("config.local")).toMatchObject({ supported: true });
    expect(a.supports("license.activate")).toMatchObject({
      supported: false,
      reason: "runtime",
    });
    expect(a.supports("release.fetch")).toMatchObject({ supported: false });
    expect(a.caps()).toContain("core.local");
    expect(a.caps()).not.toContain("license.activate");
    expect(a.caps().every((f) => a.supports(f).supported)).toBe(true);
    a.dispose();
  });

  it("device-local overrides work and persist in the storage the host gave", async () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    };
    const a = make({ storage });
    await a.config.set("ui.zoom", 2);
    expect(a.getConfig("ui.zoom", 1)).toBe(2);
    expect([...mem.keys()]).toEqual(["pkey:acme:config.local"]);
    a.dispose();
    const b = make({ storage });
    expect(b.getConfig("ui.zoom", 1)).toBe(2);
    b.dispose();
    expect(never).not.toHaveBeenCalled();
  });

  it("crashTags and installUpdate answer without a transport", async () => {
    const a = make();
    expect(await a.crashTags()).toMatchObject({
      release: "app@1.0.0",
      "pkey.outlet": "unknown",
    });
    expect(
      await a.installUpdate({
        action: "platform",
        release: { version: "1.1.0", seq: 2 },
        mandatory: false,
        critical: false,
        discardStaged: false,
      }),
    ).toMatchObject({ kind: "unsupported", reason: "runtime" });
    expect(
      await a.installUpdate({
        action: "store",
        release: { version: "1.1.0", seq: 2 },
        listingUrl: "https://store.test/a",
        mandatory: false,
        critical: false,
        discardStaged: false,
      }),
    ).toMatchObject({ kind: "unsupported", reason: "runtime" });
    expect(never).not.toHaveBeenCalled();
    a.dispose();
  });

  it("boot() runs the whole stage machine over no transport and reaches ready", async () => {
    const a = make();
    const stages: string[] = [];
    const r = await a.boot({
      autoConfirm: false,
      onStage: (s) => {
        for (const e of s.emits)
          if (e.type === "stage_changed") stages.push(e.stage);
      },
    });
    expect(r.outcome).toBe("ready");
    expect(r.status).toBe("ok");
    expect(r.guard).toMatchObject({ result: "ok", failedBoots: 1 });
    expect(stages).toEqual([
      "shell",
      "guard",
      "sync",
      "gate",
      "decide",
      "fetch",
      "mount",
      "ready",
    ]);
    expect(never).not.toHaveBeenCalled();
    a.dispose();
  });

  it("drives the hooks through the Provider with no request", async () => {
    const a = make();
    function Probe(): React.JSX.Element {
      const lic = useLicense();
      const cfg = useManagedConfig();
      return (
        <div>
          <span data-testid="status">{lic.status}</span>
          <span data-testid="theme">{cfg.get("theme.mode", "light")}</span>
        </div>
      );
    }
    const { container } = render(
      <PolarisKeyProvider config={{ productSlug: "acme", adapter: a }}>
        <Probe />
      </PolarisKeyProvider>,
    );
    const q = within(container);
    await waitFor(() => expect(q.getByTestId("status").textContent).toBe("ok"));
    expect(q.getByTestId("theme").textContent).toBe("dark");
    expect(never).not.toHaveBeenCalled();
  });

  it("the boot guard needs a version to count launches of", async () => {
    const a = localAdapter({
      productSlug: "acme",
      expectServices: services("config"),
      storage: null,
    });
    expect(await a.markBootAttempt().catch((e: unknown) => e)).toMatchObject({
      code: "not-configured",
    });
    a.dispose();
  });
});
