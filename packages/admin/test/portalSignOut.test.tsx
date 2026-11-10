import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EndSessionView } from "@polaris-key/protocol/identity";
import { consumeQuietSignOut } from "../src/portal/data.js";
import { navigation } from "../src/portal/model/signInRequest.js";
import {
  ACCOUNT,
  axeViolations,
  fetchedRequests,
  mockFetch,
  renderPortal,
  signedIn,
} from "./portalHarness.js";

/**
 * Polaris Locker's sign-out page (I-21.12; V5 §12.13.9): "Sign out of Polaris Locker too?" with
 * **Sign out** and **Stay signed in**, the person it ends, a browser with no session (which returns
 * at once when the request has a return), the variants with no return, the expired step for a
 * handle that is spent or gone, and a stale CSRF token.
 */
const HANDLE = "eo_BBBBBBBBBBBBBBBBBBBBBB";
const REQUEST = `/api/signout/requests/${HANDLE}`;

const VIEW: EndSessionView = {
  request: HANDLE,
  product: { slug: "forum", appName: "Forum App", iconUrl: null },
  client: {
    name: "Community",
    developerName: "Partner Ltd",
    iconUrl: null,
    nameVerified: true,
  },
  returns: true,
  returnHost: "community.example.com",
  signedIn: true,
  expiresAt: 0,
};

const went: string[] = [];
beforeEach(() => {
  window.history.replaceState(null, "", `/signout?request=${HANDLE}`);
  vi.spyOn(navigation, "go").mockImplementation((to) => void went.push(to));
});
afterEach(() => {
  went.length = 0;
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

async function press(name: string): Promise<void> {
  await userEvent.setup().click(await screen.findByRole("button", { name }));
}

/** The page's h1, once it shows. */
async function heading(name: string): Promise<HTMLElement> {
  return screen.findByRole("heading", { level: 1, name });
}

function open(view: EndSessionView = VIEW, signedOut = false) {
  mockFetch({
    ...(signedOut ? { "/api/me": { status: 401 } } : signedIn()),
    [REQUEST]: view,
    [`POST ${REQUEST}/confirm`]: {
      redirect: "https://community.example.com/bye?state=s1",
    },
    [`POST ${REQUEST}/cancel`]: {
      redirect: "https://community.example.com/bye?state=s1",
    },
  });
  renderPortal();
}

describe("the sign-out page", () => {
  it("asks, shows the account, names the client and where it returns, and offers the two answers", async () => {
    open();
    expect(await heading("Sign out of Polaris Locker too?")).toBeTruthy();
    // The header is the sign-in card's: the client signed the person out; the developer; the return.
    expect(screen.getByText("Community")).toBeTruthy();
    expect(document.body.textContent).toContain("Community signed you out");
    expect(screen.getByText("Partner Ltd")).toBeTruthy();
    expect(
      screen.getByText("Returns you to community.example.com"),
    ).toBeTruthy();
    // Whose session ends, and what staying signed in means; no "Not you?" (Sign out is the change).
    expect(screen.getByText("Mara Fennick")).toBeTruthy();
    expect(screen.getByText("mara@fennick.studio")).toBeTruthy();
    expect(screen.queryByText("Not you?")).toBeNull();
    expect(
      screen.getByText(
        "Polaris Locker can still sign you in to apps in this browser.",
      ),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Your license, downloads/);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stay signed in" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Polaris Key/);
    expect(await axeViolations()).toEqual([]);
  });

  it("Sign out posts the answer and goes to the registered return with its state", async () => {
    open();
    await press("Sign out");
    await vi.waitFor(() =>
      expect(went).toEqual(["https://community.example.com/bye?state=s1"]),
    );
    expect(fetchedRequests()).toContain(`POST ${REQUEST}/confirm`);
    expect(fetchedRequests()).not.toContain(`POST ${REQUEST}/cancel`);
  });

  it("Stay signed in ends nothing and goes back the same way", async () => {
    open();
    await press("Stay signed in");
    await vi.waitFor(() => expect(went).toHaveLength(1));
    expect(fetchedRequests()).toContain(`POST ${REQUEST}/cancel`);
    expect(fetchedRequests()).not.toContain(`POST ${REQUEST}/confirm`);
  });

  it("with no client the question has no 'too', and with no return Sign out says so and offers sign-in again", async () => {
    open({ ...VIEW, client: null, returns: false, returnHost: null });
    expect(await heading("Sign out of Polaris Locker?")).toBeTruthy();
    // No client: the header names the product alone, and does not claim it signed anyone out.
    expect(screen.getByText("Forum App")).toBeTruthy();
    expect(document.body.textContent).not.toContain("signed you out");
    mockFetch({
      ...signedIn(),
      [REQUEST]: { ...VIEW, client: null, returns: false, returnHost: null },
      [`POST ${REQUEST}/confirm`]: { redirect: null },
    });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Sign out" }));
    expect(await heading("You're signed out of Polaris Locker")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in again" })).toBeTruthy();
    expect(went).toEqual([]);
  });

  it("Stay signed in with no return says you are still signed in, once", async () => {
    mockFetch({
      ...signedIn(),
      [REQUEST]: { ...VIEW, returns: false, returnHost: null },
      [`POST ${REQUEST}/cancel`]: { redirect: null },
    });
    renderPortal();
    await press("Stay signed in");
    expect(
      await heading("You're still signed in to Polaris Locker"),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("Nothing changed");
    expect(
      screen.getByRole("link", { name: "Open Polaris Locker" }),
    ).toBeTruthy();
  });

  it("with no session here and a registered return it returns at once, without asking", async () => {
    open({ ...VIEW, signedIn: false }, true);
    await vi.waitFor(() => expect(went).toHaveLength(1));
    expect(fetchedRequests()).toContain(`POST ${REQUEST}/cancel`);
    expect(fetchedRequests()).not.toContain(`POST ${REQUEST}/confirm`);
    // Until the browser leaves, the page says where it is going and offers nothing to press.
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Returning you to Community",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("with no session and no return it says so, with a way into Polaris Locker", async () => {
    open({ ...VIEW, signedIn: false, returns: false, returnHost: null }, true);
    expect(
      await heading("You're not signed in to Polaris Locker"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(
      screen.getByRole("link", { name: "Open Polaris Locker" }),
    ).toBeTruthy();
    expect(fetchedRequests().some((r) => r.includes("/cancel"))).toBe(false);
  });

  it("if the automatic return fails, the page keeps the button and says why", async () => {
    mockFetch({
      "/api/me": { status: 401 },
      [REQUEST]: { ...VIEW, signedIn: false },
      [`POST ${REQUEST}/cancel`]: { status: 500, body: { error: "boom" } },
    });
    renderPortal();
    const alert = await screen.findByRole("alert");
    // The line matches its only button: no "Try again." beside "Back to Community".
    expect(alert.textContent).toContain("Couldn't return you to Community.");
    expect(alert.textContent).not.toMatch(/try again/i);
    expect(
      screen.getByRole("button", { name: "Back to Community" }),
    ).toBeTruthy();
    expect(went).toEqual([]);
  });

  it("a return the page will not follow says so in sign-out words", async () => {
    mockFetch({
      ...signedIn(),
      [REQUEST]: VIEW,
      [`POST ${REQUEST}/confirm`]: { redirect: "javascript:alert(1)" },
    });
    renderPortal();
    await press("Sign out");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't return you to Community.");
    expect(document.body.textContent).not.toMatch(/start signing in again/i);
  });

  it("a request that is gone is the expired step: never sign-in words, and whether you are still signed in", async () => {
    mockFetch({
      ...signedIn(),
      [REQUEST]: { status: 404, body: { error: "not_found" } },
    });
    renderPortal();
    expect(await heading("This page has expired")).toBeTruthy();
    expect(
      screen.getByText("You're still signed in to Polaris Locker."),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(
      /sign-in has ended|sign in again|library/i,
    );
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Sign out of Polaris Locker" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open Polaris Locker" }),
    ).toBeTruthy();
    expect(await axeViolations()).toEqual([]);
  });

  it("the expired step's Sign out ends the session and moves to the signed-out step, with focus on its heading", async () => {
    let live = true;
    mockFetch({
      ...signedIn(),
      "/api/me": () =>
        live
          ? { account: ACCOUNT, csrf: "csrf-token" }
          : { status: 401, body: { error: "unauthorized" } },
      "POST /logout": () => {
        live = false;
        return { status: 204 };
      },
      [REQUEST]: { status: 404, body: { error: "not_found" } },
    });
    renderPortal();
    await userEvent.setup().click(
      await screen.findByRole("button", {
        name: "Sign out of Polaris Locker",
      }),
    );
    const h1 = await heading("You're signed out of Polaris Locker");
    expect(fetchedRequests()).toContain("POST /logout");
    await waitFor(() => expect(document.activeElement).toBe(h1));
    expect(screen.queryByText("This page has expired")).toBeNull();
    expect(screen.getByRole("link", { name: "Sign in again" })).toBeTruthy();
  });

  it("a failed Sign out on the expired step shows the callout and keeps the button", async () => {
    mockFetch({
      ...signedIn(),
      "POST /logout": { status: 500, body: { error: "boom" } },
      [REQUEST]: { status: 404, body: { error: "not_found" } },
    });
    renderPortal();
    await press("Sign out of Polaris Locker");
    const alert = await screen.findByRole("alert");
    expect(alert.querySelector("svg")).not.toBeNull();
    expect(screen.getByText("This page has expired")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Sign out of Polaris Locker" }),
    ).toBeTruthy();
    expect(consumeQuietSignOut()).toBe(false);
  });

  it("the expired step has no passport: no where-line, from a load or from an answer", async () => {
    mockFetch({
      ...signedIn(),
      [REQUEST]: VIEW,
      [`POST ${REQUEST}/confirm`]: {
        status: 404,
        body: { error: "not_found" },
      },
    });
    renderPortal();
    expect(
      await screen.findByText("Returns you to community.example.com"),
    ).toBeTruthy();
    await press("Sign out");
    expect(await heading("This page has expired")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Returns you to/);
    expect(document.body.textContent).not.toMatch(/signed you out/);
  });

  it("a request that is gone with no session offers to open Polaris Locker", async () => {
    mockFetch({
      "/api/me": { status: 401 },
      [REQUEST]: { status: 404, body: { error: "not_found" } },
    });
    renderPortal();
    expect(
      await screen.findByText("You're not signed in to Polaris Locker."),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Open Polaris Locker" }),
    ).toBeTruthy();
  });

  it("an answer that finds the request spent lands on the expired step, not a line under live buttons", async () => {
    mockFetch({
      ...signedIn(),
      [REQUEST]: VIEW,
      [`POST ${REQUEST}/confirm`]: {
        status: 404,
        body: { error: "not_found" },
      },
    });
    renderPortal();
    await press("Sign out");
    expect(await heading("This page has expired")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stay signed in" })).toBeNull();
    expect(went).toEqual([]);
    // Nothing ended: the next genuine sign-out still earns its toast.
    expect(consumeQuietSignOut()).toBe(false);
  });

  it("a failed answer shows the card's callout and keeps the buttons", async () => {
    mockFetch({
      ...signedIn(),
      [REQUEST]: VIEW,
      [`POST ${REQUEST}/confirm`]: { status: 500, body: { error: "boom" } },
    });
    renderPortal();
    await press("Sign out");
    const alert = await screen.findByRole("alert");
    expect(alert.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Stay signed in" })).toBeTruthy();
    expect(went).toEqual([]);
    expect(consumeQuietSignOut()).toBe(false);
  });

  it("a stale CSRF token is refreshed and the answer is tried once more", async () => {
    let tries = 0;
    let token = "stale";
    mockFetch({
      ...signedIn(),
      "/api/me": () => {
        token = "fresh";
        return { account: ACCOUNT, csrf: token };
      },
      [REQUEST]: VIEW,
      [`POST ${REQUEST}/confirm`]: () => {
        tries++;
        return tries === 1
          ? { status: 403, body: { error: "forbidden", message: "csrf" } }
          : { redirect: "https://community.example.com/bye?state=s1" };
      },
    });
    renderPortal();
    await press("Sign out");
    await vi.waitFor(() =>
      expect(went).toEqual(["https://community.example.com/bye?state=s1"]),
    );
    expect(tries).toBe(2);
    expect(token).toBe("fresh");
  });

  it("a CSRF refusal that persists lands on the expired step", async () => {
    mockFetch({
      ...signedIn(),
      [REQUEST]: VIEW,
      [`POST ${REQUEST}/confirm`]: {
        status: 403,
        body: { error: "forbidden", message: "csrf" },
      },
    });
    renderPortal();
    await press("Sign out");
    expect(await heading("This page has expired")).toBeTruthy();
    expect(went).toEqual([]);
  });

  it("while the request loads the card has the passport's header and an h1", async () => {
    mockFetch({ ...signedIn(), [REQUEST]: () => new Promise(() => undefined) });
    renderPortal();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-header="loading"]')).not.toBeNull(),
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Opening Polaris Locker" }),
    ).toBeTruthy();
  });

  it("a request that cannot be reached says Try again once", async () => {
    mockFetch({ ...signedIn(), [REQUEST]: { status: 500, body: {} } });
    renderPortal();
    expect(
      await screen.findByRole("button", { name: "Try again" }),
    ).toBeTruthy();
    expect(screen.getAllByText(/try again/i)).toHaveLength(1);
  });

  it("never navigates to a javascript: return", async () => {
    mockFetch({
      ...signedIn(),
      [REQUEST]: VIEW,
      [`POST ${REQUEST}/cancel`]: { redirect: "javascript:alert(1)" },
    });
    renderPortal();
    await press("Stay signed in");
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(went).toEqual([]);
  });
});
