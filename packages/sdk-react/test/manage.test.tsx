// @pkey-feature license.manage ui.kit.manage
//
// PX-W8 (WIRE-CONTRACT-V4 §5.3): the device-limit refusal link. Both adapters forward a valid
// `manageUrl` onto the license error (and drop an invalid one), and the sign-in card shows
// "Replace a device", which opens the link with the app's return URL and the typed key as a
// fragment. It is never an auth failure: the state is not wiped.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { PolarisKeyProvider } from "../src/react/Provider.js";
import { PolarisLogin } from "../src/components/PolarisLogin.js";
import { browserAdapter } from "../src/browser/browserAdapter.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import type { BridgeActivation } from "../src/desktop/bridge.js";
import type { PolarisAdapter } from "../src/core/index.js";
import {
  emptyBridgeState,
  makeFakeBridge,
  makeFakeFetch,
  services,
} from "./fixtures.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const NOW_SEC = 2000;
const ACTIVATE =
  "https://key.plrs.im/activate?product=acme&next=free-device&for=Web";

function browserWith(body: unknown): PolarisAdapter {
  const base = makeFakeFetch(null);
  return browserAdapter({
    auth: "cookie",
    productSlug: "acme",
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/identity/session/license"))
        return new Response(JSON.stringify(body), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      return base(input, init);
    }) as typeof fetch,
    now: () => NOW_SEC,
  });
}

describe("adapters forward manageUrl on device-limit", () => {
  it("the browser adapter, flat body", async () => {
    const adapter = browserWith({
      error: "device_limit",
      limit: 1,
      deviceCount: 1,
      manageUrl: ACTIVATE,
    });
    await expect(adapter.submitKey("k")).rejects.toMatchObject({
      code: "sign-in-failed",
      wireCode: "device_limit",
      manageUrl: ACTIVATE,
    });
    adapter.dispose();
  });

  it("the browser adapter drops an invalid link and still reports device-limit", async () => {
    const adapter = browserWith({
      error: "device_limit",
      manageUrl: "javascript:alert(1)",
      somethingNew: 1,
    });
    const err = await adapter.submitKey("k").catch((e: unknown) => e);
    expect(err).toMatchObject({
      wireCode: "device_limit",
      activation: { kind: "deviceLimit" },
    });
    expect((err as { manageUrl?: string }).manageUrl).toBeUndefined();
    adapter.dispose();
  });

  it("the desktop adapter, from the bridge", async () => {
    const bridge = makeFakeBridge(emptyBridgeState());
    bridge.submitKey = vi.fn(
      async () =>
        ({
          kind: "device-limit",
          limit: 1,
          manageUrl: ACTIVATE,
        }) as BridgeActivation,
    );
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    await expect(adapter.submitKey("k")).rejects.toMatchObject({
      manageUrl: ACTIVATE,
    });
    expect(adapter.snapshot().error.license?.manageUrl).toBe(ACTIVATE);
    adapter.dispose();
  });
});

describe("PolarisLogin — Replace a device", () => {
  it("opens the link with return= and the key fragment", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const bridge = makeFakeBridge(
      emptyBridgeState({ capabilities: services("license", "config") }),
    );
    bridge.submitKey = vi.fn(
      async () =>
        ({ kind: "device-limit", manageUrl: ACTIVATE }) as BridgeActivation,
    );
    const adapter = desktopAdapter({
      bridge,
      now: () => NOW_SEC,
      expectServices: services("license", "config"),
    });
    const { container } = render(
      <PolarisKeyProvider productSlug="acme" adapter={adapter}>
        <PolarisLogin returnUrl="myapp://back" />
      </PolarisKeyProvider>,
    );
    const input = await waitFor(() => {
      const el = container.querySelector("[data-polaris-key-input]");
      expect(el).toBeTruthy();
      return el as HTMLInputElement;
    });
    expect(container.querySelector("[data-polaris-free-device]")).toBeNull();
    fireEvent.change(input, { target: { value: "pkey_acme_KEY" } });
    fireEvent.submit(input.closest("form")!);
    const button = await waitFor(() => {
      const el = container.querySelector("[data-polaris-free-device]");
      expect(el).toBeTruthy();
      return el as HTMLButtonElement;
    });
    expect(button.textContent).toBe("Replace a device");
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(open).toHaveBeenCalledWith(
      "https://key.plrs.im/activate?product=acme&next=free-device&for=Web&return=myapp%3A%2F%2Fback#key=pkey_acme_KEY",
      "_blank",
      "noopener,noreferrer",
    );
    adapter.dispose();
  });

  it("shows no button when the refusal carries no link", async () => {
    const bridge = makeFakeBridge(
      emptyBridgeState({ capabilities: services("license", "config") }),
    );
    bridge.submitKey = vi.fn(
      async () => ({ kind: "device-limit" }) as BridgeActivation,
    );
    const adapter = desktopAdapter({
      bridge,
      now: () => NOW_SEC,
      expectServices: services("license", "config"),
    });
    const { container } = render(
      <PolarisKeyProvider productSlug="acme" adapter={adapter}>
        <PolarisLogin />
      </PolarisKeyProvider>,
    );
    const input = await waitFor(() => {
      const el = container.querySelector("[data-polaris-key-input]");
      expect(el).toBeTruthy();
      return el as HTMLInputElement;
    });
    fireEvent.change(input, { target: { value: "k" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() =>
      expect(container.querySelector("[role=alert]")).toBeTruthy(),
    );
    expect(container.querySelector("[data-polaris-free-device]")).toBeNull();
    adapter.dispose();
  });
});
