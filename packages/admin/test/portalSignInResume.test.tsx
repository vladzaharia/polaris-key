import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ACCOUNT,
  axeViolations,
  CAPS_ALL,
  fetchedRequests,
  mockFetch,
  renderPortal,
  signedIn,
} from "./portalHarness.js";

// PX-12 (SIGN-IN.md §3.13, §4.12 frame 15): the Worker's expired-link page sends a new code with a
// plain form POST and lands on `?signin=code`; the card reads GET /api/signin/flow and shows the
// code step with the masked address and the Worker's resendIn.

beforeEach(() => {
  window.history.replaceState(null, "", "/?signin=code");
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

const FLOW = {
  email: "m•••@fennick.studio",
  expiresIn: 600,
  codeLength: 6,
  resendIn: 45,
};

function resumed(extra: Record<string, unknown> = {}): void {
  mockFetch({
    ...signedIn(),
    "/api/me": { status: 401 },
    "/api/capabilities": CAPS_ALL,
    "GET /api/signin/flow": FLOW,
    ...extra,
  });
}

describe("the code step after the expired-link page (PX-12)", () => {
  it("reads the flow and lands on the code step with the masked address and the countdown", async () => {
    resumed();
    renderPortal();
    const h1 = await screen.findByRole("heading", {
      level: 1,
      name: "Check your email",
    });
    // SIGN-IN.md §3.14 exception: the code field takes focus (the next action is typing; the OS
    // one-time-code suggestion needs it) and the h1 names the step as its description.
    const code = screen.getByRole("textbox", { name: "6-digit code" });
    await waitFor(() => expect(document.activeElement).toBe(code));
    expect(code.getAttribute("autocomplete")).toBe("one-time-code");
    expect(code.getAttribute("aria-describedby")).toContain(h1.id);
    expect(document.body.textContent).toContain("m•••@fennick.studio");
    expect(screen.getByText(/^Send a new code in 0:(45|44|43)$/)).toBeTruthy();
    expect(fetchedRequests()).toContain("GET /api/signin/flow");
    // The marker leaves the URL, so no later return URL carries it.
    expect(window.location.search).toBe("");
    expect(await axeViolations()).toEqual([]);
  });

  it("keeps the rest of the page's URL (the request handle) and starts nothing", async () => {
    window.history.replaceState(
      null,
      "",
      "/signin?request=rq_0123456789abcdef&signin=code#/",
    );
    resumed({
      "/api/signin/requests/rq_0123456789abcdef": {
        status: 404,
        body: { error: "not_found" },
      },
    });
    renderPortal();
    await waitFor(() =>
      expect(fetchedRequests()).toContain("GET /api/signin/flow"),
    );
    expect(window.location.search).toBe("?request=rq_0123456789abcdef");
    expect(
      fetchedRequests().filter((r) => r.startsWith("POST /api/signin/email")),
    ).toEqual([]);
  });

  it("Use a different email opens an empty email field, never the mask", async () => {
    resumed();
    renderPortal();
    await screen.findByRole("heading", { level: 1, name: "Check your email" });
    await userEvent.click(
      screen.getByRole("button", { name: "Use a different email" }),
    );
    const field = (await screen.findByRole("textbox", {
      name: "Email",
    })) as HTMLInputElement;
    expect(field.value).toBe("");
  });

  it("without a live flow goes to the email step and says why", async () => {
    resumed({
      "GET /api/signin/flow": {
        status: 400,
        body: { error: "signin_expired", message: "expired" },
      },
    });
    renderPortal();
    await screen.findByRole("heading", {
      level: 1,
      name: "Sign in to Polaris Locker",
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "That sign-in has expired. Continue to get a new code.",
    );
    expect(
      (screen.getByRole("textbox", { name: "Email" }) as HTMLInputElement)
        .value,
    ).toBe("");
  });

  it("does nothing special for a signed-in visit", async () => {
    mockFetch({
      ...signedIn(),
      "/api/me": { account: ACCOUNT, csrf: "c" },
      "/api/capabilities": CAPS_ALL,
    });
    window.history.replaceState(null, "", "/");
    renderPortal();
    await waitFor(() => expect(fetchedRequests()).toContain("GET /api/me"));
    expect(fetchedRequests()).not.toContain("GET /api/signin/flow");
  });
});
