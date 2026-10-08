// @pkey-feature devices.manage ui.kit
// `<DeviceManager>` — list / rename / remove.
//
// The state this file exists for is the UNSUPPORTED one. A browser cookie session cannot reach
// `/<p>/devices` (no bearer token) and a pre-v2 desktop bridge has no `invoke`, so both refuse
// with `device-management-unsupported`. Rendering that refusal as a red error trains people to
// ignore real errors, so it is a first-class explanatory state instead. A real failure to load
// is its own state too: never the false "no devices".

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
import { PolarisError, type PolarisAdapter } from "../src/core/index.js";
import type { PolarisBridge } from "../src/desktop/bridge.js";
import {
  makeDoc,
  makeFakeBridge,
  makeFakeFetch,
  NOW_SEC,
  okBridgeState,
  services,
} from "./fixtures.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** `waitFor` treats a null RETURN as success — only a throw retries. This asserts inside the
 *  callback so the query actually waits for the element to appear. */
async function findEl<T extends Element>(
  container: Element,
  selector: string,
): Promise<T> {
  return (await waitFor(() => {
    const el = container.querySelector(selector);
    expect(el, selector).toBeTruthy();
    return el;
  })) as T;
}

/** Press a row's Rename and return the field it opens. */
async function openRename(
  container: HTMLElement,
  deviceId: string,
): Promise<HTMLInputElement> {
  const rename = await findEl<HTMLButtonElement>(
    container,
    `[data-polaris-device-rename="${deviceId}"]`,
  );
  fireEvent.click(rename);
  return findEl<HTMLInputElement>(
    container,
    `[data-polaris-device-input="${deviceId}"]`,
  );
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
  {
    id: "dev-3",
    current: false,
    status: "ok" as const,
    label: "Studio iPad",
    platform: "ipados",
  },
];

function renderManager(
  adapter: PolarisAdapter,
  props: Parameters<typeof DeviceManager>[0] = {},
) {
  const utils = render(
    <PolarisKeyProvider productSlug="acme" adapter={adapter}>
      <DeviceManager {...props} />
    </PolarisKeyProvider>,
  );
  return { ...utils, adapter };
}

function desktopWithInvoke(
  invoke: PolarisBridge["invoke"],
  doc = makeDoc(),
): { adapter: PolarisAdapter; bridge: ReturnType<typeof makeFakeBridge> } {
  const bridge = makeFakeBridge(okBridgeState({ doc }));
  bridge.invoke = invoke;
  const adapter = desktopAdapter({
    bridge,
    now: () => NOW_SEC,
    expectServices: services(),
  });
  return { adapter, bridge };
}

function rosterInvoke(rows: unknown[] = roster) {
  return vi.fn(async (_service: string, method: string) =>
    method === "list" ? rows : undefined,
  );
}

describe("DeviceManager — the roster", () => {
  it("lists every device, names its platform and badges the current one", async () => {
    const { adapter } = desktopWithInvoke(
      rosterInvoke() as PolarisBridge["invoke"],
    );
    const { container } = renderManager(adapter);
    await findEl(container, '[data-polaris-devices="rows"]');
    for (const id of ["dev-1", "dev-2", "dev-3"])
      expect(
        container.querySelector(`[data-polaris-device="${id}"]`),
      ).toBeTruthy();
    expect(
      container.querySelectorAll("[data-polaris-device-current]"),
    ).toHaveLength(1);
    // Platform ids read as people write them; the status slug never shows.
    expect(container.textContent).toContain("Windows");
    expect(container.textContent).toContain("iPadOS");
    expect(container.textContent).not.toMatch(/\bok\b/);
    // The subtitle counts them.
    expect(
      container.querySelector("[data-polaris-devices-subtitle]")?.textContent,
    ).toBe("3 devices");
    adapter.dispose();
  });

  it("an unnamed device is titled Unnamed device, its id on the muted line", async () => {
    const { adapter } = desktopWithInvoke(
      rosterInvoke() as PolarisBridge["invoke"],
    );
    const { container } = renderManager(adapter);
    const row = await findEl<HTMLElement>(
      container,
      '[data-polaris-device="dev-2"]',
    );
    expect(row.textContent).toContain("Unnamed device");
    expect(row.textContent).toContain("Windows · dev-2");
    adapter.dispose();
  });

  it("the subtitle names the limit when the license carries one", async () => {
    const doc = makeDoc({
      entitlements: {
        deviceLimit: { state: "enforced", value: 5, updatedAt: 950 },
      },
    });
    const { adapter } = desktopWithInvoke(
      rosterInvoke() as PolarisBridge["invoke"],
      doc,
    );
    const { container } = renderManager(adapter);
    await waitFor(() =>
      expect(
        container.querySelector("[data-polaris-devices-subtitle]")?.textContent,
      ).toBe("Your license is on 3 of 5 devices"),
    );
    adapter.dispose();
  });

  it("draws no divider under the last row", async () => {
    const { adapter } = desktopWithInvoke(
      rosterInvoke() as PolarisBridge["invoke"],
    );
    const { container } = renderManager(adapter);
    const last = await findEl<HTMLElement>(
      container,
      '[data-polaris-device="dev-3"]',
    );
    expect(last.style.borderBottom).not.toContain("solid");
    const first = container.querySelector(
      '[data-polaris-device="dev-1"]',
    ) as HTMLElement;
    expect(first.style.borderBottom).toContain("1px solid");
    adapter.dispose();
  });

  it("renames a device through the adapter, reloads and puts focus back on Rename", async () => {
    const invoke = rosterInvoke();
    const { adapter } = desktopWithInvoke(invoke as PolarisBridge["invoke"]);
    const { container } = renderManager(adapter);
    const input = await openRename(container, "dev-2");
    fireEvent.change(input, { target: { value: "Studio" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("devices", "rename", {
        deviceId: "dev-2",
        label: "Studio",
      }),
    );
    // A saved name closes the field, and focus lands on that row's Rename.
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-device-input="dev-2"]'),
      ).toBeNull(),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        container.querySelector('[data-polaris-device-rename="dev-2"]'),
      ),
    );
    adapter.dispose();
  });

  it("opens the rename field only when asked, in place of the name, one row at a time", async () => {
    const invoke = rosterInvoke();
    const { adapter } = desktopWithInvoke(invoke as PolarisBridge["invoke"]);
    const { container } = renderManager(adapter);
    await findEl(container, '[data-polaris-device-rename="dev-1"]');
    // No row carries an open form until its Rename is pressed.
    expect(container.querySelector("[data-polaris-device-input]")).toBeNull();
    const rename = container.querySelector(
      '[data-polaris-device-rename="dev-1"]',
    ) as HTMLButtonElement;
    // The action names its device (a11y.renameDevice).
    expect(rename.getAttribute("aria-label")).toBe("Rename Laptop");
    const input = await openRename(container, "dev-1");
    expect(document.activeElement).toBe(input);
    expect(within(container).getByLabelText("Device name")).toBe(input);
    // While renaming, the row shows only Save and Cancel: no Rename, no Remove.
    const row = container.querySelector(
      '[data-polaris-device="dev-1"]',
    ) as HTMLElement;
    expect(row.querySelector("[data-polaris-device-disconnect]")).toBeNull();
    expect(row.querySelector("[data-polaris-device-rename]")).toBeNull();
    // The field is described by the row's name.
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    expect(
      describedBy
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent),
    ).toContain("Laptop");
    // Opening another row's rename closes this one.
    await openRename(container, "dev-3");
    expect(
      container.querySelectorAll("[data-polaris-device-input]"),
    ).toHaveLength(1);
    const field = container.querySelector(
      '[data-polaris-device-input="dev-3"]',
    ) as HTMLInputElement;
    fireEvent.keyDown(field, { key: "Escape" });
    await waitFor(() =>
      expect(container.querySelector("[data-polaris-device-input]")).toBeNull(),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        container.querySelector('[data-polaris-device-rename="dev-3"]'),
      ),
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "devices",
      "rename",
      expect.anything(),
    );
    adapter.dispose();
  });

  it("clearing the name renames to null rather than an empty string", async () => {
    const invoke = rosterInvoke();
    const { adapter } = desktopWithInvoke(invoke as PolarisBridge["invoke"]);
    const { container } = renderManager(adapter);
    const input = await openRename(container, "dev-1");
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

  it("a failed rename shows the catalog sentence under its field, which keeps what was typed", async () => {
    const invoke = vi.fn(async (_service: string, method: string) => {
      if (method === "rename") throw new Error("HTTP 500 from /acme/devices");
      return method === "list" ? roster : undefined;
    });
    const { adapter } = desktopWithInvoke(invoke as PolarisBridge["invoke"]);
    const { container } = renderManager(adapter);
    const input = await openRename(container, "dev-3");
    fireEvent.change(input, { target: { value: "Kitchen" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    const error = await findEl<HTMLElement>(
      container,
      '[data-polaris-device-error="dev-3"]',
    );
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toBe(
      "The device couldn't be renamed. Try again.",
    );
    expect(container.textContent).not.toContain("HTTP 500");
    const field = container.querySelector(
      '[data-polaris-device-input="dev-3"]',
    ) as HTMLInputElement;
    expect(field.value).toBe("Kitchen");
    expect(field.getAttribute("aria-describedby")).toContain(error.id);
    adapter.dispose();
  });

  it("removes another device only from the inline confirm, which opens on Cancel", async () => {
    const invoke = rosterInvoke();
    const { adapter } = desktopWithInvoke(invoke as PolarisBridge["invoke"]);
    const { container } = renderManager(adapter);
    const btn = await findEl<HTMLButtonElement>(
      container,
      '[data-polaris-device-disconnect="dev-3"]',
    );
    // A neutral Remove, naming WHICH device, so a screen-reader user is not choosing between
    // identically named buttons.
    expect(btn.textContent).toBe("Remove");
    expect(btn.getAttribute("aria-label")).toBe("Remove Studio iPad");
    expect(btn.style.color).not.toContain("danger");
    fireEvent.click(btn);
    const confirm = await findEl<HTMLElement>(
      container,
      '[data-polaris-device-confirm="dev-3"]',
    );
    expect(confirm.textContent).toContain(
      "Remove Studio iPad? It signs out of This app.",
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        confirm.querySelector("[data-polaris-device-confirm-cancel]"),
      ),
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "devices",
      "deauthorize",
      expect.anything(),
    );
    fireEvent.click(
      confirm.querySelector(
        '[data-polaris-device-confirm-remove="dev-3"]',
      ) as HTMLButtonElement,
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("devices", "deauthorize", {
        deviceId: "dev-3",
      }),
    );
    adapter.dispose();
  });

  it("Escape cancels the confirm and puts focus back on the row's action", async () => {
    const invoke = rosterInvoke();
    const { adapter } = desktopWithInvoke(invoke as PolarisBridge["invoke"]);
    const { container } = renderManager(adapter);
    fireEvent.click(
      await findEl(container, '[data-polaris-device-disconnect="dev-2"]'),
    );
    const confirm = await findEl<HTMLElement>(
      container,
      '[data-polaris-device-confirm="dev-2"]',
    );
    fireEvent.keyDown(
      confirm.querySelector("[data-polaris-device-confirm-cancel]")!,
      { key: "Escape" },
    );
    await waitFor(() =>
      expect(
        container.querySelector("[data-polaris-device-confirm]"),
      ).toBeNull(),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        container.querySelector('[data-polaris-device-disconnect="dev-2"]'),
      ),
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "devices",
      "deauthorize",
      expect.anything(),
    );
    adapter.dispose();
  });

  it("after a removal, focus moves to the next row's first action", async () => {
    let rows = [...roster];
    const invoke = vi.fn(
      async (_service: string, method: string, args?: unknown) => {
        if (method === "deauthorize") {
          const { deviceId } = args as { deviceId: string };
          rows = rows.filter((r) => r.id !== deviceId);
          return undefined;
        }
        return method === "list" ? rows : undefined;
      },
    );
    const { adapter } = desktopWithInvoke(invoke as PolarisBridge["invoke"]);
    const { container } = renderManager(adapter);
    fireEvent.click(
      await findEl(container, '[data-polaris-device-disconnect="dev-2"]'),
    );
    fireEvent.click(
      await findEl(container, '[data-polaris-device-confirm-remove="dev-2"]'),
    );
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-device="dev-2"]'),
      ).toBeNull(),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        container.querySelector('[data-polaris-device-rename="dev-3"]'),
      ),
    );
    adapter.dispose();
  });

  it("a failed removal shows the catalog sentence inside its row", async () => {
    const invoke = vi.fn(async (_service: string, method: string) => {
      if (method === "deauthorize") throw new Error("HTTP 500 from /acme");
      return method === "list" ? roster : undefined;
    });
    const { adapter } = desktopWithInvoke(invoke as PolarisBridge["invoke"]);
    const { container } = renderManager(adapter);
    fireEvent.click(
      await findEl(container, '[data-polaris-device-disconnect="dev-3"]'),
    );
    fireEvent.click(
      await findEl(container, '[data-polaris-device-confirm-remove="dev-3"]'),
    );
    const row = container.querySelector(
      '[data-polaris-device="dev-3"]',
    ) as HTMLElement;
    const error = await findEl<HTMLElement>(
      row,
      '[data-polaris-device-error="dev-3"]',
    );
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toBe(
      "The device couldn't be removed. Try again.",
    );
    expect(container.textContent).not.toContain("HTTP 500");
    adapter.dispose();
  });

  it("this device's row signs out, after the same confirm", async () => {
    const invoke = rosterInvoke();
    const { adapter, bridge } = desktopWithInvoke(
      invoke as PolarisBridge["invoke"],
    );
    const signOut = vi.spyOn(bridge, "signOut");
    const { container } = renderManager(adapter);
    const btn = await findEl<HTMLButtonElement>(
      container,
      '[data-polaris-device-disconnect="dev-1"]',
    );
    expect(btn.textContent).toBe("Sign out");
    fireEvent.click(btn);
    fireEvent.click(
      await findEl(container, '[data-polaris-device-confirm-remove="dev-1"]'),
    );
    await waitFor(() => expect(signOut).toHaveBeenCalled());
    expect(invoke).not.toHaveBeenCalledWith(
      "devices",
      "deauthorize",
      expect.anything(),
    );
    adapter.dispose();
  });

  it("readOnly hides rename but keeps remove", async () => {
    const { adapter } = desktopWithInvoke(
      rosterInvoke() as PolarisBridge["invoke"],
    );
    const { container } = renderManager(adapter, { readOnly: true });
    await findEl(container, '[data-polaris-devices="rows"]');
    expect(container.querySelector("[data-polaris-device-rename]")).toBeNull();
    expect(container.querySelector("[data-polaris-device-input]")).toBeNull();
    expect(
      container.querySelector("[data-polaris-device-disconnect]"),
    ).toBeTruthy();
    adapter.dispose();
  });

  it("renders the empty state for a licensed device with no roster", async () => {
    const { adapter } = desktopWithInvoke(
      rosterInvoke([]) as PolarisBridge["invoke"],
    );
    const { container } = renderManager(adapter);
    const empty = await findEl(container, '[data-polaris-devices="empty"]');
    expect(empty.textContent).toBe("No devices are using this license yet.");
    adapter.dispose();
  });

  it("a refresh keeps the rows on screen: the loading line is the first load's only", async () => {
    let release: (() => void) | null = null;
    let lists = 0;
    const invoke = vi.fn(async (_service: string, method: string) => {
      if (method !== "list") return undefined;
      lists++;
      if (lists > 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return roster;
    });
    const { adapter } = desktopWithInvoke(invoke as PolarisBridge["invoke"]);
    const { container } = renderManager(adapter);
    const input = await openRename(container, "dev-3");
    fireEvent.change(input, { target: { value: "Kitchen" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() => expect(lists).toBe(2));
    expect(
      container.querySelector('[data-polaris-devices="rows"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-polaris-devices="loading"]'),
    ).toBeNull();
    (release as (() => void) | null)?.();
    adapter.dispose();
  });

  it("bare drops the card chrome and keeps the title", async () => {
    const { adapter } = desktopWithInvoke(
      rosterInvoke() as PolarisBridge["invoke"],
    );
    const { container } = renderManager(adapter, { bare: true });
    const panel = await findEl<HTMLElement>(
      container,
      '[data-polaris-devices="panel"]',
    );
    expect(panel.style.background).toBe("transparent");
    expect(panel.style.borderRadius).toMatch(/^0(px)?$/);
    expect(within(panel).getByRole("heading").textContent).toBe("Your devices");
    adapter.dispose();
  });
});

describe("DeviceManager — a failure to load is not an empty list", () => {
  it("shows the catalog's title and sentence and Try again, never 'no devices' or the raw text", async () => {
    let fail = true;
    const invoke = vi.fn(async (_service: string, method: string) => {
      if (method !== "list") return undefined;
      if (fail) throw new Error("roster exploded");
      return roster;
    });
    const { adapter } = desktopWithInvoke(invoke as PolarisBridge["invoke"]);
    const { container } = renderManager(adapter);
    const alert = await waitFor(() => within(container).getByRole("alert"));
    expect(alert.getAttribute("data-polaris-devices")).toBe("error");
    expect(alert.textContent).toContain("Couldn't load devices");
    expect(alert.textContent).toContain(
      "Your devices couldn't be loaded. Check your connection and try again.",
    );
    expect(container.textContent).not.toContain("roster exploded");
    expect(
      container.querySelector('[data-polaris-devices="empty"]'),
    ).toBeNull();
    // Try again re-runs the load.
    fail = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await findEl(container, '[data-polaris-devices="rows"]');
    expect(
      container.querySelector('[data-polaris-devices="error"]'),
    ).toBeNull();
    adapter.dispose();
  });

  it("a network failure reads Can't connect", async () => {
    const invoke = vi.fn(async () => {
      throw new PolarisError("network", "fetch failed");
    });
    const { adapter } = desktopWithInvoke(invoke as PolarisBridge["invoke"]);
    const { container } = renderManager(adapter);
    const alert = await waitFor(() => within(container).getByRole("alert"));
    expect(alert.textContent).toContain("Can't connect");
    adapter.dispose();
  });
});

describe("DeviceManager — device-management-unsupported", () => {
  it("a browser session degrades to the current device plus where to manage the rest", async () => {
    const adapter = browserAdapter({
      auth: "cookie",
      productSlug: "acme",
      fetchImpl: makeFakeFetch(makeDoc()),
      now: () => NOW_SEC,
    });
    const { container } = renderManager(adapter);
    const partial = await findEl(container, '[data-polaris-devices="partial"]');
    expect(partial.textContent).toBe("Manage your devices in your browser.");
    // The device the session DOES know is still shown — pretending the person has none would
    // be a worse lie than the incomplete roster — titled by name, never by id or status.
    const row = container.querySelector(
      '[data-polaris-device="dev-1"]',
    ) as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.textContent).toContain("Unnamed device");
    // It is an explanation (status), never a role=alert failure.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    adapter.dispose();
  });

  it("with no device knowable at all it explains inside the panel, with the manage link when given", async () => {
    const adapter = browserAdapter({
      auth: "cookie",
      productSlug: "acme",
      fetchImpl: makeFakeFetch(null),
      now: () => NOW_SEC,
    });
    const { container } = renderManager(adapter, {
      manageUrl: "https://key.plrs.im/portal/acme/devices",
    });
    const line = await findEl<HTMLElement>(
      container,
      '[data-polaris-devices="unsupported"]',
    );
    expect(line.textContent).toContain("Manage your devices in your browser.");
    // Inline, in the host's page: not a full-window dialog.
    expect(line.closest('[data-polaris-devices="panel"]')).toBeTruthy();
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    const link = line.querySelector("a") as HTMLAnchorElement;
    expect(link.textContent).toBe("Manage devices");
    expect(link.getAttribute("href")).toBe(
      "https://key.plrs.im/portal/acme/devices",
    );
    adapter.dispose();
  });

  it("a desktop bridge without invoke() is unsupported, not broken", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(okBridgeState()),
      now: () => NOW_SEC,
      expectServices: services(),
    });
    const { container } = renderManager(adapter);
    await findEl(container, '[data-polaris-devices="partial"]');
    // The rename affordance is withdrawn along with the capability.
    expect(container.querySelector("[data-polaris-device-rename]")).toBeNull();
    expect(container.querySelector("[data-polaris-device-input]")).toBeNull();
    adapter.dispose();
  });
});
