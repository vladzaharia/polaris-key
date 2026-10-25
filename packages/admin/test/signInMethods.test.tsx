import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConsoleMethod } from "../src/api.js";
import { setStepUpRedirectForTests } from "../src/lib/stepUp.js";
import { PasskeyError } from "../src/lib/webauthn.js";
import { PENDING, boot, resetConsole } from "./consoleHarness.js";

/** The operator's own Sign-in methods (`#/account/sign-in-methods`, ST-30c.4). */

const created = vi.hoisted(() => ({ fn: vi.fn(), supported: { on: true } }));
vi.mock("../src/lib/webauthn.js", async (orig) => ({
  ...(await orig<typeof import("../src/lib/webauthn.js")>()),
  passkeysSupported: () => created.supported.on,
  createPasskey: created.fn,
}));

const HASH = "#/account/sign-in-methods";
const IDP: ConsoleMethod = {
  id: "lnk_oidc",
  kind: "oidc",
  name: null,
  createdAt: 1_750_000_000,
  lastUsedAt: 1_750_100_000,
  strong: true,
  consoleEligible: false,
  aaguid: null,
  addedFrom: null,
};
const LOCKER_PASSKEY: ConsoleMethod = {
  id: "lnk_pk",
  kind: "passkey",
  name: null,
  createdAt: 1_750_000_000,
  lastUsedAt: null,
  strong: false,
  consoleEligible: true,
  // iCloud Keychain, by AAGUID.
  aaguid: "fbfc3007-154e-4ecc-8c0b-6e020557d7bd",
  addedFrom: "Safari on macOS",
};
const OPTIONS = { options: { challenge: "abc", user: { id: "u" } } };

let methods: ConsoleMethod[] = [];
let addable: { canAdd: boolean; reason: string | null } = {
  canAdd: true,
  reason: null,
};
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const STEP_UP = () =>
  json({ error: { code: "step_up_required", message: "Sign in again" } }, 403);
const refuse = (status: number, body: Record<string, unknown>) => () =>
  json({ error: body, ...body }, status);

beforeEach(() => {
  resetConsole();
  created.fn.mockReset();
  created.supported.on = true;
  methods = [IDP, LOCKER_PASSKEY];
  addable = { canAdd: true, reason: null };
});
afterEach(() => {
  setStepUpRedirectForTests();
  sessionStorage.clear();
  cleanup();
});

function open(extra: Record<string, unknown> = {}, me = {}) {
  return boot(HASH, {
    me: { customerOrigin: "https://polaris.locker", ...me },
    extra: {
      "/manage/api/me/methods": () => ({ methods, ...addable }),
      ...extra,
    },
  });
}
const heading = () =>
  screen.findByRole("heading", { level: 1, name: "Sign-in methods" });
const posts = (log: ReturnType<typeof open>) =>
  log.calls.filter((c) => c.method === "POST").map((c) => c.path);
const addButton = () => screen.findByRole("button", { name: "Add a passkey" });
async function openAdd(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await addButton());
  return screen.findByRole("alertdialog");
}
async function openUse(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole("button", {
      name: /^Use for the console: iCloud Keychain/,
    }),
  );
  return screen.findByRole("alertdialog");
}
const confirm = (d: HTMLElement, name: string) =>
  within(d).getByRole("button", { name });
const focusedRow = () =>
  (document.activeElement as HTMLElement | null)?.dataset.methodId;

describe("Sign-in methods: the list", () => {
  it("groups methods by what opens the console, names every kind, shows no status pills and no remove", async () => {
    methods = [
      IDP,
      LOCKER_PASSKEY,
      ...["google", "apple", "steam", "gamecenter", "pgs", "eos"].map(
        (kind, i) => ({
          ...IDP,
          id: `lnk_${kind}`,
          kind,
          strong: false,
          createdAt: 1_750_000_100 + i,
        }),
      ),
    ];
    open();
    await heading();
    expect(screen.getByText("Which methods open the console.")).toBeTruthy();
    const opens = await screen.findByRole("region", {
      name: "Opens the console",
    });
    const locker = screen.getByRole("region", { name: "Polaris Locker only" });
    expect(within(opens).getByText("Single sign-on")).toBeTruthy();
    for (const name of [
      "iCloud Keychain",
      "Google",
      "Apple",
      "Steam",
      "Game Center",
      "Google Play Games",
      "Epic Online Services",
    ])
      expect(within(locker).getByText(name)).toBeTruthy();
    // No raw kind ever reaches the screen, and no negative pill repeats down the list.
    const text = document.body.textContent ?? "";
    for (const raw of ["gamecenter", "pgs", "eos"])
      expect(text).not.toContain(raw);
    expect(text).not.toContain("Doesn't open the console");
    expect(screen.queryByRole("button", { name: /remove|delete/i })).toBeNull();
  });

  it("names a console passkey by its model, else the browser it came from, and tells two alike apart", async () => {
    methods = [
      IDP,
      {
        ...LOCKER_PASSKEY,
        id: "a",
        aaguid: null,
        addedFrom: "Chrome on macOS",
      },
      {
        ...LOCKER_PASSKEY,
        id: "b",
        aaguid: null,
        addedFrom: "Chrome on macOS",
        createdAt: 1_750_000_500,
      },
    ];
    open();
    await heading();
    expect(await screen.findByText("Chrome on macOS (1)")).toBeTruthy();
    expect(screen.getByText("Chrome on macOS (2)")).toBeTruthy();
    const buttons = screen.getAllByRole("button", {
      name: /^Use for the console: Chrome/,
    });
    expect(new Set(buttons.map((b) => b.getAttribute("aria-label"))).size).toBe(
      2,
    );
  });

  it("points to Polaris Locker once, for removal", async () => {
    open();
    await heading();
    const link = await screen.findByRole("link", { name: /Polaris Locker/ });
    expect(link.getAttribute("href")).toBe(
      "https://polaris.locker/#/account/methods",
    );
    expect(link.getAttribute("rel")).toContain("noreferrer");
    expect(screen.getByText(/Remove methods in/)).toBeTruthy();
  });

  it("says so when there are none, without promising a password", async () => {
    methods = [];
    open();
    expect(await screen.findByText("No sign-in methods")).toBeTruthy();
    expect(screen.getByText(/open the console with it/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/password/);
  });

  it("shows an error with Try again when the list fails, and recovers", async () => {
    const user = userEvent.setup();
    let failing = true;
    open({
      "/manage/api/me/methods": () =>
        failing ? json({ error: "boom" }, 500) : { methods, ...addable },
    });
    await heading();
    const retry = await screen.findByRole("button", { name: /Try again/ });
    failing = false;
    await user.click(retry);
    expect(await screen.findByText("iCloud Keychain")).toBeTruthy();
  });

  it("words a 404 on the list as a sentence, not a lowercase title", async () => {
    open({ "/manage/api/me/methods": () => json({ error: "not_found" }, 404) });
    await heading();
    expect(await screen.findByText("Sign-in methods not found")).toBeTruthy();
  });
});

describe("Add a passkey", () => {
  it("runs challenge, browser, attestation, then focuses the new row", async () => {
    const user = userEvent.setup();
    created.fn.mockResolvedValue({ id: "cred" });
    const added: ConsoleMethod = {
      ...LOCKER_PASSKEY,
      id: "lnk_new",
      aaguid: null,
      addedFrom: "This browser",
      strong: true,
      consoleEligible: false,
    };
    const log = open({
      "/manage/api/me/passkeys/options": OPTIONS,
      "/manage/api/me/passkeys": () => {
        methods = [...methods, added];
        return { ok: true, passkey: { id: "cred", methodId: "lnk_new" } };
      },
    });
    await heading();
    const dialog = await openAdd(user);
    expect(posts(log)).toEqual([]);
    await user.click(confirm(dialog, "Add passkey"));
    expect(await screen.findByText("This browser")).toBeTruthy();
    expect(posts(log)).toEqual([
      "/manage/api/me/passkeys/options",
      "/manage/api/me/passkeys",
    ]);
    expect(created.fn).toHaveBeenCalledWith(OPTIONS.options);
    expect(
      log.calls.find((c) => c.path === "/manage/api/me/passkeys")?.json,
    ).toEqual({ response: { id: "cred" } });
    await waitFor(() => expect(focusedRow()).toBe("lnk_new"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("when the browser cancels, keeps the page and Try again starts the prompt without a second dialog", async () => {
    const user = userEvent.setup();
    created.fn.mockRejectedValueOnce(new PasskeyError("cancelled"));
    created.fn.mockRejectedValueOnce(new PasskeyError("cancelled"));
    const log = open({ "/manage/api/me/passkeys/options": OPTIONS });
    await heading();
    await user.click(confirm(await openAdd(user), "Add passkey"));
    expect(await screen.findByText("Nothing was added")).toBeTruthy();
    expect(screen.queryByText(/closed the prompt/)).toBeNull();
    expect(screen.getByText("iCloud Keychain")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(created.fn).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(posts(log)).toEqual([
      "/manage/api/me/passkeys/options",
      "/manage/api/me/passkeys/options",
    ]);
  });

  it("offers Use for the console when this device already has the passkey and a row is eligible", async () => {
    const user = userEvent.setup();
    created.fn.mockRejectedValue(new PasskeyError("exists"));
    open({ "/manage/api/me/passkeys/options": OPTIONS });
    await heading();
    await user.click(confirm(await openAdd(user), "Add passkey"));
    expect(
      await screen.findByText("This device already has a passkey for you"),
    ).toBeTruthy();
    expect(screen.getByText("Use it for the console instead.")).toBeTruthy();
    expect(screen.queryByText(/another device/)).toBeNull();
    const callout = screen
      .getByText("Use it for the console instead.")
      .closest("[data-tone]") as HTMLElement;
    await user.click(
      within(callout).getByRole("button", { name: "Use for the console" }),
    );
    expect(
      await screen.findByRole("alertdialog", {
        name: /Use “iCloud Keychain” for the console/,
      }),
    ).toBeTruthy();
  });

  it("offers another device only when no row is eligible", async () => {
    const user = userEvent.setup();
    methods = [IDP];
    created.fn.mockRejectedValue(new PasskeyError("exists"));
    open({ "/manage/api/me/passkeys/options": OPTIONS });
    await heading();
    await user.click(confirm(await openAdd(user), "Add passkey"));
    expect(
      await screen.findByText("Use another device or security key."),
    ).toBeTruthy();
  });

  it("answers a stale sign-in with the house callout, keeps the page, and signs in again on request", async () => {
    const user = userEvent.setup();
    const redirect = vi.fn();
    setStepUpRedirectForTests(redirect);
    const log = open({ "/manage/api/me/passkeys/options": STEP_UP });
    await heading();
    const dialog = await openAdd(user);
    await user.click(confirm(dialog, "Add passkey"));
    expect(
      await within(dialog).findByText("Sign in again to confirm it's you"),
    ).toBeTruthy();
    expect(screen.getByText("iCloud Keychain")).toBeTruthy();
    expect(created.fn).not.toHaveBeenCalled();
    await user.click(confirm(dialog, "Sign in again"));
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(posts(log)).toEqual(["/manage/api/me/passkeys/options"]);
  });

  it.each([
    [
      "limit",
      refuse(403, { code: "forbidden", reason: "limit" }),
      "You have the most passkeys an account can hold",
    ],
    [
      "email_unverified",
      refuse(403, { code: "forbidden", reason: "email_unverified" }),
      "Confirm your email first",
    ],
    [
      "account_session_required",
      refuse(403, { code: "forbidden", reason: "account_session_required" }),
      "Sign in again",
    ],
  ])(
    "words the %s refusal as its own problem, never as missing edit access",
    async (_n, answer, title) => {
      const user = userEvent.setup();
      open({ "/manage/api/me/passkeys/options": answer });
      await heading();
      const dialog = await openAdd(user);
      await user.click(confirm(dialog, "Add passkey"));
      expect(await within(dialog).findByText(title)).toBeTruthy();
      expect(dialog.textContent).not.toMatch(/edit access/i);
    },
  );

  it("words a passkey already on an account and an expired attempt", async () => {
    const user = userEvent.setup();
    created.fn.mockResolvedValue({ id: "c" });
    let next = refuse(409, { code: "link_conflict" });
    open({
      "/manage/api/me/passkeys/options": OPTIONS,
      "/manage/api/me/passkeys": () => next(),
    });
    await heading();
    const dialog = await openAdd(user);
    await user.click(confirm(dialog, "Add passkey"));
    expect(
      await within(dialog).findByText("This passkey is already on an account"),
    ).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/still in use/);
    next = refuse(400, { code: "signin_expired" });
    await user.click(confirm(dialog, "Add passkey"));
    expect(await within(dialog).findByText("That took too long")).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/refused/);
  });

  it("is soft-disabled with the reason when I-16 says the account can't add one", async () => {
    const user = userEvent.setup();
    addable = { canAdd: false, reason: "limit" };
    open();
    await heading();
    await addButton();
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Add a passkey" })
          .getAttribute("aria-disabled"),
      ).toBe("true"),
    );
    const button = screen.getByRole("button", { name: "Add a passkey" });
    expect(
      screen.getAllByText(/Remove one in Polaris Locker/).length,
    ).toBeGreaterThan(0);
    await user.click(button);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    cleanup();
    resetConsole();
    addable = { canAdd: false, reason: "email_unverified" };
    open();
    await heading();
    expect(
      (await screen.findAllByText(/Confirm your email in Polaris Locker/))
        .length,
    ).toBeGreaterThan(0);
  });

  it("detects an unsupported browser before the first click", async () => {
    created.supported.on = false;
    open();
    await heading();
    expect((await addButton()).getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.getAllByText("This browser can't create passkeys.").length,
    ).toBeGreaterThan(0);
  });
});

describe("Use for the console", () => {
  const strong = (m: ConsoleMethod[]) =>
    m.map((x) =>
      x.id === "lnk_pk" ? { ...x, strong: true, consoleEligible: false } : x,
    );

  it("sets the passkey after a confirm, moves it to the console group, says so and focuses it", async () => {
    const user = userEvent.setup();
    const log = open({
      "/manage/api/me/methods/lnk_pk/strong": () => {
        methods = strong(methods);
        return { ok: true, id: "lnk_pk", strong: true };
      },
    });
    await heading();
    const dialog = await openUse(user);
    expect(posts(log)).toEqual([]);
    await user.click(confirm(dialog, "Use for the console"));
    const opens = await screen.findByRole("region", {
      name: "Opens the console",
    });
    await waitFor(() =>
      expect(within(opens).getByText("iCloud Keychain")).toBeTruthy(),
    );
    expect(
      await screen.findByText("iCloud Keychain now opens the console"),
    ).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(focusedRow()).toBe("lnk_pk"));
    // The focus target shows it has focus: no outline-none on the row.
    expect(document.activeElement?.className).not.toContain("outline-none");
  });

  it("treats already_strong as done: closes, refetches, says so", async () => {
    const user = userEvent.setup();
    const log = open({
      "/manage/api/me/methods/lnk_pk/strong": () => {
        methods = strong(methods);
        return json(
          { error: { code: "forbidden", reason: "already_strong" } },
          409,
        );
      },
    });
    await heading();
    await user.click(confirm(await openUse(user), "Use for the console"));
    expect(
      await screen.findByText("iCloud Keychain already opens the console"),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() =>
      expect(
        log.calls.filter((c) => c.path === "/manage/api/me/methods").length,
      ).toBeGreaterThan(1),
    );
  });

  it("on not_eligible refetches and turns the primary into Add a passkey", async () => {
    const user = userEvent.setup();
    created.fn.mockRejectedValue(new PasskeyError("cancelled"));
    const log = open({
      "/manage/api/me/methods/lnk_pk/strong": refuse(403, {
        code: "forbidden",
        reason: "not_eligible",
      }),
      "/manage/api/me/passkeys/options": OPTIONS,
    });
    await heading();
    const dialog = await openUse(user);
    await user.click(confirm(dialog, "Use for the console"));
    await within(dialog).findByText("This passkey can't open the console");
    expect(
      within(dialog).queryByRole("button", { name: "Use for the console" }),
    ).toBeNull();
    expect(
      log.calls.filter((c) => c.path === "/manage/api/me/methods").length,
    ).toBeGreaterThan(1);
    // The primary now starts the add.
    await user.click(
      within(dialog).getByRole("button", { name: "Add a passkey" }),
    );
    await waitFor(() => expect(created.fn).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("on a 404 says the passkey was removed and refetches", async () => {
    const user = userEvent.setup();
    const log = open({
      "/manage/api/me/methods/lnk_pk/strong": () => {
        methods = [IDP];
        return json({ error: "not_found" }, 404);
      },
    });
    await heading();
    await user.click(confirm(await openUse(user), "Use for the console"));
    expect(await screen.findByText("This passkey was removed")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() =>
      expect(screen.queryByText("iCloud Keychain")).toBeNull(),
    );
    expect(
      log.calls.filter((c) => c.path === "/manage/api/me/methods").length,
    ).toBeGreaterThan(1);
  });

  it("answers a stale sign-in with the house callout", async () => {
    const user = userEvent.setup();
    setStepUpRedirectForTests(() => undefined);
    open({ "/manage/api/me/methods/lnk_pk/strong": STEP_UP });
    await heading();
    const dialog = await openUse(user);
    await user.click(confirm(dialog, "Use for the console"));
    expect(
      await within(dialog).findByText("Sign in again to confirm it's you"),
    ).toBeTruthy();
  });

  it("after the sign-in the dialog is back for the same passkey, and a confirm before the list loads still sends the id", async () => {
    const user = userEvent.setup();
    setStepUpRedirectForTests(() => undefined);
    open({ "/manage/api/me/methods/lnk_pk/strong": STEP_UP });
    await heading();
    const dialog = await openUse(user);
    await user.click(confirm(dialog, "Use for the console"));
    await screen.findByText("Sign in again to confirm it's you");
    await user.click(confirm(dialog, "Sign in again"));
    cleanup();
    resetConsole();
    // The page comes back from the sign-in with the list still on its way.
    const log = open({
      "/manage/api/me/methods": PENDING,
      "/manage/api/me/methods/lnk_pk/strong": () => ({ ok: true }),
    });
    const again = await screen.findByRole("alertdialog");
    await user.click(confirm(again, "Use for the console"));
    await waitFor(() =>
      expect(posts(log)).toEqual(["/manage/api/me/methods/lnk_pk/strong"]),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
});

describe("Sign-in methods: focus and resuming", () => {
  const strongOn = () => {
    methods = methods.map((x) =>
      x.id === "lnk_pk" ? { ...x, strong: true, consoleEligible: false } : x,
    );
  };

  it("keeps focus on the row after already_strong, once it has moved groups", async () => {
    const user = userEvent.setup();
    open({
      "/manage/api/me/methods/lnk_pk/strong": () => {
        strongOn();
        return json(
          { error: { code: "forbidden", reason: "already_strong" } },
          409,
        );
      },
    });
    await heading();
    await user.click(confirm(await openUse(user), "Use for the console"));
    await waitFor(() => expect(focusedRow()).toBe("lnk_pk"));
    const opens = screen.getByRole("region", { name: "Opens the console" });
    expect(within(opens).getByText("iCloud Keychain")).toBeTruthy();
  });

  it("keeps focus on the row after Use, in its new group", async () => {
    const user = userEvent.setup();
    open({
      "/manage/api/me/methods/lnk_pk/strong": () => {
        strongOn();
        return { ok: true };
      },
    });
    await heading();
    await user.click(confirm(await openUse(user), "Use for the console"));
    await waitFor(() => expect(focusedRow()).toBe("lnk_pk"));
    const opens = screen.getByRole("region", { name: "Opens the console" });
    expect(opens.contains(document.activeElement)).toBe(true);
  });

  it("does not count alike across kinds: SSO, Google and Email on one address get no ordinals", async () => {
    methods = ["oidc", "google", "email"].map((kind) => ({
      ...IDP,
      id: `lnk_${kind}`,
      kind,
      name: "ada@example.com",
    }));
    open();
    await heading();
    await screen.findAllByText("ada@example.com");
    expect(document.body.textContent).not.toMatch(/\(\d\)/);
  });

  it("moves focus to the heading when Try again removes its own callout", async () => {
    const user = userEvent.setup();
    created.fn.mockRejectedValue(new PasskeyError("cancelled"));
    open({ "/manage/api/me/passkeys/options": OPTIONS });
    await heading();
    await user.click(confirm(await openAdd(user), "Add passkey"));
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(document.activeElement?.tagName).toBe("H1");
  });

  it("moves focus to the heading after a 404 on Use", async () => {
    const user = userEvent.setup();
    open({
      "/manage/api/me/methods/lnk_pk/strong": () => {
        methods = [IDP];
        return json({ error: "not_found" }, 404);
      },
    });
    await heading();
    await user.click(confirm(await openUse(user), "Use for the console"));
    await screen.findByText("This passkey was removed");
    await waitFor(() => expect(document.activeElement?.tagName).toBe("H1"));
  });

  it("resumes the add flow, not the Use dialog, when a refused Use went on to Add a passkey and needed a step-up", async () => {
    const user = userEvent.setup();
    setStepUpRedirectForTests(() => undefined);
    const routes = {
      "/manage/api/me/methods/lnk_pk/strong": refuse(403, {
        code: "forbidden",
        reason: "not_eligible",
      }),
      "/manage/api/me/passkeys/options": STEP_UP,
    };
    open(routes);
    await heading();
    const dialog = await openUse(user);
    await user.click(confirm(dialog, "Use for the console"));
    await user.click(
      await within(dialog).findByRole("button", { name: "Add a passkey" }),
    );
    await within(dialog).findByText("Sign in again to confirm it's you");
    await user.click(confirm(dialog, "Sign in again"));
    cleanup();
    resetConsole();
    open(routes);
    const again = await screen.findByRole("alertdialog");
    expect(within(again).getByText("Add a passkey?")).toBeTruthy();
    expect(
      within(again).queryByRole("button", { name: "Use for the console" }),
    ).toBeNull();
  });
});

describe("Sign-in methods: who sees it", () => {
  it("is hidden for an emergency session: no menu item, no fetch, no break-glass wording", async () => {
    const user = userEvent.setup();
    const log = open({}, { breakGlass: true });
    await heading();
    expect(
      await screen.findByText("Emergency sign-in can't manage sign-in methods"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a passkey" })).toBeNull();
    expect(log.calls.some((c) => c.path === "/manage/api/me/methods")).toBe(
      false,
    );
    await user.click(screen.getByRole("button", { name: "Account menu" }));
    expect(
      screen.queryByRole("menuitem", { name: "Sign-in methods" }),
    ).toBeNull();
  });

  it("is in the account menu", async () => {
    const user = userEvent.setup();
    boot("", {});
    await user.click(
      await screen.findByRole("button", { name: "Account menu" }),
    );
    const item = await screen.findByRole("menuitem", {
      name: "Sign-in methods",
    });
    expect(item.getAttribute("href")).toBe(HASH);
  });
});
