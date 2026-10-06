import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PortalProduct } from "../src/portal/api.js";
import {
  axeViolations,
  DAY,
  dlFile,
  downloadsView,
  fetchedRequests,
  license,
  mockFetch,
  NOW_S,
  renderPortal,
  signedIn,
  storeLink,
} from "./portalHarness.js";

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15";

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(MAC_UA);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const orbit = license({
  product: "orbit-survey",
  productName: "Orbit Survey",
  deviceCount: 2,
});

function product(over: Partial<PortalProduct> = {}): PortalProduct {
  return {
    product: "orbit-survey",
    name: "Orbit Survey",
    developerName: "Parallax Nine",
    tintColor: null,
    website: null,
    iconUrl: null,
    headerUrl: null,
    support: { url: "https://parallax.example/help", email: null },
    services: { license: true },
    status: "device_limit",
    addedAt: NOW_S - 30 * DAY,
    returnTo: { origins: ["https://orbit.example"], schemes: ["orbitsurvey"] },
    licenses: [
      {
        id: orbit.id,
        tier: null,
        status: "device_limit",
        licenseStatus: "active",
        activatedAt: NOW_S - 30 * DAY,
        expiresAt: null,
        maxOfflineDays: null,
        deviceLimit: 2,
        activeSeatCount: 2,
        deviceCount: 3,
        dormantCount: 1,
        entitlements: [],
        devices: [
          {
            deviceId: "gaming",
            label: "Gaming PC",
            platform: "windows",
            arch: "x86_64",
            appVersion: "2.0.3",
            firstSeen: NOW_S - 90 * DAY,
            lastSeen: NOW_S - DAY,
            dormant: false,
          },
          {
            deviceId: "work",
            label: "Work laptop",
            platform: "windows",
            arch: "x86_64",
            appVersion: "1.9.0",
            firstSeen: NOW_S - 200 * DAY,
            lastSeen: NOW_S - 41 * DAY,
            dormant: false,
          },
          {
            deviceId: "old",
            label: "Old iMac",
            platform: "macos",
            arch: "x86_64",
            appVersion: "1.0.0",
            firstSeen: NOW_S - 400 * DAY,
            lastSeen: NOW_S - 120 * DAY,
            dormant: true,
          },
        ],
      },
    ],
    ...over,
  };
}

function go(hash: string): void {
  window.history.replaceState(null, "", `/${hash}`);
}

describe("device limit, focused flow (§4.25, PX-10)", () => {
  it("minimal chrome; the least recent seat preselected; removes it and returns to the app", async () => {
    let removed = false;
    mockFetch(
      signedIn([orbit], {
        "/api/products/orbit-survey": () =>
          removed
            ? product({
                status: "active",
                licenses: [{ ...product().licenses[0]!, activeSeatCount: 1 }],
              })
            : product(),
        "DELETE /api/licenses/orbit-survey/lic_orbit-survey/devices/work":
          () => {
            removed = true;
            return { ok: true, deviceId: "work" };
          },
      }),
    );
    go(
      "#/p/orbit-survey/free-device?for=Mara%E2%80%99s%20Steam%20Deck&return=orbitsurvey%3A%2F%2Fretry",
    );
    renderPortal();
    const h1 = await screen.findByRole("heading", {
      level: 1,
      name: "Your license is on 2 of 2 devices",
    });
    expect(h1).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    // No nav: only the way back to the app.
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    // An app sent the person (a declared `return=`): only then is it "Back to Orbit Survey".
    const back = screen.getByRole("link", { name: "Back to Orbit Survey" });
    expect(back.getAttribute("href")).toBe("orbitsurvey://retry");
    expect(screen.getByText("Mara’s Steam Deck")).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "2 of 2 devices in use" }),
    ).toBeTruthy();
    const radios = screen.getAllByRole("radio");
    // Dormant devices hold no seat and are not offered.
    expect(radios).toHaveLength(2);
    const work = screen.getByRole("radio", { name: /Work laptop/ });
    expect(work.getAttribute("aria-checked")).toBe("true");
    // "Least recent" is text in the meta, never a pill (FLOWS.md P-6).
    expect(within(work).getByText(/· least\srecent$/)).toBeTruthy();
    expect(within(work).queryByText("Least recent")).toBeNull();
    expect(await axeViolations()).toEqual([]);

    await userEvent.click(
      screen.getByRole("button", { name: "Remove Work laptop" }),
    );
    const done = await screen.findByRole("heading", {
      level: 1,
      name: "Work laptop was removed",
    });
    await waitFor(() => expect(document.activeElement).toBe(done));
    // The header's way back and the done step's primary both go to the app.
    const backs = screen.getAllByRole("link", { name: "Back to Orbit Survey" });
    expect(backs).toHaveLength(2);
    for (const b of backs)
      expect(b.getAttribute("href")).toBe("orbitsurvey://retry");
    expect(screen.getByText("Try again")).toBeTruthy();
    expect(fetchedRequests()).toContain(
      "DELETE /api/licenses/orbit-survey/lic_orbit-survey/devices/work",
    );
  });

  it("an undeclared return URL is never followed: the flow ends on the product page", async () => {
    mockFetch(signedIn([orbit], { "/api/products/orbit-survey": product() }));
    go(
      "#/p/orbit-survey/free-device?return=https%3A%2F%2Fevil.example%2Fsteal",
    );
    renderPortal();
    // No app sent the person: nothing says "Back to Orbit Survey" or "press Try again".
    const back = await screen.findByRole("link", {
      name: "See Orbit Survey in your library",
    });
    expect(back.getAttribute("href")).toBe("#/p/orbit-survey");
    expect(
      screen.queryByRole("link", { name: /Back to Orbit Survey/ }),
    ).toBeNull();
    expect(screen.queryByText(/Try again/)).toBeNull();
    expect(document.body.innerHTML).not.toContain("evil.example");
    expect(
      screen.getByRole("link", { name: "Cancel" }).getAttribute("href"),
    ).toBe("#/p/orbit-survey");
  });

  it("a licence with a free seat says so and sends the person back", async () => {
    mockFetch(
      signedIn([orbit], {
        "/api/products/orbit-survey": product({
          licenses: [{ ...product().licenses[0]!, activeSeatCount: 1 }],
        }),
      }),
    );
    go(
      "#/p/orbit-survey/free-device?return=https%3A%2F%2Forbit.example%2Fplay",
    );
    renderPortal();
    await screen.findByRole("heading", {
      level: 1,
      name: "Your license has a free device",
    });
    expect(screen.queryByRole("radio")).toBeNull();
    const backs = screen.getAllByRole("link", { name: "Back to Orbit Survey" });
    expect(backs.map((b) => b.getAttribute("href"))).toEqual([
      "https://orbit.example/play",
      "https://orbit.example/play",
    ]);
    expect(screen.getByText("Try again")).toBeTruthy();
  });

  it("without return=, the done copy never sends the person back to an app", async () => {
    let removed = false;
    mockFetch(
      signedIn([orbit], {
        "/api/products/orbit-survey": () =>
          removed
            ? product({
                status: "active",
                licenses: [{ ...product().licenses[0]!, activeSeatCount: 1 }],
              })
            : product(),
        "DELETE /api/licenses/orbit-survey/lic_orbit-survey/devices/work":
          () => {
            removed = true;
            return { ok: true, deviceId: "work" };
          },
      }),
    );
    go("#/p/orbit-survey/free-device");
    renderPortal();
    await screen.findByRole("heading", {
      level: 1,
      name: "Your license is on 2 of 2 devices",
    });
    expect(screen.queryByText(/Try again/)).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Work laptop" }),
    );
    await screen.findByRole("heading", {
      level: 1,
      name: "Work laptop was removed",
    });
    expect(
      screen.getByText("Orbit Survey now has a free device."),
    ).toBeTruthy();
    expect(screen.queryByText(/Try again/)).toBeNull();
    expect(
      screen.queryByRole("link", { name: /Back to Orbit Survey/ }),
    ).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "See your devices" })
        .getAttribute("href"),
    ).toBe("#/p/orbit-survey/devices");
  });

  it("a product not in the library is the not-found page, inside the flow", async () => {
    mockFetch(signedIn([orbit]));
    go("#/p/nope/free-device");
    renderPortal();
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "That product isn't in your library",
      }),
    ).toBeTruthy();
  });
});

describe("one download, focused flow (PX-10)", () => {
  const view = downloadsView(
    "orbit-survey",
    [
      dlFile({ artifactId: "lin", platform: "linux", arch: "x86_64" }),
      dlFile({ artifactId: "mac", platform: "macos" }),
    ],
    {
      stores: [
        storeLink({
          kind: "steam",
          label: "Steam",
          platforms: ["linux", "windows"],
        }),
      ],
    },
  );

  it("offers the asked platform's build, its stores and the other platforms", async () => {
    mockFetch(
      signedIn([orbit], {
        "/api/products/orbit-survey": product({ status: "active" }),
        "/api/products/orbit-survey/downloads": view,
        "POST /api/releases/orbit-survey/rel_1.4.2/artifacts/lin/token": {
          url: "/download/tok",
        },
      }),
    );
    go("#/p/orbit-survey/download?platform=linux");
    renderPortal();
    await screen.findByRole("heading", {
      level: 1,
      name: "Download Orbit Survey for Linux",
    });
    expect(
      screen.getByRole("button", {
        name: /Download Orbit Survey 1\.4\.2 for Linux/,
      }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: /Steam/ })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Other platforms: macOS" }),
    ).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it("says why when the platform has nothing covered", async () => {
    mockFetch(
      signedIn([orbit], {
        "/api/products/orbit-survey": product({ status: "active" }),
        "/api/products/orbit-survey/downloads": downloadsView("orbit-survey", [
          dlFile({
            artifactId: "win",
            platform: "windows",
            canDownload: false,
            reason: "not_entitled",
          }),
        ]),
      }),
    );
    go("#/p/orbit-survey/download?platform=windows");
    renderPortal();
    expect(
      await screen.findByText("Your license doesn't include this version."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Download/ })).toBeNull();
  });
});
