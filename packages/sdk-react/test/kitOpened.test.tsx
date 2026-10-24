// @pkey-feature ui.kit ui.update
//
// UK-06.4: a native menu item asks the desktop host window for a view. `<PolarisKeyGate>` shows the
// drop-in Settings, or runs an update check and shows the prompt or "You're up to date", as a modal
// dialog over the app; Escape closes it and focus goes back; the prompt installs through the host
// and draws its real bytes.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";

import { PolarisKeyProvider } from "@polaris-key/react";
import { PolarisKeyGate } from "@polaris-key/react/kit";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import type { KitView } from "../src/desktop/bridge.js";
import type { BridgeUpdateProgress } from "../src/desktop/bridge.js";
import {
  NOW_SEC,
  entry,
  makeConfig,
  makeFakeBridge,
  okBridgeState,
  services,
} from "./fixtures.js";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BINARY = {
  action: "binary",
  method: "direct",
  release: { version: "2.5.0" },
  build: "b1",
  mandatory: false,
  critical: false,
  prestage: [],
  discardStaged: false,
};

function mount(o: {
  newer: boolean;
  withOpen?: boolean;
  install?: unknown;
  desktop?: boolean;
  manageUrl?: string;
}) {
  const openers = new Set<(v: KitView) => void>();
  const progress = new Set<(p: BridgeUpdateProgress) => void>();
  const calls: string[] = [];
  const bridge = {
    ...makeFakeBridge(
      okBridgeState({
        capabilities: services("license", "config", "update", "release"),
        ...(o.desktop
          ? {
              host: { os: "macos" },
              capabilities: services(
                "license",
                "config",
                "update",
                "release",
                "identity",
              ),
              profile: { name: "Mara Lindqvist" },
            }
          : {}),
        config: makeConfig({ "audio.dither": entry("default", true) }),
      }),
    ),
    version: 4,
    ...(o.manageUrl
      ? {
          submitKey: async () => ({
            kind: "device-limit" as const,
            limit: 3,
            manageUrl: o.manageUrl,
          }),
        }
      : {}),
    ...(o.withOpen === false
      ? {}
      : {
          onOpen: (cb: (v: KitView) => void) => {
            openers.add(cb);
            return () => void openers.delete(cb);
          },
        }),
    onUpdateProgress: (cb: (p: BridgeUpdateProgress) => void) => {
      progress.add(cb);
      return () => void progress.delete(cb);
    },
    async invoke(service: string, method: string) {
      calls.push(`${service}.${method}`);
      if (service === "update" && method === "check")
        return {
          version: "2.5.0",
          tag: "v2.5.0",
          url: "https://dl.plrs.im/acme/2.5.0",
          updateAvailable: o.newer,
        };
      if (service === "update" && method === "decide")
        return { decision: BINARY };
      if (service === "update" && method === "install") {
        for (const cb of progress) cb({ done: 5_000_000, total: 20_000_000 });
        await new Promise((r) => setTimeout(r, 20));
        return o.install ?? { kind: "handedOff", version: "2.5.0" };
      }
      if (service === "release" && method === "changelog") return [];
      return null;
    },
  };
  const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
  const view = render(
    <PolarisKeyProvider
      config={{ productSlug: "acme", adapter, version: "2.4.1" }}
    >
      <PolarisKeyGate {...(o.desktop ? { theme: { platform: "auto" } } : {})}>
        <button data-testid="app">APP</button>
      </PolarisKeyGate>
    </PolarisKeyProvider>,
  );
  const open = (v: KitView) =>
    act(() => void [...openers].forEach((f) => f(v)));
  return { ...view, adapter, open, calls, progress };
}

const dialog = (c: HTMLElement) => c.querySelector("dialog");
const cancel = (d: Element) =>
  fireEvent(d, new Event("cancel", { cancelable: true }));

describe("the host opens a view in the gate's window", () => {
  it("Settings opens over the app, Escape closes it and focus returns", async () => {
    const m = mount({ newer: false });
    const app = await m.findByTestId("app");
    app.focus();
    m.open("settings");
    const d = await waitFor(() => {
      const x = dialog(m.container);
      expect(x).not.toBeNull();
      return x!;
    });
    expect(d.textContent).toMatch(/Settings/);
    expect(m.getByTestId("app")).toBeTruthy(); // the app is still mounted under it
    cancel(d);
    await waitFor(() => expect(dialog(m.container)).toBeNull());
    expect(document.activeElement).toBe(app);
  });

  it("an update check with nothing newer says so, and closes with Escape", async () => {
    const m = mount({ newer: false });
    const app = await m.findByTestId("app");
    app.focus();
    m.open("update");
    const d = await waitFor(() => {
      const x = dialog(m.container);
      expect(x).not.toBeNull();
      return x!;
    });
    expect(d.textContent).toContain("You're up to date");
    expect(m.calls).toContain("update.check");
    cancel(d);
    await waitFor(() => expect(dialog(m.container)).toBeNull());
    expect(document.activeElement).toBe(app);
  });

  it("a newer version shows the prompt; Later closes it", async () => {
    const m = mount({ newer: true });
    await m.findByTestId("app");
    m.open("update");
    const install = await waitFor(() => {
      const b = m.container.querySelector('button[data-key="update.install"]');
      expect(b).not.toBeNull();
      return b!;
    });
    expect(install).toBeTruthy();
    fireEvent.click(
      m.container.querySelector('button[data-key="update.later"]')!,
    );
    await waitFor(() => expect(dialog(m.container)).toBeNull());
  });

  it("Install goes through the host and draws its real bytes, then offers the restart", async () => {
    const m = mount({
      newer: true,
      install: { kind: "restartRequired", version: "2.5.0" },
    });
    await m.findByTestId("app");
    m.open("update");
    fireEvent.click(
      await waitFor(() => {
        const b = m.container.querySelector(
          'button[data-key="update.install"]',
        );
        expect(b).not.toBeNull();
        return b!;
      }),
    );
    const bar = await waitFor(() => {
      const b = m.container.querySelector('[role="progressbar"]');
      expect(b).not.toBeNull();
      return b!;
    });
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    await waitFor(() =>
      expect(
        m.container.querySelector('button[data-key="update.restartNow"]'),
      ).not.toBeNull(),
    );
    expect(m.calls).toEqual(
      expect.arrayContaining(["update.decide", "update.install"]),
    );
  });

  it("a host without the open push keeps the gate as it was", async () => {
    const m = mount({ newer: false, withOpen: false });
    await m.findByTestId("app");
    m.open("settings");
    expect(dialog(m.container)).toBeNull();
  });
});

describe("the menu-opened dialogs on a desktop host (UK-06-KITFIX)", () => {
  it("the update offer is the in-app install, not the web download", async () => {
    const m = mount({ newer: true, desktop: true });
    await m.findByTestId("app");
    m.open("update");
    await waitFor(() =>
      expect(
        m.container.querySelector('button[data-key="update.install"]'),
      ).not.toBeNull(),
    );
    const d = dialog(m.container)!;
    expect(
      [...m.container.querySelectorAll("[data-pk-platform]")].map((e) =>
        e.getAttribute("data-pk-platform"),
      ),
    ).toEqual(["macos"]);
    expect(d.textContent).toContain("Install and Relaunch");
    expect(d.textContent).not.toContain("Opens in your browser");
    expect(d.textContent).not.toMatch(/Download 2\.5\.0/);
  });

  it("Settings has a Done, a click on the scrim closes it, and focus returns", async () => {
    const m = mount({ newer: false, desktop: true });
    const app = await m.findByTestId("app");
    app.focus();
    m.open("settings");
    const done = await waitFor(() => {
      const b = m.container.querySelector('button[data-key="common.done"]');
      expect(b).not.toBeNull();
      return b!;
    });
    fireEvent.click(done);
    await waitFor(() => expect(dialog(m.container)).toBeNull());
    expect(document.activeElement).toBe(app);
    m.open("settings");
    const d = await waitFor(() => {
      const x = dialog(m.container);
      expect(x).not.toBeNull();
      return x!;
    });
    fireEvent.click(d);
    await waitFor(() => expect(dialog(m.container)).toBeNull());
  });

  it("Manage License shows the account group, and Sign Out signs out", async () => {
    const m = mount({ newer: false, desktop: true });
    await m.findByTestId("app");
    m.open("settings");
    const out = await waitFor(() => {
      const b = m.container.querySelector('button[data-key="common.signOut"]');
      expect(b).not.toBeNull();
      return b!;
    });
    const d = dialog(m.container)!;
    expect(d.querySelector('[data-key="account.devices"]')).not.toBeNull();
    expect(
      d.querySelector('[data-key="account.version"]')?.textContent,
    ).toContain("2.4.1");
    fireEvent.click(out);
    await waitFor(() =>
      expect(
        m.container
          .querySelector('[data-component="PolarisKeyGate"]')
          ?.getAttribute("data-state"),
      ).toBe("needs-activation"),
    );
    expect(dialog(m.container)).toBeNull();
  });

  it("Manage shows in the account group only with a page to open, and opens it", async () => {
    const none = mount({ newer: false, desktop: true });
    await none.findByTestId("app");
    none.open("settings");
    await waitFor(() =>
      expect(
        none.container.querySelector('[data-key="account.devices"]'),
      ).not.toBeNull(),
    );
    expect(
      none.container.querySelector('[data-key="common.manage"]'),
      "a button that does nothing",
    ).toBeNull();
    cleanup();

    const url = "https://key.plrs.im/portal/free?x=1";
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const m = mount({ newer: false, desktop: true, manageUrl: url });
    await m.findByTestId("app");
    await act(async () => {
      await m.adapter.submitKey("pkey_x").catch(() => undefined);
    });
    m.open("settings");
    const manage = await waitFor(() => {
      const b = m.container.querySelector('[data-key="common.manage"]');
      expect(b).not.toBeNull();
      return b!;
    });
    fireEvent.click(manage);
    expect(open).toHaveBeenCalled();
    expect(String(open.mock.calls[0]![0])).toContain("key.plrs.im/portal/free");
  });
});
