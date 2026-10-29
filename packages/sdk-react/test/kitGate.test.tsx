// @pkey-feature ui.kit ui.kit.manage license.activate
//
// `<PolarisKeyGate>` inside `<PolarisKeyProvider>` starts itself (UI-KITS.md §4.2, DL18): no
// input, no handlers. It never flashes Welcome while the first state loads, renders the app when
// the license holds, takes a key through Activate, keeps a device limit as a neutral refusal whose
// one primary opens the validated link with the return URL and the key and tries the key again
// when the person comes back, hands a desktop sign-in to the code view, and signs out and retries
// through the SDK.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { resolveKitColors } from "@polaris-key/ui-core/theme";
import type {
  PresentationSource,
  ProductPresentation,
} from "@polaris-key/client-core/presentation";

import { PolarisKeyProvider } from "@polaris-key/react";
import { PolarisKeyGate } from "@polaris-key/react/kit";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import type { BridgeActivation, BridgeState } from "../src/desktop/bridge.js";
import {
  NOW_SEC,
  emptyBridgeState,
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

function mount(
  state: BridgeState,
  over: {
    submit?: () => BridgeActivation;
    never?: boolean;
    returnUrl?: string;
  } = {},
) {
  const bridge = makeFakeBridge(state);
  if (over.submit) bridge.submitKey = vi.fn(async () => over.submit!());
  if (over.never) bridge.pollSignIn = () => new Promise(() => {});
  const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
  const view = render(
    <PolarisKeyProvider config={{ productSlug: "acme", adapter }}>
      <PolarisKeyGate
        returnUrl={over.returnUrl}
        theme={{ product: { name: "Acme Studio" } }}
      >
        <div data-testid="app">APP</div>
      </PolarisKeyGate>
    </PolarisKeyProvider>,
  );
  return { bridge, adapter, ...view };
}

const root = (c: HTMLElement) => c.querySelector<HTMLElement>(".pk-root");
const control = (c: HTMLElement, key: string) =>
  c.querySelector<HTMLButtonElement>(`button[data-key="${key}"]`);

describe("the gate starts itself inside the provider", () => {
  it("renders the app once the license holds, with no kit root", async () => {
    const { container, adapter } = mount(okBridgeState());
    await waitFor(() =>
      expect(container.querySelector('[data-testid="app"]')).not.toBeNull(),
    );
    expect(root(container)).toBeNull();
    adapter.dispose();
  });

  it("shows Welcome when activation is needed, never before the first state", async () => {
    const { container, adapter } = mount(emptyBridgeState());
    // The first frame is the loading state: no sign-in paths yet (Must not).
    expect(control(container, "welcome.signIn")).toBeNull();
    await waitFor(() =>
      expect(root(container)?.dataset.state).toBe("needs-activation"),
    );
    expect(control(container, "welcome.signIn")).not.toBeNull();
    // The product's name from the provider's theme heads the screen (DL5).
    expect(container.querySelector("h1")?.textContent).toContain("Acme Studio");
    expect(container.querySelector('[data-testid="app"]')).toBeNull();
    adapter.dispose();
  });

  it("takes a key through Activate and lets the app in", async () => {
    const { container, adapter, bridge } = mount(emptyBridgeState(), {
      submit: () => {
        bridge.push(okBridgeState());
        return { kind: "ok" } as BridgeActivation;
      },
    });
    await waitFor(() =>
      expect(control(container, "welcome.useKey")).not.toBeNull(),
    );
    fireEvent.click(control(container, "welcome.useKey")!);
    const field = await waitFor(() => {
      const f = container.querySelector<HTMLInputElement>("#pk-key");
      expect(f).not.toBeNull();
      return f!;
    });
    fireEvent.change(field, { target: { value: "pkey_acme_KEY" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() =>
      expect(bridge.submitKey).toHaveBeenCalledWith("pkey_acme_KEY"),
    );
    // ActivateDone first (UK-42); Start using lets the app in.
    await waitFor(() =>
      expect(control(container, "signin.done.start")).not.toBeNull(),
    );
    fireEvent.click(control(container, "signin.done.start")!);
    await waitFor(() =>
      expect(container.querySelector('[data-testid="app"]')).not.toBeNull(),
    );
    adapter.dispose();
  });

  it("keeps a device limit neutral, its one primary opening the link with return and key", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const { container, adapter } = mount(emptyBridgeState(), {
      submit: () => ({
        kind: "device-limit",
        limit: 3,
        deviceCount: 3,
        manageUrl: MANAGE,
      }),
      returnUrl: "https://app.acme.test/",
    });
    await waitFor(() =>
      expect(control(container, "welcome.useKey")).not.toBeNull(),
    );
    fireEvent.click(control(container, "welcome.useKey")!);
    const field = await waitFor(() => {
      const f = container.querySelector<HTMLInputElement>("#pk-key");
      expect(f).not.toBeNull();
      return f!;
    });
    fireEvent.change(field, { target: { value: "pkey_acme_KEY" } });
    fireEvent.click(control(container, "activate.submit")!);
    await waitFor(() =>
      expect(
        root(container)?.querySelector('[data-part="callout"]'),
      ).not.toBeNull(),
    );
    const callout = root(container)!.querySelector('[data-part="callout"]')!;
    // DL6: neutral, never an alert, and the key is not marked wrong.
    expect(callout.getAttribute("data-tone")).toBe("neutral");
    expect(callout.getAttribute("role")).toBe("status");
    const filled = root(container)!.querySelectorAll(
      '[data-variant="primary"]',
    );
    expect(filled).toHaveLength(1);
    expect(filled[0]!.getAttribute("data-key")).toBe("deviceLimit.title");
    fireEvent.click(filled[0]!);
    expect(open).toHaveBeenCalledTimes(1);
    const opened = new URL(String(open.mock.calls[0]![0]));
    expect(opened.origin).toBe("https://key.plrs.im");
    expect(opened.searchParams.get("return")).toBe("https://app.acme.test/");
    expect(opened.hash).toContain("pkey_acme_KEY");
    adapter.dispose();
  });

  it("tries the key again, once, when the person comes back from Replace a device", async () => {
    vi.spyOn(window, "open").mockImplementation(() => null);
    const { container, adapter, bridge } = mount(emptyBridgeState(), {
      submit: () => ({
        kind: "device-limit",
        limit: 3,
        deviceCount: 3,
        manageUrl: MANAGE,
      }),
    });
    await waitFor(() =>
      expect(control(container, "welcome.useKey")).not.toBeNull(),
    );
    fireEvent.click(control(container, "welcome.useKey")!);
    const field = await waitFor(() => {
      const f = container.querySelector<HTMLInputElement>("#pk-key");
      expect(f).not.toBeNull();
      return f!;
    });
    fireEvent.change(field, { target: { value: "pkey_acme_KEY" } });
    fireEvent.click(control(container, "activate.submit")!);
    const primary = await waitFor(() => {
      const p = root(container)?.querySelector<HTMLElement>(
        '[data-variant="primary"]',
      );
      expect(p?.getAttribute("data-key")).toBe("deviceLimit.title");
      return p!;
    });
    expect(bridge.submitKey).toHaveBeenCalledTimes(1);
    // The fix takes focus (DL6).
    await waitFor(() => expect(document.activeElement).toBe(primary));

    // Focus returning before the link was opened retries nothing.
    window.dispatchEvent(new Event("focus"));
    expect(bridge.submitKey).toHaveBeenCalledTimes(1);

    fireEvent.click(primary);
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(bridge.submitKey).toHaveBeenCalledTimes(2));
    expect(bridge.submitKey).toHaveBeenLastCalledWith("pkey_acme_KEY");

    // One return is one retry.
    window.dispatchEvent(new Event("focus"));
    expect(bridge.submitKey).toHaveBeenCalledTimes(2);
    adapter.dispose();
  });

  it("hands a desktop sign-in to the code view, and Escape goes back", async () => {
    const { container, adapter } = mount(emptyBridgeState(), { never: true });
    await waitFor(() =>
      expect(control(container, "welcome.signIn")).not.toBeNull(),
    );
    fireEvent.click(control(container, "welcome.signIn")!);
    await waitFor(() =>
      expect(
        container.querySelector('[data-key="a11y.code"]')?.textContent,
      ).toBe("ABCD-1234"),
    );
    // The code view has no Cancel of its own: Escape backs out of the step (DL9).
    fireEvent.keyDown(container.querySelector('[data-key="a11y.code"]')!, {
      key: "Escape",
    });
    await waitFor(() =>
      expect(control(container, "welcome.signIn")).not.toBeNull(),
    );
    adapter.dispose();
  });

  it("a revoked license is blocked, with a different key leading to Activate", async () => {
    const { container, adapter } = mount(
      okBridgeState({ lastSyncUnauthorized: true }),
    );
    await waitFor(() => expect(root(container)?.dataset.state).toBe("blocked"));
    expect(container.querySelector('[data-testid="app"]')).toBeNull();
    const different = control(container, "signin.key.differentKey");
    expect(different).not.toBeNull();
    fireEvent.click(different!);
    await waitFor(() =>
      expect(container.querySelector("#pk-key")).not.toBeNull(),
    );
    adapter.dispose();
  });
});

describe("the product's identity comes from the SDK", () => {
  // UI-KITS.md §1.2: integrator → the SDK's presentation source (HA-13) → bundle → ink. Inside the
  // provider the kit reads the adapter's source; the integrator writes nothing.
  function sourceOf(): PresentationSource & {
    iconUrl(): Promise<string | null>;
  } {
    const p = {
      name: "Driftkart",
      accent: "#ff6a3d",
      accentDark: "#ff8a5c",
      icon: { sha256: "a".repeat(64), url: "https://cdn.example/i.png" },
    } as unknown as ProductPresentation;
    return {
      current: () => p,
      icon: async () => new Uint8Array([137, 80, 78, 71]),
      iconUrl: async () => null,
      subscribe: () => () => {},
    };
  }

  it("draws the adapter's accent, name and icon with zero integrator code", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(emptyBridgeState()),
      now: () => NOW_SEC,
    });
    const source = sourceOf();
    adapter.presentationSource = () =>
      source as ReturnType<typeof adapter.presentationSource>;
    const { container } = render(
      <PolarisKeyProvider config={{ productSlug: "acme", adapter: adapter }}>
        <PolarisKeyGate>
          <div data-testid="app">APP</div>
        </PolarisKeyGate>
      </PolarisKeyProvider>,
    );
    await waitFor(() =>
      expect(root(container)?.dataset.state).toBe("needs-activation"),
    );
    const want = resolveKitColors("#ff8a5c", "dark");
    await waitFor(() =>
      expect(root(container)!.style.getPropertyValue("--pk-accent")).toBe(
        want.primary,
      ),
    );
    await waitFor(() =>
      expect(
        container.querySelector<HTMLImageElement>('img[data-part="icon"]')?.src,
      ).toMatch(/^blob:/),
    );
    expect(container.querySelector("h1")?.textContent).toContain("Driftkart");
    adapter.dispose();
  });

  it("a theme's own source wins: null draws no presentation accent or icon", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(emptyBridgeState()),
      now: () => NOW_SEC,
    });
    const source = sourceOf();
    adapter.presentationSource = () =>
      source as ReturnType<typeof adapter.presentationSource>;
    const { container } = render(
      <PolarisKeyProvider config={{ productSlug: "acme", adapter: adapter }}>
        <PolarisKeyGate theme={{ presentation: null }}>
          <div data-testid="app">APP</div>
        </PolarisKeyGate>
      </PolarisKeyProvider>,
    );
    await waitFor(() =>
      expect(root(container)?.dataset.state).toBe("needs-activation"),
    );
    const ink = resolveKitColors(null, "dark");
    expect(root(container)!.style.getPropertyValue("--pk-accent")).toBe(
      ink.primary,
    );
    expect(container.querySelector('img[data-part="icon"]')).toBeNull();
    adapter.dispose();
  });
});
