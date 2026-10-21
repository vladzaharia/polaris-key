import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ACCOUNT,
  DAY,
  NOW_S,
  axeViolations,
  fetchedRequests,
  mockFetch,
  renderPortal,
  signedIn,
  type MockRoute,
} from "./portalHarness.js";
import {
  captureDownloads,
  deferred,
  settle,
  type DownloadCapture,
} from "./portalDataKit.js";

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
    ).toEqual([
      "Profile",
      "Sign-in methods",
      "Packages",
      "Appearance",
      "Your data",
    ]);
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
      within(theme).getByRole("radio", { name: /Match device/ }),
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
      name: /Match device/,
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

  it("schedules deletion only after the email is typed, then lets the holder cancel", async () => {
    let deletion: { requestedAt: number; dueAt: number } | null = null;
    mockFetch({
      ...signedIn(),
      "/api/me": () => ({ account: { ...ACCOUNT, deletion }, csrf: "c" }),
      "DELETE /api/me": () => {
        deletion = { requestedAt: NOW_S, dueAt: NOW_S + 14 * DAY };
        return { ok: true, scheduled: true, deletionDueAt: deletion.dueAt };
      },
      "POST /api/me/deletion/cancel": () => {
        deletion = null;
        return { ok: true };
      },
    });
    renderPortal();
    const data = await screen.findByRole("region", { name: "Your data" });
    await userEvent.click(
      within(data).getByRole("button", { name: "Delete account" }),
    );
    const heading = within(data).getByRole("heading", {
      name: "Schedule your Polaris Locker account for deletion?",
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    const confirm = within(data).getByRole("button", {
      name: "Schedule deletion",
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
      await within(data).findByRole("heading", {
        name: /^Your account will be erased on/,
      }),
    ).toBeTruthy();
    // Focus moves to the scheduled box, which the press unmounted the button for.
    await waitFor(() =>
      expect(document.activeElement?.textContent).toMatch(
        /^Your account will be erased on/,
      ),
    );
    // The shell says so on every page, with the way back.
    expect(
      screen.getAllByText(/Your account will be erased on/).length,
    ).toBeGreaterThan(1);

    await userEvent.click(
      within(data).getByRole("button", { name: "Cancel deletion" }),
    );
    await waitFor(() =>
      expect(fetchedRequests()).toContain("POST /api/me/deletion/cancel"),
    );
    const trigger = await within(data).findByRole("button", {
      name: "Delete account",
    });
    expect(await screen.findByText("Deletion canceled")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("keeps the account with Cancel", async () => {
    mockFetch(signedIn());
    renderPortal();
    const data = await screen.findByRole("region", { name: "Your data" });
    await userEvent.click(
      within(data).getByRole("button", { name: "Delete account" }),
    );
    await userEvent.click(within(data).getByRole("button", { name: "Cancel" }));
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
      "Activate a license",
      "Account",
      "Sign-in methods",
      "Appearance",
      "Help",
      "Privacy",
      "Sign out",
    ]);
  });
});

/** What `GET /api/me/export` answers: the file the person saves (its shape is the Worker's). */
const ACCOUNT_FILE = {
  schema: "pkey-account-export/1",
  exportedAt: NOW_S,
  account: { id: ACCOUNT.id, email: ACCOUNT.email },
};

describe("Your data: Download my data (I-11)", () => {
  let files: DownloadCapture;
  beforeEach(() => {
    files = captureDownloads();
  });
  afterEach(() => {
    files.restore();
    vi.restoreAllMocks();
  });

  /** Account → Your data, the Worker answering `/api/me/export` as `answer`. */
  async function open(answer: MockRoute = ACCOUNT_FILE, me?: unknown) {
    mockFetch({
      ...signedIn(),
      ...(me ? { "/api/me": me } : {}),
      "/api/me/export": answer,
    });
    renderPortal();
    const data = await screen.findByRole("region", { name: "Your data" });
    const button = within(data).getByRole("button", {
      name: "Download my data",
    }) as HTMLButtonElement;
    return { data, button };
  }

  it("offers the account's file, says what it holds, and fetches nothing until pressed", async () => {
    const { data } = await open();
    expect(
      within(data).getByText(
        "Account, sign-in methods, licenses, devices and each app's data. No keys or tokens.",
      ),
    ).toBeTruthy();
    // Beside it, the account's own deletion, as it was.
    expect(
      within(data).getByRole("button", { name: "Delete account" }),
    ).toBeTruthy();
    await settle();
    expect(fetchedRequests().filter((r) => r.includes("export"))).toEqual([]);
    expect(await axeViolations()).toEqual([]);
  });

  it("saves the account's file when pressed: its name, its bytes, the CSRF header, and nothing else asked", async () => {
    const { data, button } = await open();
    await userEvent.click(button);
    await waitFor(() => expect(files.saved).toHaveLength(1));
    expect(files.saved[0]!.filename).toBe("polaris-key-account-data.json");
    expect(JSON.parse(await files.saved[0]!.text())).toEqual(ACCOUNT_FILE);
    // Only the account's route: no product's export, no deletion.
    expect(fetchedRequests().filter((r) => /export|DELETE/.test(r))).toEqual([
      "GET /api/me/export",
    ]);
    const sent = vi
      .mocked(fetch)
      .mock.calls.find(([url]) => String(url) === "/api/me/export")!;
    expect(new Headers(sent[1]?.headers).get("X-PKey-Portal-CSRF")).toBe(
      "csrf-token",
    );
    expect(await screen.findByText("Your download has started")).toBeTruthy();
    expect(
      screen.getByText("It holds personal details, so keep it private."),
    ).toBeTruthy();
    expect(within(data).queryByRole("alert")).toBeNull();
    expect(button.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("starts one request at a time: a second press while it runs does nothing", async () => {
    const answer = deferred<unknown>();
    const { button } = await open(() => answer.promise);
    await userEvent.dblClick(button);
    await waitFor(() =>
      expect(button.getAttribute("aria-disabled")).toBe("true"),
    );
    expect(button.getAttribute("aria-busy")).toBe("true");
    answer.resolve(ACCOUNT_FILE);
    await waitFor(() => expect(files.saved).toHaveLength(1));
    await settle();
    expect(fetchedRequests().filter((r) => r.includes("export"))).toHaveLength(
      1,
    );
    expect(files.saved).toHaveLength(1);
  });

  it("hands focus back to the button once it is pressable again", async () => {
    const answer = deferred<unknown>();
    const { button } = await open(() => answer.promise);
    const focus = vi.spyOn(button, "focus");
    await userEvent.click(button);
    await waitFor(() =>
      expect(button.getAttribute("aria-disabled")).toBe("true"),
    );
    // The click itself focused it. A browser drops focus from a button that becomes disabled
    // (jsdom keeps it there): the page body holds it now.
    focus.mockClear();
    vi.spyOn(document, "activeElement", "get").mockReturnValue(document.body);
    answer.resolve(ACCOUNT_FILE);
    await waitFor(() => expect(focus).toHaveBeenCalled());
    await waitFor(() =>
      expect(button.getAttribute("aria-disabled")).not.toBe("true"),
    );
  });

  it("keeps a refusal beside the button in plain words, and pressing again tries again", async () => {
    let asked = 0;
    const { data, button } = await open(() =>
      ++asked === 1
        ? { status: 429, body: { error: "rate_limited" } }
        : ACCOUNT_FILE,
    );
    await userEvent.click(button);
    expect((await within(data).findByRole("alert")).textContent).toBe(
      "Too many tries. Wait a minute, then try again.",
    );
    expect(files.saved).toHaveLength(0);
    expect(screen.queryByText("Your download has started")).toBeNull();
    expect(button.getAttribute("aria-disabled")).not.toBe("true");

    await userEvent.click(button);
    await waitFor(() => expect(files.saved).toHaveLength(1));
    expect(within(data).queryByRole("alert")).toBeNull();
  });

  it.each([
    [
      "too many tries",
      { status: 429, body: { error: "rate_limited" } },
      "Too many tries. Wait a minute, then try again.",
    ],
    [
      "a dropped connection",
      "network",
      "Can't reach Polaris Locker. Check your connection, then try again.",
    ],
    [
      "an error from the Worker",
      { status: 500, body: { error: "internal" } },
      "Something went wrong. Try again in a few minutes.",
    ],
  ])("says so and saves nothing: %s", async (_case, answer, words) => {
    const { data, button } = await open(answer);
    await userEvent.click(button);
    expect((await within(data).findByRole("alert")).textContent).toBe(words);
    expect(files.saved).toHaveLength(0);
    expect(screen.queryByText("Your download has started")).toBeNull();
    expect(button.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("is still offered while a deletion is scheduled, and leaves that flow alone", async () => {
    const deletion = { requestedAt: NOW_S, dueAt: NOW_S + 14 * DAY };
    const { data, button } = await open(ACCOUNT_FILE, {
      account: { ...ACCOUNT, deletion },
      csrf: "c",
    });
    expect(
      within(data).getByRole("heading", {
        name: /^Your account will be erased on/,
      }),
    ).toBeTruthy();
    await userEvent.click(button);
    await waitFor(() => expect(files.saved).toHaveLength(1));
    expect(
      fetchedRequests().filter(
        (r) => r.startsWith("DELETE") || r.includes("deletion"),
      ),
    ).toEqual([]);
    expect(
      within(data).getByRole("button", { name: "Cancel deletion" }),
    ).toBeTruthy();
  });
});

/** An account whose last sign-in is older than five minutes, with one email to confirm by. */
const STALE_METHODS = {
  methods: [
    {
      id: "lnk_mail1",
      kind: "email",
      group: "email",
      label: "Email",
      display: ACCOUNT.email,
      connectedAt: NOW_S - 90 * DAY,
      lastUsedAt: NOW_S - 3 * DAY,
      canRemove: false,
      reason: "last_link",
      flag: null,
      relay: false,
      tenantScoped: false,
    },
  ],
  emails: [
    {
      methodId: "lnk_mail1",
      email: ACCOUNT.email,
      primary: true,
      connectedAt: NOW_S - 90 * DAY,
      lastUsedAt: NOW_S - 3 * DAY,
      canRemove: false,
      reason: "last_link",
    },
  ],
  passkeys: [],
  providers: [],
  passkey: { canAdd: false, reason: null },
  primaryEmail: ACCOUNT.email,
  hideMyEmail: false,
  stepUp: {
    authenticatedAt: NOW_S - 3600,
    freshUntil: NOW_S - 3300,
    fresh: false,
    maxAgeSeconds: 300,
  },
};

/** The Worker's answer to a change that needs a sign-in from the last five minutes. */
const STEP_UP = { status: 401, body: { error: "step_up_required" } };

/** Confirm it's you with an email code, in the prompt that replaced the refusal. */
async function confirmItsYou(scope: HTMLElement): Promise<void> {
  const prompt = await within(scope).findByRole("group", {
    name: "Confirm it's you first",
  });
  await userEvent.click(
    within(prompt).getByRole("button", {
      name: `Email a code to ${ACCOUNT.email}`,
    }),
  );
  await userEvent.type(
    await within(prompt).findByRole("textbox", { name: "6-digit code" }),
    "481920",
  );
}

describe("Your data: a stale sign-in asks to confirm it's you in place (I-11)", () => {
  let files: DownloadCapture;
  beforeEach(() => {
    files = captureDownloads();
  });
  afterEach(() => {
    files.restore();
    vi.restoreAllMocks();
  });

  const signIn = {
    "/api/me/methods": STALE_METHODS,
    "POST /api/signin/email/start": {
      ok: true,
      expiresIn: 600,
      codeLength: 6,
      resendIn: 60,
    },
    "POST /api/signin/email/verify": { status: "signed_in", next: "/" },
  };

  it("download: shows the prompt where the refusal was, then downloads once confirmed", async () => {
    let asked = 0;
    mockFetch({
      ...signedIn(),
      ...signIn,
      "/api/me/export": () => (++asked === 1 ? STEP_UP : ACCOUNT_FILE),
    });
    renderPortal();
    const data = await screen.findByRole("region", { name: "Your data" });
    await userEvent.click(
      within(data).getByRole("button", { name: "Download my data" }),
    );
    expect(within(data).queryByRole("alert")).toBeNull();
    await confirmItsYou(data);
    await waitFor(() => expect(files.saved).toHaveLength(1));
    expect(asked).toBe(2);
  });

  it("schedule: keeps what was typed, confirms, then schedules", async () => {
    let deletes = 0;
    mockFetch({
      ...signedIn(),
      ...signIn,
      "DELETE /api/me": () => {
        deletes += 1;
        return deletes === 1
          ? STEP_UP
          : { ok: true, scheduled: true, deletionDueAt: NOW_S + 14 * DAY };
      },
    });
    renderPortal();
    const data = await screen.findByRole("region", { name: "Your data" });
    await userEvent.click(
      within(data).getByRole("button", { name: "Delete account" }),
    );
    const field = within(data).getByRole("textbox", {
      name: `Type ${ACCOUNT.email} to confirm`,
    }) as HTMLInputElement;
    await userEvent.type(field, ACCOUNT.email);
    await userEvent.click(
      within(data).getByRole("button", { name: "Schedule deletion" }),
    );
    expect(within(data).queryByRole("alert")).toBeNull();
    await confirmItsYou(data);
    await waitFor(() => expect(deletes).toBe(2));
    expect(field.value).toBe(ACCOUNT.email);
  });

  it("cancel: confirms, then cancels the deletion", async () => {
    let cancels = 0;
    const deletion = { requestedAt: NOW_S, dueAt: NOW_S + 14 * DAY };
    mockFetch({
      ...signedIn(),
      ...signIn,
      "/api/me": { account: { ...ACCOUNT, deletion }, csrf: "c" },
      "POST /api/me/deletion/cancel": () => {
        cancels += 1;
        return cancels === 1 ? STEP_UP : { ok: true };
      },
    });
    renderPortal();
    const data = await screen.findByRole("region", { name: "Your data" });
    await userEvent.click(
      await within(data).findByRole("button", { name: "Cancel deletion" }),
    );
    await confirmItsYou(data);
    await waitFor(() => expect(cancels).toBe(2));
  });
});
