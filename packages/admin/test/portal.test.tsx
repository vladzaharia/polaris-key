import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
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

  it("tells 'can't reach Polaris Key' apart from signed out", async () => {
    mockFetch({ "/api/me": "network", "/api/capabilities": "network" });
    renderPortal();
    expect(
      await screen.findByRole("heading", { name: "Can't reach Polaris Key" }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /sign in/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
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
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByRole("contentinfo").textContent).toContain(
      "Polaris Key · key.plrs.im",
    );
    const nav = screen.getByRole("navigation", { name: "Main" });
    const library = nav.querySelector("a[aria-current=page]");
    expect(library?.textContent).toMatch(/^Library/);
    await waitFor(() => expect(library?.textContent).toBe("Library2"));
    // Discover is hidden from the nav until the Worker can list offers (G24).
    expect(screen.queryByRole("link", { name: /discover/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Activate license" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: `Account: ${ACCOUNT.name}` }),
    ).toBeTruthy();
    expect(document.title).toBe("Library · Polaris Key");
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
    expect(document.title).toBe("Account · Polaris Key");
  });

  it("opens the Activate license modal from the header", async () => {
    mockFetch(signedIn());
    renderPortal();
    await userEvent.click(
      await screen.findByRole("button", { name: "Activate license" }),
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
