import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EndSessionView } from "@polaris-key/protocol/identity";
import { navigation } from "../src/portal/model/signInRequest.js";
import {
  axeViolations,
  fetchedRequests,
  mockFetch,
  renderPortal,
  signedIn,
} from "./portalHarness.js";

/**
 * Polaris Locker's sign-out page (I-21.12; V5 §12.13.9): "Sign out of Polaris Locker too?" with
 * **Sign out** and **Stay signed in**, the variant for a browser with no session, the variants with
 * no return, and a handle that is gone.
 */
const HANDLE = "eo_BBBBBBBBBBBBBBBBBBBBBB";
const REQUEST = `/api/signout/requests/${HANDLE}`;

const VIEW: EndSessionView = {
  request: HANDLE,
  product: { appName: "Forum App", iconUrl: null },
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
  went.length = 0;
  window.history.replaceState(null, "", `/signout?request=${HANDLE}`);
  vi.spyOn(navigation, "go").mockImplementation((to) => void went.push(to));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
  cleanup();
});

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
  it("asks, names the client and where it returns, and offers the two answers", async () => {
    open();
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Sign out of Polaris Locker too?",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Community")).toBeTruthy();
    expect(
      screen.getByText("Returns you to community.example.com"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stay signed in" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Polaris Key/);
    expect(await axeViolations()).toEqual([]);
  });

  it("Sign out posts the answer and goes to the registered return with its state", async () => {
    open();
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Sign out" }));
    await vi.waitFor(() =>
      expect(went).toEqual(["https://community.example.com/bye?state=s1"]),
    );
    expect(fetchedRequests()).toContain(`POST ${REQUEST}/confirm`);
    expect(fetchedRequests()).not.toContain(`POST ${REQUEST}/cancel`);
  });

  it("Stay signed in ends nothing and goes back the same way", async () => {
    open();
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Stay signed in" }));
    await vi.waitFor(() => expect(went).toHaveLength(1));
    expect(fetchedRequests()).toContain(`POST ${REQUEST}/cancel`);
    expect(fetchedRequests()).not.toContain(`POST ${REQUEST}/confirm`);
  });

  it("with no return, Sign out says so and offers sign-in again", async () => {
    open({ ...VIEW, client: null, returns: false, returnHost: null });
    expect(
      await screen.findByText(
        "This ends your Polaris Locker session on this device.",
      ),
    ).toBeTruthy();
    // No client: the header names the product.
    expect(screen.getByText("Forum App")).toBeTruthy();
    mockFetch({
      ...signedIn(),
      [REQUEST]: { ...VIEW, client: null, returns: false, returnHost: null },
      [`POST ${REQUEST}/confirm`]: { redirect: null },
    });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Sign out" }));
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "You're signed out",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in again" })).toBeTruthy();
    expect(went).toEqual([]);
  });

  it("with no session here it says so, without asking, and returns on request", async () => {
    open({ ...VIEW, signedIn: false }, true);
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "You're not signed in",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Back to Community" }));
    await vi.waitFor(() => expect(went).toHaveLength(1));
    expect(fetchedRequests()).toContain(`POST ${REQUEST}/cancel`);
  });

  it("a request that is gone is the gone card, with no way to sign out", async () => {
    mockFetch({
      ...signedIn(),
      [REQUEST]: { status: 404, body: { error: "not_found" } },
    });
    renderPortal();
    expect(await screen.findByRole("heading", { level: 1 })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("a refused answer shows the card's own words and goes nowhere", async () => {
    mockFetch({
      ...signedIn(),
      [REQUEST]: VIEW,
      [`POST ${REQUEST}/confirm`]: {
        status: 404,
        body: { error: "not_found" },
      },
    });
    renderPortal();
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(went).toEqual([]);
  });

  it("never navigates to a javascript: return", async () => {
    mockFetch({
      ...signedIn(),
      [REQUEST]: VIEW,
      [`POST ${REQUEST}/cancel`]: { redirect: "javascript:alert(1)" },
    });
    renderPortal();
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Stay signed in" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(went).toEqual([]);
  });
});
