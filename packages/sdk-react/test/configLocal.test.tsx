// @pkey-feature config.local
// SDK parity pass §3.11 (SP-13): device-local config overrides with S-17's names —
// `config.set/clear/clearAll/setting/onConfigChange` — persisted per product in the browser,
// validated against the catalog type, refused for an admin-managed key, one change event per
// write, forwarded to the host over bridge v4 on desktop, and `useConfigSetting` re-rendering.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import type { ProductCatalog } from "@polaris-key/catalog";
import type { JSONValue } from "@polaris-key/protocol/core";
import { browserAdapter } from "../src/browser/browserAdapter.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import {
  localConfigStorageKey,
  type ConfigChange,
  type ConfigStorage,
} from "../src/core/localConfig.js";
import { PolarisKeyProvider } from "../src/react/Provider.js";
import { useConfigSetting } from "../src/react/hooks.js";
import { ConfigPanel } from "../src/components/ConfigPanel.js";
import { UnsupportedError } from "../src/core/caps.js";
import {
  entry,
  makeConfig,
  makeDoc,
  makeFakeBridge,
  makeFakeFetch,
  NOW_SEC,
  okBridgeState,
} from "./fixtures.js";

afterEach(cleanup);

const CATALOG: ProductCatalog = {
  schemaVersion: 1,
  entries: [
    {
      key: "ui.theme",
      label: "Theme",
      description: "The colour theme.",
      kind: "config",
      category: "ui",
      schema: { type: "string", enum: ["light", "dark"] },
      managementDefault: "default",
    },
    {
      key: "net.limit",
      label: "Connection limit",
      description: "Parallel connections.",
      kind: "config",
      category: "net",
      schema: { type: "integer", minimum: 1 },
      managementDefault: "default",
    },
  ],
};

/** The config document: `theme.mode` enforced (locked), `ui.theme` a shipped default. */
const CONFIG = makeConfig({ "ui.theme": entry("default", "light") });

function memoryStorage(): ConfigStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

async function settle(adapter: { snapshot(): { phase: string } }) {
  for (let i = 0; i < 50 && adapter.snapshot().phase === "loading"; i++)
    await new Promise((r) => setTimeout(r, 0));
}

function browser(
  storage: ConfigStorage | null,
  opts: { catalog?: ProductCatalog | null; fetchImpl?: typeof fetch } = {},
) {
  return browserAdapter({
    auth: "cookie",
    productSlug: "acme",
    fetchImpl: opts.fetchImpl ?? makeFakeFetch(makeDoc(), { config: CONFIG }),
    now: () => NOW_SEC,
    configStorage: storage,
    ...(opts.catalog !== undefined ? { catalog: opts.catalog } : {}),
  });
}

describe("config.local — browser", () => {
  it("persists per product and reloads it in a new adapter", async () => {
    const storage = memoryStorage();
    const a = browser(storage, { catalog: CATALOG });
    await settle(a);
    expect(a.config.persistent()).toBe(true);
    await a.config.set("ui.theme", "dark");
    expect(a.getConfig("ui.theme", "light")).toBe("dark");
    expect(a.getConfigSource("ui.theme")).toBe("local");
    expect(
      JSON.parse(storage.data.get(localConfigStorageKey("acme"))!),
    ).toEqual({ "ui.theme": "dark" });
    a.dispose();

    // A fresh page load reads the stored value before any network answer.
    const b = browser(storage, { catalog: CATALOG });
    expect(b.snapshot().localOverrides).toEqual({ "ui.theme": "dark" });
    await settle(b);
    expect(b.getConfig("ui.theme", "light")).toBe("dark");
    expect(b.config.localValues()).toEqual({ "ui.theme": "dark" });
    b.dispose();
  });

  it("clear drops one override and clearAll drops every one", async () => {
    const storage = memoryStorage();
    const a = browser(storage, { catalog: CATALOG });
    await settle(a);
    await a.config.set("ui.theme", "dark");
    await a.config.set("net.limit", 4);
    await a.config.clear("ui.theme");
    expect(a.getConfig("ui.theme", "x")).toBe("light"); // the remote default again
    expect(a.config.localValues()).toEqual({ "net.limit": 4 });
    await a.config.clearAll();
    expect(a.config.localValues()).toEqual({});
    expect(a.getConfig("net.limit", 1)).toBe(1);
    expect(storage.data.has(localConfigStorageKey("acme"))).toBe(false);
    a.dispose();
  });

  it("refuses a value of the wrong catalog type with bad_request, changing nothing", async () => {
    const a = browser(memoryStorage(), { catalog: CATALOG });
    await settle(a);
    await expect(a.config.set("ui.theme", "purple")).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(a.config.set("net.limit", "lots")).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(a.config.localValues()).toEqual({});
    a.dispose();
  });

  it("fetches the catalog once, on the first write, when the host gave none", async () => {
    const base = makeFakeFetch(makeDoc(), { config: CONFIG });
    const schema = vi.fn(
      () =>
        new Response(JSON.stringify(CATALOG), {
          headers: { "content-type": "application/json" },
        }),
    );
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("/acme/config/schema")
        ? schema()
        : base(input, init)) as typeof fetch;
    const a = browser(memoryStorage(), { fetchImpl });
    await settle(a);
    await expect(a.config.set("ui.theme", "purple")).rejects.toMatchObject({
      code: "bad_request",
    });
    await a.config.set("ui.theme", "dark");
    expect(schema).toHaveBeenCalledTimes(1);
    a.dispose();
  });

  it("refuses an admin-managed key with managed_by_admin", async () => {
    const a = browser(memoryStorage(), { catalog: CATALOG });
    await settle(a);
    expect(a.config.isLocked("theme.mode")).toBe(true);
    expect(a.config.setting("theme.mode").locked()).toBe(true);
    await expect(a.config.set("theme.mode", "light")).rejects.toMatchObject({
      code: "managed_by_admin",
    });
    expect(a.config.localValues()).toEqual({});
    a.dispose();
  });

  it("emits one change per write, per key and on the wildcard", async () => {
    const a = browser(memoryStorage(), { catalog: CATALOG });
    await settle(a);
    const keyed: ConfigChange[] = [];
    const all: string[] = [];
    const theme = a.config.setting<string>("ui.theme");
    const off = theme.on((c) => keyed.push(c));
    a.config.onConfigChange("*", (c) => all.push(c.key));
    await theme.set("dark");
    await theme.set("dark"); // no resolved change, no event
    await theme.clear();
    expect(keyed).toEqual([
      { key: "ui.theme", value: "dark", previous: "light", source: "local" },
      {
        key: "ui.theme",
        value: "light",
        previous: "dark",
        source: "remote-default",
      },
    ]);
    expect(all).toEqual(["ui.theme", "ui.theme"]);
    off();
    await theme.set("dark");
    expect(keyed).toHaveLength(2);
    a.dispose();
  });

  it("keeps working in memory when storage is unusable, and says so", async () => {
    const throwing: ConfigStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    const a = browser(throwing, { catalog: CATALOG });
    await settle(a);
    expect(a.config.persistent()).toBe(false);
    await a.config.set("ui.theme", "dark");
    expect(a.getConfig("ui.theme", "light")).toBe("dark");
    a.dispose();

    // A write that starts failing mid-session (quota) degrades the same way.
    const flaky = memoryStorage();
    const b = browser(flaky, { catalog: CATALOG });
    await settle(b);
    flaky.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    await b.config.set("ui.theme", "dark");
    expect(b.config.persistent()).toBe(false);
    expect(b.getConfig("ui.theme", "light")).toBe("dark");
    b.dispose();
  });
});

describe("config.local — desktop bridge", () => {
  function v4Bridge(local: Record<string, JSONValue> = {}) {
    const values: Record<string, JSONValue> = { ...local };
    const state = () =>
      okBridgeState({ config: CONFIG, localConfig: { ...values } });
    const bridge = makeFakeBridge(state());
    const invoke = vi.fn(
      async (service: string, method: string, args?: unknown) => {
        const a = (args ?? {}) as { key: string; value: JSONValue };
        if (service !== "config") throw new Error(`no ${service}.${method}`);
        if (method === "set") {
          if (a.value === 0)
            throw Object.assign(new Error("net.limit: below minimum"), {
              code: "bad_request",
            });
          values[a.key] = a.value;
        } else if (method === "clear") delete values[a.key];
        else throw new Error(`no config.${method}`);
        // The host pushes its new state, carrying its stored overrides.
        bridge.push(state());
        return null;
      },
    );
    return Object.assign(bridge, { version: 4, invoke, values });
  }

  it("forwards set and clear to the host and resolves with its stored values", async () => {
    const bridge = v4Bridge({ "net.limit": 3 });
    const a = desktopAdapter({ bridge, now: () => NOW_SEC, catalog: CATALOG });
    await settle(a);
    await waitFor(() => expect(a.getConfig("net.limit", 1)).toBe(3));
    expect(a.supports("config.local").supported).toBe(true);
    await a.config.set("ui.theme", "dark");
    expect(bridge.invoke).toHaveBeenCalledWith("config", "set", {
      key: "ui.theme",
      value: "dark",
    });
    expect(a.getConfig("ui.theme", "light")).toBe("dark");
    await a.config.clearAll();
    expect(bridge.invoke).toHaveBeenCalledWith("config", "clear", {
      key: "net.limit",
    });
    expect(bridge.values).toEqual({});
    expect(a.config.localValues()).toEqual({});
    a.dispose();
  });

  it("refuses locally before crossing the bridge, and keeps a host refusal's code", async () => {
    const bridge = v4Bridge();
    const a = desktopAdapter({ bridge, now: () => NOW_SEC, catalog: null });
    await settle(a);
    await expect(a.config.set("theme.mode", "x")).rejects.toMatchObject({
      code: "managed_by_admin",
    });
    await expect(a.config.set("net.limit", 0)).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(
      bridge.invoke.mock.calls.filter((c) => c[1] === "set").map((c) => c[2]),
    ).toEqual([{ key: "net.limit", value: 0 }]);
    expect(a.config.localValues()).toEqual({});
    a.dispose();
  });

  it("a v3 host answers the typed unsupported (reason version) and nothing crosses", async () => {
    const bridge = makeFakeBridge(okBridgeState({ config: CONFIG }));
    const invoke = vi.fn(async () => null);
    Object.assign(bridge, { version: 3, invoke });
    const a = desktopAdapter({ bridge, now: () => NOW_SEC, catalog: CATALOG });
    await settle(a);
    const s = a.supports("config.local");
    expect(s).toMatchObject({ supported: false, reason: "version" });
    const err = await a.config.set("ui.theme", "dark").catch((e) => e);
    expect(err).toBeInstanceOf(UnsupportedError);
    expect(err).toMatchObject({
      code: "unsupported",
      feature: "config.local",
      reason: "version",
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(a.getConfig("ui.theme", "x")).toBe("light");
    a.dispose();
  });
});

describe("config.local — React", () => {
  it("useConfigSetting re-renders on a local write and on clear", async () => {
    const a = browser(memoryStorage(), { catalog: CATALOG });
    let latest: ReturnType<typeof useConfigSetting<string>> | null = null;
    function Probe() {
      const s = useConfigSetting<string>("ui.theme", "fallback");
      latest = s;
      return (
        <span data-testid="v">
          {s.value}:{s.source}
        </span>
      );
    }
    const { getByTestId } = render(
      <PolarisKeyProvider productSlug="acme" adapter={a}>
        <Probe />
      </PolarisKeyProvider>,
    );
    await waitFor(() =>
      expect(getByTestId("v").textContent).toBe("light:remote-default"),
    );
    await act(() => latest!.set("dark"));
    expect(getByTestId("v").textContent).toBe("dark:local");
    expect(latest!.overridden).toBe(true);
    await act(() => latest!.clear());
    expect(getByTestId("v").textContent).toBe("light:remote-default");
    a.dispose();
  });

  it("ConfigPanel saves an override itself, shows a refusal, and resets", async () => {
    const storage = memoryStorage();
    const a = browser(storage, { catalog: CATALOG });
    const { container } = render(
      <PolarisKeyProvider productSlug="acme" adapter={a}>
        <ConfigPanel />
      </PolarisKeyProvider>,
    );
    const input = await waitFor(() => {
      const el = container.querySelector<HTMLInputElement>(
        '[data-polaris-config-input="ui.theme"]',
      );
      expect(el).toBeTruthy();
      return el!;
    });
    // The locked row stays read-only.
    expect(
      container.querySelector('[data-polaris-config-input="theme.mode"]'),
    ).toBeNull();

    fireEvent.change(input, { target: { value: "purple" } });
    fireEvent.submit(input.closest("form")!);
    const alert = await waitFor(() => {
      const el = container.querySelector(
        '[data-polaris-config-error="ui.theme"]',
      );
      expect(el).toBeTruthy();
      return el!;
    });
    expect(alert.getAttribute("role")).toBe("alert");
    expect(input.getAttribute("aria-invalid")).toBe("true");

    fireEvent.change(input, { target: { value: "dark" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() =>
      expect(a.config.localValues()).toEqual({ "ui.theme": "dark" }),
    );
    const reset = await waitFor(() => {
      const el = container.querySelector<HTMLButtonElement>(
        '[data-polaris-config-reset="ui.theme"]',
      );
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(reset);
    await waitFor(() => expect(a.config.localValues()).toEqual({}));
    a.dispose();
  });

  it("a host's onOverride still takes over the save", async () => {
    const a = browser(memoryStorage(), { catalog: CATALOG });
    const onOverride = vi.fn();
    const { container } = render(
      <PolarisKeyProvider productSlug="acme" adapter={a}>
        <ConfigPanel onOverride={onOverride} />
      </PolarisKeyProvider>,
    );
    const input = await waitFor(() => {
      const el = container.querySelector<HTMLInputElement>(
        '[data-polaris-config-input="ui.theme"]',
      );
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.change(input, { target: { value: "dark" } });
    fireEvent.submit(input.closest("form")!);
    expect(onOverride).toHaveBeenCalledWith("ui.theme", "dark");
    expect(a.config.localValues()).toEqual({});
    a.dispose();
  });
});
