import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConsoleMethod } from "../src/api.js";
import { setStepUpRedirectForTests } from "../src/lib/stepUp.js";
import { PasskeyError } from "../src/lib/webauthn.js";
import { boot, resetConsole } from "./consoleHarness.js";

/** The operator's own Sign-in methods (`#/account/sign-in-methods`, ST-30c.4). */

const created = vi.hoisted(() => ({
  fn: vi.fn(),
}));
vi.mock("../src/lib/webauthn.js", async (orig) => ({
  ...(await orig<typeof import("../src/lib/webauthn.js")>()),
  passkeysSupported: () => true,
  createPasskey: created.fn,
}));

const HASH = "#/account/sign-in-methods";
const ROW: ConsoleMethod = {
  id: "lnk_oidc",
  kind: "oidc",
  name: "ada@x.io",
  createdAt: 1_750_000_000,
  lastUsedAt: 1_750_100_000,
  strong: true,
  consoleEligible: false,
};
const LOCKER_PASSKEY: ConsoleMethod = {
  id: "lnk_pk",
  kind: "passkey",
  name: "Work laptop",
  createdAt: 1_750_000_000,
  lastUsedAt: null,
  strong: false,
  consoleEligible: true,
};
const OPTIONS = { options: { challenge: "abc", user: { id: "u" } } };

let methods: ConsoleMethod[] = [];
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const STEP_UP = () =>
  json({ error: { code: "step_up_required", message: "Sign in again" } }, 403);

beforeEach(() => {
  resetConsole();
  created.fn.mockReset();
  methods = [ROW, LOCKER_PASSKEY];
});
afterEach(() => {
  setStepUpRedirectForTests();
  sessionStorage.clear();
  cleanup();
});

function open(extra: Record<string, unknown> = {}, me = {}) {
  return boot(HASH, {
    me: { customerOrigin: "https://polaris.locker", ...me },
    extra: { "/manage/api/me/methods": () => ({ methods }), ...extra },
  });
}
const heading = () =>
  screen.findByRole("heading", { level: 1, name: "Sign-in methods" });
const posts = (log: ReturnType<typeof open>) =>
  log.calls.filter((c) => c.method === "POST").map((c) => c.path);

describe("Sign-in methods", () => {
  it("lists each method with whether it opens the console, and points to the Locker account for removal", async () => {
    open();
    await heading();
    const list = await screen.findByRole("list", { name: "Sign-in methods" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("Opens the console")).toBeTruthy();
    expect(within(rows[1]!).getByText("Doesn't open the console")).toBeTruthy();
    expect(
      within(rows[1]!).getByRole("button", {
        name: "Use Work laptop for the console",
      }),
    ).toBeTruthy();
    // No remove here.
    expect(screen.queryByRole("button", { name: /remove|delete/i })).toBeNull();
    const link = screen.getByRole("link", { name: /Open Polaris Locker/ });
    expect(link.getAttribute("href")).toBe(
      "https://polaris.locker/#/account/methods",
    );
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("says so when there are none", async () => {
    methods = [];
    open();
    expect(await screen.findByText("No sign-in methods")).toBeTruthy();
  });

  it("shows an error with Try again when the list fails, then recovers", async () => {
    const user = userEvent.setup();
    let failing = true;
    open({
      "/manage/api/me/methods": () =>
        failing ? json({ error: "boom" }, 500) : { methods },
    });
    await heading();
    const retry = await screen.findByRole("button", { name: /Try again/ });
    failing = false;
    await user.click(retry);
    expect(await screen.findByText("Work laptop")).toBeTruthy();
  });

  it("adds a passkey: confirm, challenge, browser, attestation, then a refreshed list", async () => {
    const user = userEvent.setup();
    created.fn.mockResolvedValue({ id: "cred" });
    const added: ConsoleMethod = {
      ...LOCKER_PASSKEY,
      id: "lnk_new",
      name: "This browser",
      strong: true,
      consoleEligible: false,
    };
    const log = open({
      "/manage/api/me/passkeys/options": OPTIONS,
      "/manage/api/me/passkeys": () => {
        methods = [...methods, added];
        return { ok: true };
      },
    });
    await heading();
    await user.click(
      await screen.findByRole("button", { name: "Add a passkey" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(posts(log)).toEqual([]);
    await user.click(
      within(dialog).getByRole("button", { name: "Add passkey" }),
    );
    expect(await screen.findByText("This browser")).toBeTruthy();
    expect(posts(log)).toEqual([
      "/manage/api/me/passkeys/options",
      "/manage/api/me/passkeys",
    ]);
    expect(created.fn).toHaveBeenCalledWith(OPTIONS.options);
    expect(
      log.calls.find((c) => c.path === "/manage/api/me/passkeys")?.json,
    ).toEqual({ response: { id: "cred" } });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  });

  it("keeps the page when the browser cancels, and offers Try again", async () => {
    const user = userEvent.setup();
    created.fn.mockRejectedValue(new PasskeyError("cancelled"));
    const log = open({ "/manage/api/me/passkeys/options": OPTIONS });
    await heading();
    await user.click(
      await screen.findByRole("button", { name: "Add a passkey" }),
    );
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Add passkey",
      }),
    );
    expect(await screen.findByText("Nothing was added")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    // The list is untouched and nothing was posted beyond the challenge.
    expect(screen.getByText("Work laptop")).toBeTruthy();
    expect(posts(log)).toEqual(["/manage/api/me/passkeys/options"]);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
  });

  it("answers a stale sign-in with the house callout, keeps the page, and signs in again on request", async () => {
    const user = userEvent.setup();
    const redirect = vi.fn();
    setStepUpRedirectForTests(redirect);
    const log = open({ "/manage/api/me/passkeys/options": STEP_UP });
    await heading();
    await user.click(
      await screen.findByRole("button", { name: "Add a passkey" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Add passkey" }),
    );
    expect(
      await within(dialog).findByText("Sign in again to confirm it's you"),
    ).toBeTruthy();
    // The page and its list stay behind the dialog; the browser was never asked.
    expect(screen.getByText("Work laptop")).toBeTruthy();
    expect(created.fn).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
    await user.click(
      within(dialog).getByRole("button", { name: "Sign in again" }),
    );
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(posts(log)).toEqual(["/manage/api/me/passkeys/options"]);
  });

  it("opens the dialog again after the sign-in, for the same passkey", async () => {
    const user = userEvent.setup();
    setStepUpRedirectForTests(() => undefined);
    open({ "/manage/api/me/methods/lnk_pk/strong": STEP_UP });
    await heading();
    await user.click(
      await screen.findByRole("button", {
        name: "Use Work laptop for the console",
      }),
    );
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Use for the console",
      }),
    );
    await screen.findByText("Sign in again to confirm it's you");
    await user.click(screen.getByRole("button", { name: "Sign in again" }));
    cleanup();
    // The page comes back from the sign-in: the saved state reopens the dialog.
    resetConsole();
    open({ "/manage/api/me/methods/lnk_pk/strong": STEP_UP });
    const again = await screen.findByRole("alertdialog");
    expect(
      await within(again).findByText(/Use Work laptop for the console\?/),
    ).toBeTruthy();
  });

  it("sets a passkey for the console after a confirm, then shows it", async () => {
    const user = userEvent.setup();
    const log = open({
      "/manage/api/me/methods/lnk_pk/strong": () => {
        methods = methods.map((m) =>
          m.id === "lnk_pk"
            ? { ...m, strong: true, consoleEligible: false }
            : m,
        );
        return { ok: true, id: "lnk_pk", strong: true };
      },
    });
    await heading();
    await user.click(
      await screen.findByRole("button", {
        name: "Use Work laptop for the console",
      }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(posts(log)).toEqual([]);
    await user.click(
      within(dialog).getByRole("button", { name: "Use for the console" }),
    );
    await waitFor(() =>
      expect(screen.getAllByText("Opens the console")).toHaveLength(2),
    );
    expect(posts(log)).toEqual(["/manage/api/me/methods/lnk_pk/strong"]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  });

  it("explains not_eligible by its reason, not the Worker's sentence", async () => {
    const user = userEvent.setup();
    open({
      "/manage/api/me/methods/lnk_pk/strong": () =>
        json(
          {
            error: { code: "forbidden", reason: "not_eligible", message: "x" },
          },
          403,
        ),
    });
    await heading();
    await user.click(
      await screen.findByRole("button", {
        name: "Use Work laptop for the console",
      }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Use for the console" }),
    );
    expect(
      await within(dialog).findByText("This passkey can't be used here"),
    ).toBeTruthy();
    expect(within(dialog).queryByText("x")).toBeNull();
  });

  it("explains already_strong and refreshes the list", async () => {
    const user = userEvent.setup();
    const log = open({
      "/manage/api/me/methods/lnk_pk/strong": () => {
        methods = methods.map((m) =>
          m.id === "lnk_pk"
            ? { ...m, strong: true, consoleEligible: false }
            : m,
        );
        return json(
          { error: { code: "forbidden", reason: "already_strong" } },
          409,
        );
      },
    });
    await heading();
    await user.click(
      await screen.findByRole("button", {
        name: "Use Work laptop for the console",
      }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Use for the console" }),
    );
    expect(
      await within(dialog).findByText("This passkey already signs you in here"),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        log.calls.filter((c) => c.path === "/manage/api/me/methods").length,
      ).toBeGreaterThan(1),
    );
  });

  it("is hidden for a break-glass session: no menu item, no fetch", async () => {
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
