// @pkey-feature ui.kit license.activate
//
// `<PolarisKeyGate>` inside `<PolarisKeyProvider>` starts itself (UI-KITS.md §4.2, DL18): no
// input, no handlers. It never flashes Welcome while the first state loads, renders the app when
// the license holds, takes a key through Activate, keeps a device limit as a neutral refusal whose
// one primary opens the validated link with the return URL and the key, hands a desktop sign-in
// to the code view, and signs out and retries through the SDK.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { PolarisKeyProvider } from "../src/react/Provider.js";
import { PolarisKeyGate } from "../src/index.js";
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
    <PolarisKeyProvider
      productSlug="acme"
      adapter={adapter}
      theme={{ copy: { productName: "Acme Studio" } }}
    >
      <PolarisKeyGate returnUrl={over.returnUrl}>
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
