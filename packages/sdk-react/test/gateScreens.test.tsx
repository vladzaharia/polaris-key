// @pkey-feature ui.kit
//
// The gate's blocking screens never dead-end and speak the catalogs: a version block offers the
// update when the product runs the Update service, a failure's Try again shows its busy state and
// keeps the cause's words when a retry fails generically, the grace banner counts down from
// graceUntil, and loading shows nothing for its first 300 ms.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { PolarisKeyProvider } from "../src/react/Provider.js";
import { LicenseGate } from "../src/components/LicenseGate.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import type { BridgeState, PolarisBridge } from "../src/desktop/bridge.js";
import {
  NOW_SEC,
  emptyBridgeState,
  makeDoc,
  makeFakeBridge,
  okBridgeState,
  services,
} from "./fixtures.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function renderGate(
  bridge: ReturnType<typeof makeFakeBridge>,
  caps = services(),
  productName?: string,
) {
  const adapter = desktopAdapter({
    bridge,
    now: () => NOW_SEC,
    expectServices: caps,
  });
  const utils = render(
    <PolarisKeyProvider
      productSlug="acme"
      adapter={adapter}
      {...(productName ? { theme: { copy: { productName } } } : {})}
    >
      <LicenseGate>
        <div data-testid="app">APP</div>
      </LicenseGate>
    </PolarisKeyProvider>,
  );
  return { ...utils, adapter };
}

describe("LicenseGate — version block", () => {
  it("too old, with the Update service on: Get the update first, Try again second", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const caps = services("license", "config", "update");
    const bridge = makeFakeBridge(
      okBridgeState({
        capabilities: caps,
        blocked: { reason: "version-too-old", allowedRange: { min: "5.0.0" } },
      } as Partial<BridgeState>),
    );
    bridge.invoke = (async (service: string, method: string) =>
      service === "update" && method === "check"
        ? {
            version: "5.1.0",
            tag: "v5.1.0",
            url: "https://dl.example/5.1.0",
            updateAvailable: true,
          }
        : undefined) as PolarisBridge["invoke"];
    const { container, adapter } = renderGate(bridge, caps);
    const dialog = await waitFor(() =>
      within(container).getByRole("alertdialog"),
    );
    const buttons = await waitFor(() => {
      const all = within(dialog).getAllByRole("button");
      expect(all).toHaveLength(2);
      return all;
    });
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Get the update",
      "Try again",
    ]);
    // The update is the screen's one filled action; Try again is bordered.
    expect(buttons[1]!.style.background).toBe("transparent");
    await waitFor(() => expect(document.activeElement).toBe(buttons[0]));
    await waitFor(() => {
      fireEvent.click(buttons[0]!);
      expect(open).toHaveBeenCalledWith(
        "https://dl.example/5.1.0",
        "_blank",
        "noopener,noreferrer",
      );
    });
    adapter.dispose();
  });
});

describe("LicenseGate — failure screen", () => {
  it("titles the cause from the catalog, shows Try again busy, and catches the retry's rejection", async () => {
    const bridge = makeFakeBridge(emptyBridgeState());
    bridge.getSyncState = async () => {
      throw new Error("ipc broke");
    };
    let fail: (e: Error) => void = () => undefined;
    bridge.refresh = () =>
      new Promise<BridgeState>((_, reject) => {
        fail = reject;
      });
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    const { container, adapter } = renderGate(bridge);
    const dialog = await waitFor(() =>
      within(container).getByRole("alertdialog"),
    );
    expect(within(dialog).getByRole("heading").textContent).toBe(
      "Can't connect",
    );
    const retry = within(dialog).getByRole("button", { name: "Try again" });
    fireEvent.click(retry);
    await waitFor(() => expect(retry.getAttribute("aria-busy")).toBe("true"));
    await act(async () => {
      fail(new Error("still down"));
      await new Promise((r) => setTimeout(r, 10));
    });
    // A generic refresh failure after "Can't connect" keeps the cause's words.
    const after = within(container).getByRole("alertdialog");
    expect(within(after).getByRole("heading").textContent).toBe(
      "Can't connect",
    );
    expect(after.textContent).not.toMatch(/couldn't be refreshed/);
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
    adapter.dispose();
  });
});

describe("LicenseGate — grace banner", () => {
  function graceIn(seconds: number): BridgeState {
    // The adapter's clock is NOW_SEC; the banner counts from the real clock.
    return okBridgeState({
      doc: makeDoc({
        issuedAt: 100,
        expiresAt: 200,
        graceUntil: Math.floor(Date.now() / 1000) + seconds,
      }),
    });
  }

  it("counts the days left, neutral while more than 48 hours remain", async () => {
    const { container, adapter } = renderGate(
      makeFakeBridge(graceIn(5 * 86400 - 60)),
    );
    const banner = await waitFor(() => {
      const el = container.querySelector("[data-polaris-grace]");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(banner.textContent).toBe("Offline · 5 days left to reconnect");
    expect(banner.getAttribute("data-polaris-grace")).toBe("neutral");
    expect(within(container).getByTestId("app")).toBeTruthy();
    adapter.dispose();
  });

  it("warns, with a status glyph, once 48 hours remain, and names the product on the last day", async () => {
    const two = renderGate(makeFakeBridge(graceIn(40 * 3600)));
    const warning = await waitFor(() => {
      const el = two.container.querySelector("[data-polaris-grace]");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(warning.getAttribute("data-polaris-grace")).toBe("warning");
    expect(warning.textContent).toBe("Offline · 2 days left to reconnect");
    expect(warning.querySelector("svg")).toBeTruthy();
    two.adapter.dispose();
    cleanup();
    const last = renderGate(
      makeFakeBridge(graceIn(3 * 3600)),
      services(),
      "Tidewater",
    );
    const banner = await waitFor(() => {
      const el = last.container.querySelector("[data-polaris-grace]");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(banner.textContent).toBe(
      "Offline · reconnect today to keep using Tidewater",
    );
    last.adapter.dispose();
  });
});

describe("LicenseGate — loading", () => {
  it("shows nothing for 300 ms, then the muted status line", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const bridge = makeFakeBridge(emptyBridgeState());
    bridge.getSyncState = () => new Promise(() => undefined);
    const { container, adapter } = renderGate(bridge);
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-polaris-gate="loading"]'),
    ).toBeTruthy();
    expect(container.querySelector('[role="status"]')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(320);
    });
    const status = within(container).getByRole("status");
    expect(status.textContent).toBe("Checking your license…");
    expect(
      (status.querySelector("p") as HTMLElement).style.fontWeight,
    ).not.toBe("700");
    adapter.dispose();
  });
});
