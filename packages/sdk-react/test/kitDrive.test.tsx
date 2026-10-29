// @pkey-feature ui.kit ui.kit.manage ui.kit.keyentry ui.kit.account license.activate
//
// UK-05's UX review fixes, held in place: the gate's way back (Back on every step, Escape, the
// platform's Back, a refusal that does not outlive the step, a different key after a device
// limit), the Activate step that keeps its title, and the parts that act inside the provider
// (Devices, Settings, UpdatePrompt, About run themselves; one h1 on the page; no raw "{name}").

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";

import { PolarisKeyProvider } from "@polaris-key/react";
import {
  About,
  ChannelPicker,
  Devices,
  PolarisKeyGate,
  Settings,
  UpdatePrompt,
} from "@polaris-key/react/kit";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import { DrivenSettings } from "../src/kit/drive.js";
import type { BridgeActivation, BridgeState } from "../src/desktop/bridge.js";
import {
  NOW_SEC,
  emptyBridgeState,
  entry,
  services,
  makeConfig,
  makeDoc,
  makeFakeBridge,
  okBridgeState,
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

const MANAGE = "https://key.plrs.im/activate?product=acme&next=free-device";
const KEY = "pkey_acme_KEY";
const control = (c: HTMLElement, key: string) =>
  c.querySelector<HTMLButtonElement>(`button[data-key="${key}"]`);

function mountGate(submit: () => BridgeActivation) {
  const bridge = makeFakeBridge(emptyBridgeState());
  bridge.submitKey = vi.fn(async () => submit());
  const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });

  const view = render(
    <PolarisKeyProvider config={{ productSlug: "acme", adapter }}>
      <PolarisKeyGate theme={{ product: { name: "Acme Studio" } }}>
        <div data-testid="app">APP</div>
      </PolarisKeyGate>
    </PolarisKeyProvider>,
  );
  return { bridge, adapter, ...view };
}

async function toActivate(c: HTMLElement): Promise<HTMLInputElement> {
  await waitFor(() => expect(control(c, "welcome.useKey")).not.toBeNull());
  fireEvent.click(control(c, "welcome.useKey")!);
  return waitFor(() => {
    const f = c.querySelector<HTMLInputElement>("#pk-key");
    expect(f).not.toBeNull();
    return f!;
  });
}

const limit = (): BridgeActivation => ({
  kind: "device-limit",
  limit: 3,
  deviceCount: 3,
  manageUrl: MANAGE,
});

/** The gate's Welcome over a fake bridge `setup` shapes. */
async function welcome(setup: (b: ReturnType<typeof makeFakeBridge>) => void) {
  const bridge = makeFakeBridge(emptyBridgeState());
  setup(bridge);
  const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
  const { container } = render(
    <PolarisKeyProvider config={{ productSlug: "acme", adapter }}>
      <PolarisKeyGate theme={{ product: { name: "Acme Studio" } }} />
    </PolarisKeyProvider>,
  );
  await waitFor(() =>
    expect(control(container, "welcome.signIn")).not.toBeNull(),
  );
  return { bridge, adapter, container };
}

describe("the gate's way back", () => {
  it("draws Back on the key step and returns to Welcome, focus on the opener", async () => {
    const { container, adapter } = mountGate(limit);
    await toActivate(container);
    const back = control(container, "common.back");
    expect(back).not.toBeNull();
    fireEvent.click(back!);
    await waitFor(() =>
      expect(control(container, "welcome.useKey")).not.toBeNull(),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(control(container, "welcome.useKey")),
    );
    adapter.dispose();
  });

  it("lets the person enter a different key after a device limit", async () => {
    const { container, adapter } = mountGate(limit);
    const field = await toActivate(container);
    fireEvent.change(field, { target: { value: KEY } });
    fireEvent.click(control(container, "activate.submit")!);
    const another = await waitFor(() => {
      const b = control(container, "signin.key.differentKey");
      expect(b).not.toBeNull();
      return b!;
    });
    fireEvent.click(another);
    // The refusal is gone and the field is back, empty (a different key starts afresh).
    const again = await waitFor(() => {
      const f = container.querySelector<HTMLInputElement>("#pk-key");
      expect(f).not.toBeNull();
      return f!;
    });
    expect(again.value).toBe("");
    expect(container.querySelector('[data-part="callout"]')).toBeNull();
    adapter.dispose();
  });

  it("does not bring the refusal back when the person leaves and returns", async () => {
    const { container, adapter } = mountGate(limit);
    const field = await toActivate(container);
    fireEvent.change(field, { target: { value: KEY } });
    fireEvent.click(control(container, "activate.submit")!);
    await waitFor(() =>
      expect(control(container, "deviceLimit.title")).not.toBeNull(),
    );
    fireEvent.keyDown(container.querySelector(".pk-root")!, {
      key: "Escape",
    });
    await waitFor(() =>
      expect(control(container, "welcome.useKey")).not.toBeNull(),
    );
    fireEvent.click(control(container, "welcome.useKey")!);
    await waitFor(() =>
      expect(container.querySelector("#pk-key")).not.toBeNull(),
    );
    expect(control(container, "deviceLimit.title")).toBeNull();
    adapter.dispose();
  });

  it("steps back on the platform's Back, one history entry per step", async () => {
    const { container, adapter } = mountGate(limit);
    await toActivate(container);
    expect(history.state?.pkGate).toBe("activate");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() =>
      expect(control(container, "welcome.useKey")).not.toBeNull(),
    );
    adapter.dispose();
  });

  it("a sign-in that fails to start is said on the Welcome (UK-06.16)", async () => {
    const { bridge, adapter, container } = await welcome((b) => {
      b.beginSignIn = vi.fn(async () => {
        throw new Error("no host");
      });
    });
    fireEvent.click(control(container, "welcome.signIn")!);
    await waitFor(() => expect(bridge.beginSignIn).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        container.querySelector(
          '[data-key="core.codes.sign-in-failed.message"]',
        ),
      ).not.toBeNull(),
    );
    // Still the Welcome: Sign in can be pressed again.
    expect(control(container, "welcome.signIn")).not.toBeNull();
    adapter.dispose();
  });

  it("draws Back on the sign-in code step", async () => {
    const { adapter, container } = await welcome((b) => {
      b.pollSignIn = () => new Promise(() => {});
    });
    fireEvent.click(control(container, "welcome.signIn")!);
    await waitFor(() =>
      expect(container.querySelector('[data-key="a11y.code"]')).not.toBeNull(),
    );
    fireEvent.click(control(container, "common.back")!);
    await waitFor(() =>
      expect(control(container, "welcome.signIn")).not.toBeNull(),
    );
    adapter.dispose();
  });
});

describe("the Activate step keeps its title", () => {
  it("has one h1, the lede and Paste while typing, and after a refusal", async () => {
    const { container, adapter } = mountGate(() => ({
      kind: "unauthorized",
    }));
    const field = await toActivate(container);
    const h1 = () => container.querySelectorAll("h1");
    expect(h1()).toHaveLength(1);
    const title = h1()[0]!.textContent;
    fireEvent.change(field, { target: { value: "pkey_acme_x" } });
    expect(h1()).toHaveLength(1);
    expect(h1()[0]!.textContent).toBe(title);
    expect(container.querySelector('[data-part="lede"]')).not.toBeNull();
    expect(control(container, "common.paste")).not.toBeNull();
    fireEvent.change(field, { target: { value: KEY + "AAAAAAAAAAAAAAAAAA" } });
    fireEvent.click(control(container, "activate.submit")!);
    await waitFor(() =>
      expect(container.querySelector('[data-part="callout"]')).not.toBeNull(),
    );
    expect(h1()).toHaveLength(1);
    expect(h1()[0]!.textContent).toBe(title);
    const input = container.querySelector<HTMLInputElement>("#pk-key")!;
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("pk-message");
    // The refusal once, under the field; editing the key clears it (DL7).
    fireEvent.change(input, { target: { value: "pkey_acme_y" } });
    expect(container.querySelector('[data-part="callout"]')).toBeNull();
    adapter.dispose();
  });
});

// ── The parts that act ───────────────────────────────────────────────────────────────────────

function mountParts(children: React.ReactNode, version = "2.4.1") {
  const devices = [
    {
      id: "dev-1",
      current: true,
      status: "ok",
      label: "Studio Mac",
      platform: "macos",
      lastVerifiedAt: Date.now() / 1000,
    },
    {
      id: "dev-2",
      current: false,
      status: "ok",
      label: null,
      platform: "windows",
      lastVerifiedAt: Date.now() / 1000 - 86_400 * 3,
    },
  ];
  const calls: [string, string, unknown][] = [];
  const state: BridgeState = okBridgeState({
    capabilities: services(
      "license",
      "config",
      "identity",
      "update",
      "release",
    ),
    config: makeConfig({
      "audio.dither": entry("default", true),
      "export.format": entry("default", "wav"),
      "audio.sampleRate": entry("default", 48_000),
    }),
  });
  const bridge = {
    ...makeFakeBridge(state),
    version: 4,
    async invoke(service: string, method: string, args?: unknown) {
      calls.push([service, method, args]);
      if (service === "devices" && method === "list") return devices;
      if (service === "devices" && method === "rename") {
        const a = args as { deviceId: string; label: string | null };
        devices.find((d) => d.id === a.deviceId)!.label = a.label as never;
        return null;
      }
      if (service === "devices" && method === "deauthorize") return null;
      if (service === "update" && method === "check")
        return {
          version: "2.5.0",
          tag: "v2.5.0",
          url: "https://dl.plrs.im/acme/2.5.0",
          updateAvailable: true,
        };
      if (service === "release" && method === "changelog")
        return [
          {
            version: "2.5.0",
            tag: "v2.5.0",
            date: "2026-10-01T00:00:00Z",
            summary:
              "Faster export\n\nFixes the crash on open\nNew themes\nA fourth line",
            url: "https://dl.plrs.im/acme/2.5.0/notes",
          },
        ];
      return null;
    },
  };
  const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
  const view = render(
    <PolarisKeyProvider config={{ productSlug: "acme", adapter, version }}>
      {children}
    </PolarisKeyProvider>,
  );
  return { calls, adapter, ...view };
}

describe("the parts run themselves inside the provider", () => {
  it("Devices: Remove asks first, then removes; Rename has a field and saves", async () => {
    const { container, calls, adapter } = mountParts(<Devices />);
    const remove = await waitFor(() => {
      const b = container.querySelector<HTMLButtonElement>(
        'button[data-key="devices.remove"]',
      );
      expect(b).not.toBeNull();
      return b!;
    });
    // The unnamed row's buttons name the row, not just "Remove".
    expect(remove.getAttribute("aria-label")).toMatch(/\S/);
    fireEvent.click(remove);
    // The confirmation sits under the row, with the list and the title still there.
    await waitFor(() =>
      expect(container.querySelector('[data-part="confirm"]')).not.toBeNull(),
    );
    expect(container.querySelectorAll('[data-part="device-row"]')).toHaveLength(
      2,
    );
    expect(container.querySelector("h2")).not.toBeNull();
    expect(calls.some(([, m]) => m === "deauthorize")).toBe(false);
    fireEvent.click(
      container.querySelector(
        '[data-part="confirm"] [data-key="devices.remove"]',
      )!,
    );
    await waitFor(() =>
      expect(calls.some(([, m]) => m === "deauthorize")).toBe(true),
    );
    await waitFor(() =>
      expect(container.querySelector('[data-part="confirm"]')).toBeNull(),
    );

    const rename = container.querySelectorAll<HTMLButtonElement>(
      'button[data-key="devices.rename"]',
    )[1]!;
    fireEvent.click(rename);
    const field = await waitFor(() => {
      const f = container.querySelector<HTMLInputElement>("#pk-rename");
      expect(f).not.toBeNull();
      return f!;
    });
    fireEvent.change(field, { target: { value: "Office PC" } });
    fireEvent.click(container.querySelector('button[data-key="common.save"]')!);
    await waitFor(() =>
      expect(calls).toContainEqual([
        "devices",
        "rename",
        { deviceId: "dev-2", label: "Office PC" },
      ]),
    );
    adapter.dispose();
  });

  it("Settings: a switch, a choice and a number write the setting", async () => {
    const { container, calls, adapter } = mountParts(<Settings />);
    const sw = await waitFor(() => {
      const b = container.querySelector<HTMLButtonElement>(
        'button[role="switch"]',
      );
      expect(b).not.toBeNull();
      return b!;
    });
    fireEvent.click(sw);
    await waitFor(() =>
      expect(calls).toContainEqual([
        "config",
        "set",
        { key: "audio.dither", value: false },
      ]),
    );
    const number = container.querySelector<HTMLInputElement>(
      'input[type="number"]',
    )!;
    fireEvent.change(number, { target: { value: "96000" } });
    fireEvent.blur(number);
    await waitFor(() =>
      expect(calls).toContainEqual([
        "config",
        "set",
        { key: "audio.sampleRate", value: 96_000 },
      ]),
    );
    adapter.dispose();
  });

  it("UpdatePrompt shows the changelog's first three lines, the current version and All changes", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const { container } = mountParts(<UpdatePrompt />);
    await waitFor(() =>
      expect(container.querySelectorAll('[data-part="notes"] li')).toHaveLength(
        3,
      ),
    );
    const lines = [...container.querySelectorAll('[data-part="notes"] li')].map(
      (l) => l.textContent,
    );
    expect(lines).toEqual([
      "Faster export",
      "Fixes the crash on open",
      "New themes",
    ]);
    expect(container.textContent).toContain("2.4.1");
    fireEvent.click(
      container.querySelector(
        'button[data-key="update.allChanges"], a[data-key="update.allChanges"]',
      )!,
    );
    expect(open).toHaveBeenCalledWith(
      "https://dl.plrs.im/acme/2.5.0/notes",
      expect.anything(),
      expect.anything(),
    );
  });

  it("UpdatePrompt and About fill every argument and copy the diagnostics", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const { container, adapter } = mountParts(
      <>
        <h1>Settings</h1>
        <UpdatePrompt />
        <Devices />
        <About />
      </>,
    );
    await waitFor(() =>
      expect(
        container.querySelector('button[data-key="update.install"]'),
      ).not.toBeNull(),
    );
    // One h1 on the page, and no raw template variable anywhere.
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(container.textContent).not.toMatch(/[{}]/);
    expect(container.textContent).toContain("2.4.1");
    fireEvent.click(
      container.querySelector('button[data-key="update.install"]')!,
    );
    // The host here has no install driver (decide answers nothing): the download page opens.
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    fireEvent.click(
      container.querySelector('button[data-key="about.copyDiagnostics"]')!,
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const report = JSON.parse(
      String((writeText.mock.calls[0] as unknown[])[0]),
    );
    expect(report).toMatchObject({ product: "acme", app: "2.4.1" });
    await waitFor(() =>
      expect(
        container.querySelector('[data-key="about.diagnosticsCopied"]'),
      ).not.toBeNull(),
    );
    // No part takes focus from the page on mount.
    expect(document.activeElement).toBe(document.body);
    adapter.dispose();
  });
});

describe("a host-fed part reports the payloads a host needs", () => {
  it("Devices names the device id on its row actions", () => {
    const onAction = vi.fn();
    const { container } = render(
      <Devices
        onAction={onAction}
        input={{
          devices: [
            {
              id: "dev-9",
              name: "Desk",
              platform: "windows",
              formFactor: "computer",
              lastSeenDays: 2,
              current: false,
            },
          ],
        }}
      />,
    );
    fireEvent.click(
      container.querySelector('button[data-key="devices.rename"]')!,
    );
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ key: "devices.rename", deviceId: "dev-9" }),
    );
  });

  it("ChannelPicker draws the channels as a radio group and reports the pick", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <ChannelPicker
        onSelect={onSelect}
        input={{
          channel: {
            locked: false,
            current: "stable",
            options: ["stable", "beta"],
          },
        }}
      />,
    );
    const rows = container.querySelectorAll('[role="radio"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(rows[1]!);
    expect(onSelect).toHaveBeenCalledWith("beta");
  });
});

const OWNED_SIGN_IN = "https://key.plrs.im/signin?product=acme";
const ADD_KEY = "https://key.plrs.im/activate?product=acme&next=add-key";

/** Mount the gate, take a key to the refusal `answer` and wait for its focused step. */
async function refused(answer: () => BridgeActivation) {
  const m = mountGate(answer);
  const field = await toActivate(m.container);
  fireEvent.change(field, { target: { value: KEY } });
  fireEvent.click(control(m.container, "activate.submit")!);
  await waitFor(() =>
    expect(control(m.container, "signin.key.differentKey")).not.toBeNull(),
  );
  return m;
}

describe("the key refusals no other key can fix", () => {
  it("key-entry-limit is one focused step: title, a sentence, Sign in, the manage link, Use a different key", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const { container, adapter } = await refused(() => ({
      kind: "key-entry-limit",
      manageUrl: ADD_KEY,
      keyEntries: { used: 3, limit: 3 },
    }));
    // No key field, no lede: typing this key again cannot help.
    expect(container.querySelector("#pk-key")).toBeNull();
    expect(container.querySelector('[data-key="activate.lede"]')).toBeNull();
    expect(container.textContent).toContain("No key entries left");
    expect(container.querySelector(".callout")).toBeNull();
    expect(control(container, "signin.key.signIn")?.dataset.variant).toBe(
      "primary",
    );
    const manage = control(container, "signin.key.addInLocker")!;
    expect(manage.dataset.variant).toBe("secondary");
    expect(manage.querySelector("svg")).not.toBeNull();
    const hint = document.getElementById(
      manage.getAttribute("aria-describedby")!,
    );
    expect(manage.contains(hint)).toBe(false);
    expect(hint?.textContent).toBe("Opens in your browser");
    expect(control(container, "signin.key.differentKey")?.dataset.variant).toBe(
      "link",
    );
    fireEvent.click(manage);
    // The link carries the typed key in the fragment (and the return address when the app gives one).
    const opened = String(open.mock.calls[0]![0]);
    expect(opened.startsWith(ADD_KEY)).toBe(true);
    expect(opened).toContain("#key=");
    // The name is the label alone (the hint is a description, outside the button).
    expect(manage.textContent).toContain("Add it in Polaris Locker");
    expect(manage.textContent).not.toContain("Opens Polaris Locker");
    // Use a different key goes back to an empty field.
    fireEvent.click(control(container, "signin.key.differentKey")!);
    await waitFor(() =>
      expect(container.querySelector<HTMLInputElement>("#pk-key")?.value).toBe(
        "",
      ),
    );
    adapter.dispose();
  });

  it("a sign-in that fails to start is said on the refusal step, Sign in stays the primary", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const m = await refused(() => ({
      kind: "key-entry-limit",
      manageUrl: ADD_KEY,
      keyEntries: { used: 3, limit: 3 },
    }));
    m.bridge.beginSignIn = vi.fn(async () => {
      throw new Error("network");
    });
    fireEvent.click(control(m.container, "signin.key.signIn")!);
    await waitFor(() =>
      expect(
        m.container.querySelector(
          '[data-key="core.codes.sign-in-failed.message"]',
        ),
      ).not.toBeNull(),
    );
    expect(control(m.container, "signin.key.signIn")?.dataset.variant).toBe(
      "primary",
    );
    expect(open).not.toHaveBeenCalled();
    m.adapter.dispose();
  });

  it("license-owned says the product-named sentence and offers Sign in, with no manage link", async () => {
    const { container, adapter } = await refused(() => ({
      kind: "license-owned",
      signInUrl: OWNED_SIGN_IN,
    }));
    expect(container.querySelector("#pk-key")).toBeNull();
    expect(container.textContent).toContain("License in another account");
    expect(container.textContent).toContain(
      "Polaris Locker account that has this Acme Studio license",
    );
    // The primary names the account that holds the license; no manage link.
    expect(control(container, "signin.key.ownedSignIn")?.dataset.variant).toBe(
      "primary",
    );
    expect(control(container, "signin.key.ownedSignIn")?.textContent).toContain(
      "Sign in to that account",
    );
    expect(control(container, "signin.key.addInLocker")).toBeNull();
    adapter.dispose();
  });
});

describe("what a finished activation or sign-in leaves over the app", () => {
  it("toasts the entries a key activation leaves", async () => {
    let push: () => void = () => undefined;
    const m = mountGate(() => {
      push();
      return { kind: "ok", keyEntries: { used: 1, limit: 3 } };
    });
    push = () => m.bridge.push(okBridgeState());
    const field = await toActivate(m.container);
    fireEvent.change(field, { target: { value: KEY } });
    fireEvent.click(control(m.container, "activate.submit")!);
    // ActivateDone first (UK-42): the toast shows over the app once Start using is pressed.
    await vi.waitFor(() => {
      if (!control(m.container, "signin.done.start"))
        throw new Error("no Done");
    });
    fireEvent.click(control(m.container, "signin.done.start")!);
    const toast = await waitFor(() => {
      const t = m.container.querySelector('[data-part="toast"]');
      expect(t).not.toBeNull();
      return t!;
    });
    expect(toast.textContent).toContain("2 key entries left");
    expect(m.container.querySelector('[data-testid="app"]')).not.toBeNull();
    m.adapter.dispose();
  });

  it("names who signed in and the license's tier once a sign-in lands", async () => {
    const m = mountGate(() => ({ kind: "ok" }));
    m.bridge.pollSignIn = () => new Promise(() => {});
    await waitFor(() =>
      expect(control(m.container, "welcome.signIn")).not.toBeNull(),
    );
    fireEvent.click(control(m.container, "welcome.signIn")!);
    await waitFor(() =>
      expect(
        m.container.querySelector('[data-key="a11y.code"]'),
      ).not.toBeNull(),
    );
    m.bridge.push(
      okBridgeState({
        doc: makeDoc({
          entitlements: {
            tier: { state: "enforced", value: "Pro", updatedAt: 950 },
          },
        }),
      }),
    );
    const toast = await waitFor(() => {
      const t = m.container.querySelector('[data-part="toast"]');
      expect(t).not.toBeNull();
      return t!;
    });
    expect(toast.textContent).toContain("Signed in as Ada Lovelace");
    expect(toast.textContent).toContain("Pro license");
    m.adapter.dispose();
  });
});

describe("the account pane's Not in an account row (UK-42.10)", () => {
  const floating = () =>
    okBridgeState({
      doc: makeDoc({
        profile: { name: "", firstName: "", email: "", activatedAt: 900 },
      }),
    });

  /** The account pane a desktop host's menu opens, over a bridge in this state. */
  const pane = (state: BridgeState, addIn?: "app" | "portal") => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(state),
      now: () => NOW_SEC,
    });
    return {
      adapter,
      ...render(
        <DrivenSettings
          adapter={adapter}
          onDismiss={() => {}}
          {...(addIn ? { addIn } : {})}
        />,
      ),
    };
  };

  it("shows the row for a floating license and opens AddToAccount in place; Cancel returns", async () => {
    const { adapter, container } = pane(floating(), "app");
    await waitFor(() =>
      expect(control(container, "activate.recommend.action")).not.toBeNull(),
    );
    fireEvent.click(control(container, "activate.recommend.action")!);
    await waitFor(() =>
      expect(
        container.querySelector('input[data-field="email"]'),
      ).not.toBeNull(),
    );
    fireEvent.click(control(container, "common.cancel")!);
    await waitFor(() =>
      expect(control(container, "activate.recommend.action")).not.toBeNull(),
    );
    adapter.dispose();
  });

  it("by default (the web switch) the row never opens the in-pane form", async () => {
    const { adapter, container } = pane(floating());
    await waitFor(() =>
      expect(control(container, "activate.recommend.action")).not.toBeNull(),
    );
    fireEvent.click(control(container, "activate.recommend.action")!);
    // The product's page is the destination; with no provider here there is no page to open.
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector('input[data-field="email"]')).toBeNull();
    expect(control(container, "activate.recommend.action")).not.toBeNull();
    adapter.dispose();
  });

  it("an account signed in on this device is never called floating", async () => {
    const { adapter, container } = pane(okBridgeState());
    await waitFor(() =>
      expect(
        container.querySelector('[data-key="account.title"]'),
      ).not.toBeNull(),
    );
    // A holder with an email is waiting for that account: no Add row.
    expect(control(container, "activate.recommend.action")).toBeNull();
    adapter.dispose();
  });
});
