import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ACCOUNT,
  license,
  mockFetch,
  renderPortal,
  signedIn,
} from "./portalHarness.js";

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("portal shell and data layer (PX-01)", () => {
  it("shows the login card when signed out", async () => {
    mockFetch({
      "/api/me": { status: 401 },
      "/api/capabilities": signedIn()["/api/capabilities"],
    });
    renderPortal();
    expect(
      await screen.findByRole("heading", { level: 1, name: /sign in/i }),
    ).toBeTruthy();
  });

  it("tells 'can't reach Polaris Locker' apart from signed out", async () => {
    mockFetch({ "/api/me": "network", "/api/capabilities": "network" });
    renderPortal();
    expect(
      await screen.findByRole("heading", {
        name: "Can't reach Polaris Locker",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /sign in/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("has no footer: Help and Privacy are the account menu's last links, in the public Help door (PX-35)", async () => {
    mockFetch(signedIn([]));
    renderPortal();
    await userEvent.click(
      await screen.findByRole("button", { name: `Account: ${ACCOUNT.name}` }),
    );
    const links = (await screen.findAllByRole("menuitem")).filter((i) =>
      i.matches("a[href^='/docs/']"),
    );
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Help", "/docs/help/"],
      ["Privacy", "/docs/help/your-data/"],
    ]);
    expect(screen.queryByRole("contentinfo")).toBeNull();
    expect(
      screen.queryByRole("navigation", { name: "Help and policies" }),
    ).toBeNull();
  });

  it("renders the signed-in shell's landmarks, nav and Activate action", async () => {
    mockFetch(
      signedIn([
        license({ product: "nightfall" }),
        license({ product: "ember" }),
      ]),
    );
    renderPortal();
    expect(
      await screen.findByRole("heading", { level: 1, name: "Your library" }),
    ).toBeTruthy();
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByRole("main").id).toBe("content");
    // An in-page fragment, not a hash route: axe recognises a skip link only that way (PX-20).
    expect(
      screen
        .getByRole("link", { name: "Skip to content" })
        .getAttribute("href"),
    ).toBe("#content");
    // No footer (PX-35).
    expect(screen.queryByRole("contentinfo")).toBeNull();
    const nav = screen.getByRole("navigation", { name: "Main" });
    const library = nav.querySelector("a[aria-current=page]");
    expect(library?.textContent).toMatch(/^Library/);
    await waitFor(() => expect(library?.textContent).toBe("Library2"));
    // Discover is hidden from the nav until the Worker can list offers (G24).
    expect(screen.queryByRole("link", { name: /discover/i })).toBeNull();
    // Activate is in the account menu, not the header (the key tile in the grid says the same).
    expect(
      within(screen.getByRole("banner")).queryByRole("button", {
        name: /^Activate/,
      }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: `Account: ${ACCOUNT.name}` }),
    ).toBeTruthy();
    expect(document.title).toBe("Library · Polaris Locker");
    // Never "Polaris Key Portal".
    expect(document.body.textContent).not.toMatch(/portal/i);
  });

  it("follows a legacy link to its new home", async () => {
    window.location.hash = "#/profile";
    mockFetch(signedIn());
    renderPortal();
    expect(
      await screen.findByRole("heading", { level: 1, name: "Account" }),
    ).toBeTruthy();
    expect(window.location.hash).toBe("#/account");
    expect(document.title).toBe("Account · Polaris Locker");
  });

  it("opens the Activate license modal from the account menu", async () => {
    mockFetch(signedIn());
    renderPortal();
    await userEvent.click(
      await screen.findByRole("button", { name: `Account: ${ACCOUNT.name}` }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Activate a license" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Activate a license" }),
    ).toBeTruthy();
  });

  it("drops to the login card when the session ends mid-visit", async () => {
    let signedOut = false;
    mockFetch({
      ...signedIn(),
      "/api/me": () =>
        signedOut ? { status: 401 } : { account: ACCOUNT, csrf: "c" },
      "/api/licenses": () => ({ status: 401 }),
    });
    signedOut = false;
    renderPortal();
    // The licenses read answers 401: the session is cleared and the card takes over.
    signedOut = true;
    expect(
      await screen.findByRole("heading", { level: 1, name: /sign in/i }),
    ).toBeTruthy();
  });
});
