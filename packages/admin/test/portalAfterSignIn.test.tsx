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

const NUDGE = "Add another way to sign in";
const setNudge = (): void =>
  window.localStorage.setItem("pk-signin-nudge", String(Date.now()));

describe("Add another way to sign in", () => {
  it("shows for the account until it is answered, as a region under the page's h1", async () => {
    setNudge();
    mockFetch(signedIn());
    renderPortal();
    const nudge = await screen.findByRole("region", { name: NUDGE });
    expect(
      within(nudge).getByText("So you can always get back in."),
    ).toBeTruthy();
    // Claimed for the account: a new tab (a magic link) or a reload still shows it.
    expect(window.localStorage.getItem("pk-signin-nudge")).toBeNull();
    expect(window.localStorage.getItem("pk-signin-nudge:acct_1")).toBe("1");
    // No heading above the page's h1.
    expect(within(nudge).queryByRole("heading")).toBeNull();
    expect(await axeViolations()).toEqual([]);
    cleanup();
    renderPortal();
    expect(await screen.findByRole("region", { name: NUDGE })).toBeTruthy();
  });

  it("is absent without the Worker's flag, and Not now clears it for good", async () => {
    mockFetch(signedIn());
    renderPortal();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByText(NUDGE)).toBeNull();
    cleanup();
    setNudge();
    renderPortal();
    await userEvent.click(
      await screen.findByRole("button", { name: "Not now" }),
    );
    expect(screen.queryByText(NUDGE)).toBeNull();
    expect(window.localStorage.getItem("pk-signin-nudge:acct_1")).toBeNull();
    cleanup();
    renderPortal();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByText(NUDGE)).toBeNull();
  });

  it("Add a way goes to Sign-in methods and clears it", async () => {
    setNudge();
    mockFetch(signedIn());
    renderPortal();
    await userEvent.click(
      await screen.findByRole("button", { name: "Add a way" }),
    );
    await waitFor(() => expect(window.location.hash).toContain("#/account"));
    expect(screen.queryByText(NUDGE)).toBeNull();
    expect(window.localStorage.getItem("pk-signin-nudge:acct_1")).toBeNull();
  });

  it("is not drawn on Sign-in methods itself, and is cleared there", async () => {
    window.history.replaceState(null, "", "/#/account/methods");
    setNudge();
    mockFetch(signedIn());
    renderPortal();
    await screen.findByRole("heading", { level: 1, name: "Account" });
    expect(screen.queryByText(NUDGE)).toBeNull();
    await waitFor(() =>
      expect(window.localStorage.getItem("pk-signin-nudge:acct_1")).toBeNull(),
    );
  });

  it("drops a flag the sign-in left more than ten minutes ago", async () => {
    window.localStorage.setItem(
      "pk-signin-nudge",
      String(Date.now() - 11 * 60 * 1000),
    );
    mockFetch(signedIn());
    renderPortal();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByText(NUDGE)).toBeNull();
  });
});

function methodsFixture() {
  return {
    methods: [
      {
        id: "em1",
        kind: "email",
        group: "email",
        label: "Email",
        display: ACCOUNT.email,
        connectedAt: NOW_S - 86_400,
        lastUsedAt: null,
        canRemove: false,
        reason: "only_email",
      },
    ],
    emails: [
      {
        methodId: "em1",
        email: ACCOUNT.email,
        primary: true,
        connectedAt: NOW_S - 86_400,
        lastUsedAt: null,
        canRemove: false,
        reason: "only_email",
      },
    ],
    passkeys: [],
    providers: [
      { kind: "apple", connected: false, available: true },
      { kind: "google", connected: false, available: true },
      { kind: "steam", connected: false, available: true },
    ],
    passkey: { canAdd: true, reason: null },
    primaryEmail: ACCOUNT.email,
    hideMyEmail: false,
    stepUp: true,
  };
}

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
    window.history.replaceState(null, "", "/#/account?link=1");
    vi.stubGlobal("location", { ...window.location, assign });
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
    // The login card will show for the second sign-in while this session is still live.
    expect(window.sessionStorage.getItem("pk-link-second")).toBe("csrf-token");
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
    expect(within(dialog).getByText("Signed in now")).toBeTruthy();
    expect(within(dialog).getByText("Your other account")).toBeTruthy();
    expect(within(dialog).getAllByText(/Proven by email/).length).toBe(2);
    expect(
      within(dialog).getByText(
        "One library: 3 products. mara@old.example stays the main email.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(/Every sign-in from both keeps working/),
    ).toBeTruthy();
    expect(await axeViolations()).toEqual([]);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Join into one account" }),
    );
    expect(
      await within(dialog).findByText(/Joined\. You can undo until/),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Undo join" }),
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

describe("Link an existing account: refusals and the way back in", () => {
  it("offers a sign-in again for each stale proof, and Start again", async () => {
    window.history.replaceState(null, "", "/#/account?link=1");
    mockFetch(
      signedIn([], {
        "/api/me/link": {
          flow: flow({
            canJoin: false,
            reason: "step_up_required",
            other: account("other", {
              proven: { by: "email", at: NOW_S - 900, fresh: false },
            }),
          }),
          undoable: [],
        },
      }),
    );
    renderPortal();
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      await within(dialog).findByRole("button", {
        name: "Join into one account",
      }),
    );
    expect(
      await within(dialog).findByRole("button", {
        name: "Sign in to mara@old.example again",
      }),
    ).toBeTruthy();
    expect(
      within(dialog).queryByRole("button", {
        name: `Sign in to ${ACCOUNT.email} again`,
      }),
    ).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Start again" }),
    ).toBeTruthy();
  });

  it("goes back to the start view when the flow expired under the join", async () => {
    window.history.replaceState(null, "", "/#/account?link=1");
    mockFetch(
      signedIn([], {
        "/api/me/link": { flow: flow(), undoable: [] },
        "POST /api/me/link/confirm": {
          status: 400,
          body: { error: "signin_expired", message: "Linking took too long." },
        },
      }),
    );
    renderPortal();
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      await within(dialog).findByRole("button", {
        name: "Join into one account",
      }),
    );
    expect(
      await within(dialog).findByRole("button", {
        name: "Sign in to the other account",
      }),
    ).toBeTruthy();
    expect(within(dialog).getByRole("alert").textContent).toContain(
      "Linking took too long",
    );
  });

  it("says a join can no longer be undone, in its own words", async () => {
    window.history.replaceState(null, "", "/#/account?link=1");
    mockFetch(
      signedIn([], {
        "/api/me/link": {
          flow: null,
          undoable: [
            {
              id: "m1",
              mergedAt: NOW_S - 3600,
              undoUntil: NOW_S + 3600,
              joined: { email: "mara@old.example", name: null },
            },
          ],
        },
        "POST /api/me/link/undo": { status: 404, body: { error: "not_found" } },
      }),
    );
    renderPortal();
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      await within(dialog).findByRole("button", { name: "Undo join" }),
    );
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "This join can no longer be undone.",
    );
  });

  it("shows the login card while still signed in, until the session changes", async () => {
    window.history.replaceState(null, "", "/#/account/link");
    window.sessionStorage.setItem("pk-link-second", "csrf-token");
    mockFetch(
      signedIn([], {
        "/api/me/link": { flow: flow({ other: null }), undoable: [] },
      }),
    );
    renderPortal();
    expect(
      await screen.findByText("Sign in to your other account"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    cleanup();
    // The sign-in replaced the session (a new CSRF token): the dialog, with both accounts.
    window.sessionStorage.setItem("pk-link-second", "the-old-session");
    mockFetch(signedIn([], { "/api/me/link": { flow: flow(), undoable: [] } }));
    renderPortal();
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("button", {
      name: "Join into one account",
    });
    expect(window.sessionStorage.getItem("pk-link-second")).toBeNull();
  });

  it("hides the entry when the Worker has no link route, and shows the 72 hours otherwise", async () => {
    window.history.replaceState(null, "", "/#/account/methods");
    mockFetch(signedIn([], { "/api/me/methods": methodsFixture() }));
    renderPortal();
    await screen.findAllByText(ACCOUNT.email);
    expect(
      screen.queryByRole("button", { name: "Link an existing account" }),
    ).toBeNull();
    cleanup();
    mockFetch(
      signedIn([], {
        "/api/me/methods": methodsFixture(),
        "/api/me/link": {
          flow: null,
          undoable: [
            {
              id: "m1",
              mergedAt: NOW_S,
              undoUntil: NOW_S + 72 * 3600,
              joined: { email: "mara@old.example", name: null },
            },
          ],
        },
      }),
    );
    renderPortal();
    expect(
      await screen.findByText(/Joined mara@old\.example\. Undo until/),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Link an existing account" }),
    ).toBeTruthy();
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
