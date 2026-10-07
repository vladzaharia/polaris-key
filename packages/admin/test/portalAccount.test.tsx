import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ACCOUNT,
  axeViolations,
  fetchedRequests,
  mockFetch,
  renderPortal,
  signedIn,
} from "./portalHarness.js";

beforeEach(() => {
  window.history.replaceState(null, "", "/#/account");
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-motion");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Account v1 (PX-07)", () => {
  it("shows the sign-in email, the sections that exist and Sign out", async () => {
    mockFetch(signedIn());
    renderPortal();
    expect(
      await screen.findByRole("heading", { level: 1, name: "Account" }),
    ).toBeTruthy();
    const methods = screen.getByRole("region", { name: "Sign-in methods" });
    // A Worker without G27's methods list (404): the session's email alone.
    expect(await within(methods).findByText(ACCOUNT.email)).toBeTruthy();
    // Neutral facts are text, never a chip (EXPERIENCE §11.3).
    expect(within(methods).queryByText("Primary")).toBeNull();
    const nav = screen.getByRole("navigation", { name: "On this page" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Profile", "Sign-in methods", "Appearance", "Your data"]);
    const signOut = within(screen.getByRole("main")).getByRole("button", {
      name: "Sign out",
    });
    expect(signOut.closest("form")?.getAttribute("action")).toBe("/logout");
    expect(signOut.closest("form")?.getAttribute("method")).toBe("post");
    expect(await axeViolations()).toEqual([]);
  });

  it("switches the theme and remembers it", async () => {
    mockFetch(signedIn());
    renderPortal();
    const appearance = await screen.findByRole("region", {
      name: "Appearance",
    });
    const theme = within(appearance).getByRole("radiogroup", { name: "Theme" });
    await userEvent.click(within(theme).getByRole("radio", { name: /Light/ }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem("pk-admin-theme")).toBe("light");
    await userEvent.click(
      within(theme).getByRole("radio", { name: /Match my device/ }),
    );
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("turns motion down and back, on <html> and in storage (MO-12)", async () => {
    mockFetch(signedIn());
    renderPortal();
    const appearance = await screen.findByRole("region", {
      name: "Appearance",
    });
    const motion = within(appearance).getByRole("radiogroup", {
      name: "Motion",
    });
    const system = within(motion).getByRole("radio", {
      name: /Match my device/,
    });
    expect(system.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(
      within(motion).getByRole("radio", { name: /Reduced/ }),
    );
    expect(document.documentElement.getAttribute("data-motion")).toBe("reduce");
    expect(window.localStorage.getItem("pk-admin-motion")).toBe("reduce");
    await userEvent.click(system);
    expect(document.documentElement.hasAttribute("data-motion")).toBe(false);
    expect(window.localStorage.getItem("pk-admin-motion")).toBe("system");
    expect(await axeViolations()).toEqual([]);
  });

  it("deletes the account only after the email is typed", async () => {
    let deleted = false;
    mockFetch({
      ...signedIn(),
      "/api/me": () =>
        deleted ? { status: 401 } : { account: ACCOUNT, csrf: "c" },
      "DELETE /api/me": () => {
        deleted = true;
        return { ok: true, deleted: ACCOUNT.id };
      },
    });
    renderPortal();
    const data = await screen.findByRole("region", { name: "Your data" });
    await userEvent.click(
      within(data).getByRole("button", { name: "Delete account" }),
    );
    const heading = within(data).getByRole("heading", {
      name: "Delete your Polaris Key account?",
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    const confirm = within(data).getByRole("button", {
      name: "Delete my account",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await userEvent.type(
      within(data).getByRole("textbox", {
        name: `Type ${ACCOUNT.email} to confirm`,
      }),
      "mara@",
    );
    expect(confirm.disabled).toBe(true);
    await userEvent.type(
      within(data).getByRole("textbox", {
        name: `Type ${ACCOUNT.email} to confirm`,
      }),
      "fennick.studio",
    );
    expect(confirm.disabled).toBe(false);
    await userEvent.click(confirm);
    await waitFor(() => expect(fetchedRequests()).toContain("DELETE /api/me"));
    expect(
      await screen.findByRole("heading", { level: 1, name: /Sign in/ }),
    ).toBeTruthy();
    expect(await screen.findByText("Your account was deleted")).toBeTruthy();
  });

  it("keeps the account with Keep my account", async () => {
    mockFetch(signedIn());
    renderPortal();
    const data = await screen.findByRole("region", { name: "Your data" });
    await userEvent.click(
      within(data).getByRole("button", { name: "Delete account" }),
    );
    await userEvent.click(
      within(data).getByRole("button", { name: "Keep my account" }),
    );
    expect(
      within(data).queryByRole("heading", { name: /Delete your/ }),
    ).toBeNull();
    expect(fetchedRequests()).not.toContain("DELETE /api/me");
  });

  it("opens the account menu's sections from anywhere", async () => {
    window.history.replaceState(null, "", "/");
    mockFetch(signedIn());
    renderPortal();
    await userEvent.click(
      await screen.findByRole("button", { name: `Account: ${ACCOUNT.name}` }),
    );
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      "Account",
      "Sign-in methods",
      "Appearance",
      "Sign out",
    ]);
  });
});
