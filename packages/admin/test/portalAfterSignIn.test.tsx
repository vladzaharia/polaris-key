import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ACCOUNT,
  NOW_S,
  axeViolations,
  fetchedRequests,
  mockFetch,
  renderPortal,
  signedIn,
} from "./portalHarness.js";

/**
 * After sign-in (PX-15): the Add another way nudge, Link an existing account, Approve a new
 * device. The Worker's side is PX-W12 (`/api/me/link`) and PX-W14 (`/api/device-login`).
 */

beforeEach(() => {
  window.history.replaceState(null, "", "/#/");
  window.sessionStorage.clear();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Add another way to sign in", () => {
  it("shows once on the next portal page, then never again", async () => {
    window.sessionStorage.setItem("pk-signin-nudge", "1");
    mockFetch(signedIn());
    renderPortal();
    const nudge = await screen.findByRole("region", {
      name: "Add another way to sign in",
    });
    expect(
      within(nudge).getByText("So you can always get back in."),
    ).toBeTruthy();
    expect(window.sessionStorage.getItem("pk-signin-nudge")).toBeNull();
    expect(await axeViolations()).toEqual([]);
    cleanup();
    renderPortal();
    await screen.findByRole("heading", { level: 1 });
    expect(
      screen.queryByRole("region", { name: "Add another way to sign in" }),
    ).toBeNull();
  });

  it("is absent without the Worker's flag, and Not now dismisses it", async () => {
    mockFetch(signedIn());
    renderPortal();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByText("Add another way to sign in")).toBeNull();
    cleanup();
    window.sessionStorage.setItem("pk-signin-nudge", "1");
    renderPortal();
    await userEvent.click(
      await screen.findByRole("button", { name: "Not now" }),
    );
    expect(screen.queryByText("Add another way to sign in")).toBeNull();
  });

  it("Add a way goes to Sign-in methods", async () => {
    window.sessionStorage.setItem("pk-signin-nudge", "1");
    mockFetch(signedIn());
    renderPortal();
    await userEvent.click(
      await screen.findByRole("button", { name: "Add a way" }),
    );
    await waitFor(() => expect(window.location.hash).toContain("#/account"));
    expect(screen.queryByText("Add another way to sign in")).toBeNull();
  });

  it("is not drawn on Sign-in methods itself, but is still taken", async () => {
    window.history.replaceState(null, "", "/#/account/methods");
    window.sessionStorage.setItem("pk-signin-nudge", "1");
    mockFetch(signedIn());
    renderPortal();
    await screen.findByRole("heading", { level: 1, name: "Account" });
    expect(screen.queryByText("Add another way to sign in")).toBeNull();
    expect(window.sessionStorage.getItem("pk-signin-nudge")).toBeNull();
  });
});

function account(role: "started" | "other", over = {}) {
  return {
    role,
    current: role === "other",
    name: role === "started" ? ACCOUNT.name : "Mara F.",
    email: role === "started" ? ACCOUNT.email : "mara@old.example",
    avatarUrl: null,
    methods: ["email"],
    products: role === "started" ? 1 : 2,
    proven: { by: "email", at: NOW_S, fresh: true },
    ...over,
  };
}

function flow(over = {}) {
  return {
    expiresAt: NOW_S + 900,
    started: account("started"),
    other: account("other"),
    canJoin: true,
    reason: null,
    keep: "other",
    result: { products: 3, primaryEmail: "mara@old.example" },
    ...over,
  };
}

describe("Link an existing account", () => {
  it("opens from Sign-in methods and starts the second sign-in", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    window.history.replaceState(null, "", "/#/account");
    mockFetch(
      signedIn([], {
        "/api/me/link": { flow: null, undoable: [] },
        "POST /api/me/link/start": {
          status: "started",
          expiresAt: NOW_S + 900,
          next: "/signin?return_to=%2F%23%2Faccount%2Flink",
        },
      }),
    );
    renderPortal();
    // A Worker without the methods list still reaches the link through the router.
    window.location.hash = "#/account/link";
    const dialog = await screen.findByRole("dialog", {
      name: "Link an existing account",
    });
    expect(await axeViolations()).toEqual([]);
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Sign in to the other account",
      }),
    );
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        "/signin?return_to=%2F%23%2Faccount%2Flink",
      ),
    );
  });

  it("joins only with proof of both: no Join before the second sign-in", async () => {
    window.history.replaceState(null, "", "/#/account?link=1");
    mockFetch(
      signedIn([], {
        "/api/me/link": {
          flow: flow({ other: null, canJoin: false, reason: "sign_in_other" }),
          undoable: [],
        },
      }),
    );
    renderPortal();
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(ACCOUNT.email);
    expect(
      within(dialog).queryByRole("button", { name: "Join into one account" }),
    ).toBeNull();
    expect(
      within(dialog).getByRole("button", {
        name: "Sign in to the other account",
      }),
    ).toBeTruthy();
    expect(fetchedRequests().some((r) => r.includes("/link/confirm"))).toBe(
      false,
    );
  });

  it("shows both accounts and joins on confirm, then offers the 72 hours", async () => {
    window.history.replaceState(null, "", "/#/account?link=1");
    mockFetch(
      signedIn([], {
        "/api/me/link": { flow: flow(), undoable: [] },
        "POST /api/me/link/confirm": {
          status: "joined",
          kept: "other",
          merge: { id: "m1", undoUntil: NOW_S + 72 * 3600 },
        },
      }),
    );
    renderPortal();
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("mara@old.example");
    expect(within(dialog).getByText("This account")).toBeTruthy();
    expect(within(dialog).getByText("Other account")).toBeTruthy();
    expect(
      within(dialog).getByText(
        "One account: mara@old.example, with 3 products.",
      ),
    ).toBeTruthy();
    expect(await axeViolations()).toEqual([]);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Join into one account" }),
    );
    expect(
      await within(dialog).findByText(
        "Joined. You can undo this for 72 hours.",
      ),
    ).toBeTruthy();
    expect(fetchedRequests()).toContain("POST /api/me/link/confirm");
  });

  it("answers a refused join at the button, enabled, without calling the Worker", async () => {
    window.history.replaceState(null, "", "/#/account?link=1");
    mockFetch(
      signedIn([], {
        "/api/me/link": {
          flow: flow({ canJoin: false, reason: "merge_pending" }),
          undoable: [],
        },
      }),
    );
    renderPortal();
    const dialog = await screen.findByRole("dialog");
    const join = await within(dialog).findByRole("button", {
      name: "Join into one account",
    });
    expect((join as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(join);
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "joined in the last 72 hours",
    );
    expect(fetchedRequests().some((r) => r.includes("/link/confirm"))).toBe(
      false,
    );
  });

  it("lists a join that can still be undone", async () => {
    window.history.replaceState(null, "", "/#/account?link=1");
    mockFetch(
      signedIn([], {
        "/api/me/link": {
          flow: null,
          undoable: [
            {
              id: "m1",
              mergedAt: NOW_S - 3600,
              undoUntil: NOW_S + 71 * 3600,
              joined: { email: "mara@old.example", name: null },
            },
          ],
        },
        "POST /api/me/link/undo": { status: "undone" },
      }),
    );
    renderPortal();
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      await within(dialog).findByRole("button", { name: "Undo join" }),
    );
    expect(await within(dialog).findByText("Join undone.")).toBeTruthy();
  });
});

describe("Approve a new device", () => {
  const request = {
    code: "ABCD-EFGH",
    device: { label: "Living-room TV", browser: null, os: "Android TV" },
    location: {
      city: "Oslo",
      region: null,
      country: "NO",
      label: "Oslo, Norway",
    },
    requestedAt: NOW_S - 30,
    expiresIn: 600,
    approverCountry: "NO",
    newLocation: false,
    stepUpRequired: false,
  };

  it("shows the device and place, and never approves by itself", async () => {
    window.history.replaceState(null, "", "/#/account/approve?code=ABCD-EFGH");
    mockFetch(
      signedIn([], {
        "POST /api/device-login/lookup": { request },
        "POST /api/device-login/approve": { ok: true, status: "approved" },
      }),
    );
    renderPortal();
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Living-room TV")).toBeTruthy();
    expect(within(dialog).getByText("Oslo, Norway")).toBeTruthy();
    // Looking is not approving: nothing was decided, and the safe choice has focus.
    expect(fetchedRequests()).not.toContain("POST /api/device-login/approve");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole("button", { name: "Deny" }),
      ),
    );
    expect(await axeViolations()).toEqual([]);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Approve and sign it in" }),
    );
    await waitFor(() =>
      expect(fetchedRequests()).toContain("POST /api/device-login/approve"),
    );
  });

  it("answers a short code at the field with the button still pressable", async () => {
    window.history.replaceState(null, "", "/#/account/approve");
    mockFetch(signedIn());
    renderPortal();
    const dialog = await screen.findByRole("dialog");
    const find = within(dialog).getByRole("button", { name: "Find it" });
    expect((find as HTMLButtonElement).disabled).toBe(false);
    await userEvent.type(within(dialog).getByLabelText("Code"), "ABC");
    await userEvent.click(find);
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "Enter all 8 letters of the code.",
    );
    expect(fetchedRequests()).not.toContain("POST /api/device-login/lookup");
  });
});
