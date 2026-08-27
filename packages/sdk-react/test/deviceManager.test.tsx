// `<DeviceManager>` — list / rename / disconnect.
//
// The state this file exists for is the UNSUPPORTED one. A browser cookie session cannot reach
// `/<p>/devices` (no bearer token) and a pre-v2 desktop bridge has no `invoke`, so both refuse
// with `device-management-unsupported`. Rendering that refusal as a red error trains people to
// ignore real errors, so it is a first-class explanatory state instead.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { PolarisKeyProvider } from "../src/react/Provider.js";
import { DeviceManager } from "../src/components/DeviceManager.js";
import { browserAdapter } from "../src/browser/browserAdapter.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import type { PolarisAdapter } from "../src/core/index.js";
import type { PolarisBridge } from "../src/desktop/bridge.js";
import {
  makeDoc,
  makeFakeBridge,
  makeFakeFetch,
  NOW_SEC,
  okBridgeState,
  services,
} from "./fixtures.js";

afterEach(cleanup);

/** `waitFor` treats a null RETURN as success — only a throw retries. This asserts inside the
 *  callback so the query actually waits for the element to appear. */
async function findEl<T extends Element>(
  container: HTMLElement,
  selector: string,
): Promise<T> {
  return (await waitFor(() => {
    const el = container.querySelector(selector);
    expect(el, selector).toBeTruthy();
    return el;
  })) as T;
}

const roster = [
  { id: "dev-1", current: true, status: "ok" as const, label: "Laptop" },
  {
    id: "dev-2",
    current: false,
    status: "ok" as const,
    label: null,
    platform: "windows",
    appVersion: "1.2.3",
  },
];

function renderManager(adapter: PolarisAdapter, readOnly = false) {
  const utils = render(
    <PolarisKeyProvider productSlug="acme" adapter={adapter}>
      <DeviceManager readOnly={readOnly} />
    </PolarisKeyProvider>,
  );
  return { ...utils, adapter };
}

function desktopWithInvoke(invoke: PolarisBridge["invoke"]): PolarisAdapter {
  const bridge = makeFakeBridge(okBridgeState());
  bridge.invoke = invoke;
  return desktopAdapter({
    bridge,
    now: () => NOW_SEC,
    expectServices: services(),
  });
}

describe("DeviceManager — the roster", () => {
  it("lists every device and badges the current one", async () => {
    const adapter = desktopWithInvoke((async (_s, m) =>
      m === "list" ? roster : undefined) as PolarisBridge["invoke"]);
    const { container } = renderManager(adapter);
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-devices="rows"]'),
      ).toBeTruthy(),
    );
    expect(
      container.querySelector('[data-polaris-device="dev-1"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-polaris-device="dev-2"]'),
    ).toBeTruthy();
    expect(
      container.querySelectorAll("[data-polaris-device-current]"),
    ).toHaveLength(1);
    expect(container.textContent).toContain("windows");
    adapter.dispose();
  });

  it("renames a device through the adapter and reloads", async () => {
    const invoke = vi.fn(async (_service: string, method: string) =>
      method === "list" ? roster : undefined,
    );
    const adapter = desktopWithInvoke(invoke as PolarisBridge["invoke"]);
    const { container } = renderManager(adapter);
    const input = await findEl<HTMLInputElement>(
      container,
      '[data-polaris-device-input="dev-2"]',
    );
    fireEvent.change(input, { target: { value: "Studio" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("devices", "rename", {
        deviceId: "dev-2",
        label: "Studio",
      }),
    );
    adapter.dispose();
  });

  it("clearing the name renames to null rather than an empty string", async () => {
    const invoke = vi.fn(async (_service: string, method: string) =>
      method === "list" ? roster : undefined,
    );
    const adapter = desktopWithInvoke(invoke as PolarisBridge["invoke"]);
    const { container } = renderManager(adapter);
    const input = await findEl<HTMLInputElement>(
      container,
      '[data-polaris-device-input="dev-1"]',
    );
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("devices", "rename", {
        deviceId: "dev-1",
        label: null,
      }),
    );
    adapter.dispose();
  });

  it("disconnects another device through the adapter", async () => {
    const invoke = vi.fn(async (_service: string, method: string) =>
      method === "list" ? roster : undefined,
    );
    const adapter = desktopWithInvoke(invoke as PolarisBridge["invoke"]);
    const { container } = renderManager(adapter);
    const btn = await findEl<HTMLButtonElement>(
      container,
      '[data-polaris-device-disconnect="dev-2"]',
    );
    // The disconnect action names WHICH device it releases, so a screen-reader user is not
    // choosing between three identically named buttons.
    expect(btn.getAttribute("aria-label")).toBe("Disconnect dev-2");
    fireEvent.click(btn);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("devices", "deauthorize", {
        deviceId: "dev-2",
      }),
    );
    adapter.dispose();
  });

  it("readOnly hides the rename form but keeps disconnect", async () => {
    const adapter = desktopWithInvoke((async (_s, m) =>
      m === "list" ? roster : undefined) as PolarisBridge["invoke"]);
    const { container } = renderManager(adapter, true);
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-devices="rows"]'),
      ).toBeTruthy(),
    );
    expect(container.querySelector("[data-polaris-device-input]")).toBeNull();
    expect(
      container.querySelector("[data-polaris-device-disconnect]"),
    ).toBeTruthy();
    adapter.dispose();
  });

  it("renders the empty state for a licensed device with no roster", async () => {
    const adapter = desktopWithInvoke((async (_s, m) =>
      m === "list" ? [] : undefined) as PolarisBridge["invoke"]);
    const { container } = renderManager(adapter);
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-devices="empty"]'),
      ).toBeTruthy(),
    );
    adapter.dispose();
  });
});

describe("DeviceManager — device-management-unsupported", () => {
  it("a browser session degrades to the current device plus an explanation", async () => {
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl: makeFakeFetch(makeDoc()),
      now: () => NOW_SEC,
    });
    const { container } = renderManager(adapter);
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-devices="partial"]'),
      ).toBeTruthy(),
    );
    // The device the session DOES know is still shown — pretending the user has none would
    // be a worse lie than the incomplete roster.
    expect(
      container.querySelector('[data-polaris-device="dev-1"]'),
    ).toBeTruthy();
    // It is an explanation (status), never a role=alert failure.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toMatch(
      /not supported from a browser session/i,
    );
    adapter.dispose();
  });

  it("with no device knowable at all it renders the explanatory screen", async () => {
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl: makeFakeFetch(null),
      now: () => NOW_SEC,
    });
    const { container } = renderManager(adapter);
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-devices="unsupported"]'),
      ).toBeTruthy(),
    );
    expect(container.textContent).toMatch(/Device management is unavailable/i);
    adapter.dispose();
  });

  it("a desktop bridge without invoke() is unsupported, not broken", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(okBridgeState()),
      now: () => NOW_SEC,
      expectServices: services(),
    });
    const { container } = renderManager(adapter);
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-devices="partial"]'),
      ).toBeTruthy(),
    );
    expect(container.textContent).toMatch(/does not expose that capability/i);
    // The rename affordance is withdrawn along with the capability.
    expect(container.querySelector("[data-polaris-device-input]")).toBeNull();
    adapter.dispose();
  });

  it("a real failure IS an alert (the unsupported path must not swallow one)", async () => {
    const adapter = desktopWithInvoke((async () => {
      throw new Error("roster exploded");
    }) as PolarisBridge["invoke"]);
    const { container } = renderManager(adapter);
    const alert = await waitFor(() => within(container).getByRole("alert"));
    expect(alert.textContent).toContain("roster exploded");
    adapter.dispose();
  });
});
