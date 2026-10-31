import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  CAPS_ALL,
  NOW_S,
  axeViolations,
  fetchedRequests,
  mockFetch,
  renderPortal,
  signedIn,
} from "./portalHarness.js";

/**
 * Account → Devices (DEVICE-REMOVAL): the account's devices that hold no licence, "Signed in from
 * backup", and Remove with its consequences. The restore notice's link lands on #/account/devices.
 */

const BACKUP = {
  product: "quill",
  productName: "Quill",
  deviceId: "dev_restored",
  label: "Pixel 9",
  platform: "android",
  lastSeen: NOW_S - 3600,
  restored: true,
};
const PLAIN = {
  product: "quill",
  productName: "Quill",
  deviceId: "dev_plain",
  label: "Studio Mac",
  platform: "macos",
  lastSeen: NOW_S - 86400,
  restored: false,
};

beforeEach(() => {
  window.history.replaceState(null, "", "/#/account");
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const openRemove = async (region: HTMLElement) =>
  userEvent.click(
    await within(region).findByRole("button", { name: /Remove Studio Mac/ }),
  );
const confirmRemove = async (region: HTMLElement) =>
  userEvent.click(
    within(region)
      .getAllByRole("button", { name: /Remove Studio Mac/ })
      .at(-1)!,
  );

const removeStudioMac = async (region: HTMLElement) => {
  await openRemove(region);
  await confirmRemove(region);
};

describe("Account → Devices", () => {
  it("lists the licence-less devices with the backup badge on the restored one only", async () => {
    mockFetch(
      signedIn([], { "/api/me/devices": { devices: [BACKUP, PLAIN] } }),
    );
    renderPortal();
    const region = await screen.findByRole("region", { name: "Devices" });
    expect(within(region).getByText("Pixel 9")).toBeTruthy();
    expect(within(region).getByText("Studio Mac")).toBeTruthy();
    expect(within(region).getAllByText("Signed in from backup")).toHaveLength(
      1,
    );
    const badge = within(region).getByText("Signed in from backup");
    expect(badge.closest("li")?.textContent).toContain("Pixel 9");
    const nav = screen.getByRole("navigation", { name: "On this page" });
    expect(within(nav).getByRole("link", { name: "Devices" })).toBeTruthy();
    expect(await axeViolations()).toEqual([]);
  });

  it("is absent with no such device, and on a Worker without the route", async () => {
    mockFetch(signedIn([], { "/api/me/devices": { devices: [] } }));
    renderPortal();
    await screen.findByRole("heading", { level: 1, name: "Account" });
    await waitFor(() =>
      expect(fetchedRequests()).toContain("GET /api/me/devices"),
    );
    expect(screen.queryByRole("region", { name: "Devices" })).toBeNull();
    cleanup();
    mockFetch(signedIn());
    renderPortal();
    await screen.findByRole("heading", { level: 1, name: "Account" });
    expect(screen.queryByRole("region", { name: "Devices" })).toBeNull();
  });

  it("removing a restored device says it ends backup sign-in, then calls the account route", async () => {
    let devices = [BACKUP, PLAIN];
    mockFetch(
      signedIn([], {
        "/api/me/devices": () => ({ devices }),
        "DELETE /api/me/devices/quill/dev_restored": () => {
          devices = [PLAIN];
          return { ok: true, deviceId: "dev_restored" };
        },
      }),
    );
    renderPortal();
    const region = await screen.findByRole("region", { name: "Devices" });
    await userEvent.click(
      await within(region).findByRole("button", { name: /Remove Pixel 9/ }),
    );
    const heading = await within(region).findByRole("heading", {
      name: "Remove Pixel 9?",
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(
      within(region).getByText(
        "Backup sign-in for Quill stops working on all your devices.",
      ),
    ).toBeTruthy();
    expect(fetchedRequests()).not.toContain(
      "DELETE /api/me/devices/quill/dev_restored",
    );
    await userEvent.click(
      within(region)
        .getAllByRole("button", { name: /Remove Pixel 9/ })
        .at(-1)!,
    );
    expect(await screen.findByText("Pixel 9 was removed")).toBeTruthy();
    await waitFor(() =>
      expect(within(region).queryByText("Pixel 9")).toBeNull(),
    );
    expect(fetchedRequests()).toContain(
      "DELETE /api/me/devices/quill/dev_restored",
    );
  });

  it("an ordinary device does not claim backup sign-in ends", async () => {
    mockFetch(signedIn([], { "/api/me/devices": { devices: [PLAIN] } }));
    renderPortal();
    const region = await screen.findByRole("region", { name: "Devices" });
    await openRemove(region);
    await within(region).findByRole("heading", { name: "Remove Studio Mac?" });
    expect(within(region).queryByText(/Backup sign-in/)).toBeNull();
  });

  it("after the last device is removed the card stays with a status line and focus on its heading", async () => {
    let devices = [PLAIN];
    mockFetch(
      signedIn([], {
        "/api/me/devices": () => ({ devices }),
        "DELETE /api/me/devices/quill/dev_plain": () => {
          devices = [];
          return { ok: true, deviceId: "dev_plain" };
        },
      }),
    );
    renderPortal();
    const region = await screen.findByRole("region", { name: "Devices" });
    await removeStudioMac(region);
    expect(await within(region).findByText("No devices without a license."));
    const heading = within(region).getByRole("heading", { name: "Devices" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(
      within(
        screen.getByRole("navigation", { name: "On this page" }),
      ).getByRole("link", { name: "Devices" }),
    ).toBeTruthy();
  });

  it("a failed load keeps the section, with the error and Try again, and the nav entry", async () => {
    window.history.replaceState(null, "", "/#/account/devices");
    let fail = true;
    mockFetch(
      signedIn([], {
        "/api/me/devices": () =>
          fail
            ? { status: 500, body: { error: "internal" } }
            : { devices: [BACKUP] },
      }),
    );
    renderPortal();
    const region = await screen.findByRole("region", { name: "Devices" });
    expect(
      await within(region).findByText("Couldn't load your devices."),
    ).toBeTruthy();
    expect(
      within(
        screen.getByRole("navigation", { name: "On this page" }),
      ).getByRole("link", { name: "Devices" }),
    ).toBeTruthy();
    fail = false;
    await userEvent.click(
      within(region).getByRole("button", { name: "Try again" }),
    );
    expect(await within(region).findByText("Pixel 9")).toBeTruthy();
  });

  it("a deep link with nothing to remove says the device is already removed", async () => {
    window.history.replaceState(null, "", "/#/account/devices");
    mockFetch(signedIn([], { "/api/me/devices": { devices: [] } }));
    renderPortal();
    const region = await screen.findByRole("region", { name: "Devices" });
    expect(
      within(region).getByText("This device is already removed."),
    ).toBeTruthy();
  });

  it("promises the confirmation email only when the Worker can send mail", async () => {
    mockFetch(signedIn([], { "/api/me/devices": { devices: [PLAIN] } }));
    renderPortal();
    let region = await screen.findByRole("region", { name: "Devices" });
    await openRemove(region);
    await within(region).findByRole("heading", { name: "Remove Studio Mac?" });
    expect(
      within(region).getByText("We'll email you to confirm."),
    ).toBeTruthy();
    cleanup();
    mockFetch(
      signedIn(
        [],
        { "/api/me/devices": { devices: [PLAIN] } },
        {
          ...CAPS_ALL,
          auth: { oidc: true, magic: false },
        },
      ),
    );
    renderPortal();
    region = await screen.findByRole("region", { name: "Devices" });
    await openRemove(region);
    await within(region).findByRole("heading", { name: "Remove Studio Mac?" });
    expect(
      within(region).queryByText("We'll email you to confirm."),
    ).toBeNull();
  });

  it("the notice's link lands on the section", async () => {
    window.history.replaceState(null, "", "/#/account/devices");
    mockFetch(signedIn([], { "/api/me/devices": { devices: [BACKUP] } }));
    renderPortal();
    const region = await screen.findByRole("region", { name: "Devices" });
    expect(within(region).getByText("Signed in from backup")).toBeTruthy();
    expect(window.location.hash).toBe("#/account/devices");
  });

  it("a refused removal keeps the row and says so", async () => {
    mockFetch(
      signedIn([], {
        "/api/me/devices": { devices: [PLAIN] },
        "DELETE /api/me/devices/quill/dev_plain": {
          status: 404,
          body: { error: "not_found" },
        },
      }),
    );
    renderPortal();
    const region = await screen.findByRole("region", { name: "Devices" });
    await removeStudioMac(region);
    expect(
      await within(region).findByText("Couldn't remove Studio Mac. Try again."),
    ).toBeTruthy();
    expect(within(region).getByText("Studio Mac")).toBeTruthy();
  });
});
