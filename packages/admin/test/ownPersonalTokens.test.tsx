import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AdminPersonalToken, OwnPersonalToken } from "../src/api.js";
import {
  hostOfLabel,
  revokeCopy,
} from "../src/console/sections/global/pages/personalTokenParts.js";
import { boot, resetConsole } from "./consoleHarness.js";

/** The Personal tokens page: Yours and Everyone (ST-34.11, and its UX fix round). */

const ME_PATH = "/manage/api/me/personal-tokens";
const ALL_PATH = "/manage/api/account-tokens";
const admin: OwnPersonalToken = {
  id: "pt_cli",
  label: "pkey on ada-mbp.local",
  hint: "Hq2a",
  scope: "admin",
  createdAt: 1_750_000_000,
  expiresAt: 4_102_444_800,
  lastUsedAt: 1_750_050_000,
  revokedAt: null,
  revokeReason: null,
  status: "active",
};
const packages: OwnPersonalToken = {
  ...admin,
  id: "pt_ci",
  label: "CI build server",
  hint: "j3eX",
  scope: "packages:read",
  lastUsedAt: null,
};
const expired: OwnPersonalToken = {
  ...packages,
  id: "pt_exp",
  label: "Old CI",
  status: "expired",
  expiresAt: 1_700_000_000,
};
let mine: OwnPersonalToken[] = [];
let everyone: AdminPersonalToken[] = [];
const PRODUCT_ADMIN = { platformAdmin: false };

beforeEach(() => {
  resetConsole();
  mine = [admin, packages];
  everyone = [
    { ...admin, email: "ada@example.com" },
    { ...packages, id: "pt_lu", email: "lucia@example.com" },
  ];
});
afterEach(() => cleanup());

const lists = () => ({
  [ME_PATH]: () => ({ tokens: mine }),
  [ALL_PATH]: () => ({ tokens: everyone }),
});

const yours = () => screen.findByRole("table", { name: "Personal tokens" });
async function openActions(
  table: HTMLElement,
  who: string,
  user: ReturnType<typeof userEvent.setup>,
) {
  await user.click(
    await within(table).findByRole("button", { name: `Actions for ${who}` }),
  );
  await user.click(await screen.findByRole("menuitem", { name: /Revoke/ }));
  return screen.findByRole("alertdialog");
}

describe("Personal tokens: Yours", () => {
  it("lists both scopes with a neutral scope tag, the host as the title, last used and status", async () => {
    boot("#/personal-tokens", { extra: lists() });
    const table = await yours();
    await within(table).findByText("ada-mbp.local");
    // A `pkey login` token: the host is the title, the second line says where it came from.
    expect(within(table).getByText(/pkey login · pkeyp_…Hq2a/)).toBeTruthy();
    expect(within(table).getByText("CI build server")).toBeTruthy();
    expect(within(table).getByText("Admin")).toBeTruthy();
    expect(within(table).getByText("Packages")).toBeTruthy();
    expect(within(table).getByText("Never")).toBeTruthy();
    expect(within(table).getAllByText("Active").length).toBe(2);
    // Scope is a tag, not a status pill: no status tone on it.
    expect(within(table).getByText("Admin").closest("[data-tone]")).toBeNull();
    // Labels follow the text's own direction.
    expect(within(table).getByText("CI build server").getAttribute("dir")).toBe(
      "auto",
    );
  });

  it("puts the tab in the route and keeps each table's search to itself", async () => {
    const user = userEvent.setup();
    const log = boot("#/personal-tokens", { extra: lists() });
    await screen.findByText("CI build server");
    await user.click(screen.getByRole("radio", { name: "Everyone" }));
    await waitFor(() =>
      expect(window.location.hash).toBe("#/personal-tokens?who=everyone"),
    );
    const table = await yours();
    await within(table).findByText("lucia@example.com");
    expect(log.calls.some((c) => c.path === ALL_PATH)).toBe(true);
    await user.type(
      screen.getByPlaceholderText(/Search label or account/),
      "lucia",
    );
    await waitFor(() =>
      expect(window.location.hash).toMatch(/everyone\.q=lucia/),
    );
    await user.click(screen.getByRole("radio", { name: "Yours" }));
    await waitFor(() =>
      expect(window.location.hash).not.toMatch(/who=everyone/),
    );
    // Yours is not filtered by Everyone's search.
    await screen.findByText("CI build server");
    expect(
      (screen.getByPlaceholderText("Search label") as HTMLInputElement).value,
    ).toBe("");
  });

  it("opens Everyone from a link for a Superadmin, and Yours for a Product admin", async () => {
    boot("#/personal-tokens?who=everyone", { extra: lists() });
    await screen.findByText("lucia@example.com");
    cleanup();
    resetConsole();
    boot("#/personal-tokens?who=everyone", {
      me: PRODUCT_ADMIN,
      extra: lists(),
    });
    await screen.findByText("CI build server");
    expect(screen.queryByRole("radio", { name: "Everyone" })).toBeNull();
  });

  it("gives a Product admin no Everyone tab and never asks for the roster", async () => {
    const log = boot("#/personal-tokens", {
      me: PRODUCT_ADMIN,
      extra: lists(),
    });
    await yours();
    expect(screen.queryByRole("radio", { name: "Everyone" })).toBeNull();
    expect(log.calls.some((c) => c.path === ALL_PATH)).toBe(false);
  });

  it("opens from the account menu, leaves the sidebar without it, and the heading keeps focus", async () => {
    const user = userEvent.setup();
    boot("#/", { extra: lists() });
    await user.click(
      await screen.findByRole("button", { name: "Account menu" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: /Personal tokens/ }),
    );
    await yours();
    expect(window.location.hash).toBe("#/personal-tokens");
    expect(
      document.querySelector("nav a[href='#/personal-tokens']"),
    ).toBeNull();
    await waitFor(() => expect(document.activeElement?.tagName).toBe("H1"));
  });

  it("is found by the command palette", async () => {
    const user = userEvent.setup();
    boot("#/", { extra: lists() });
    await screen.findByRole("button", { name: "Account menu" });
    await user.keyboard("{Meta>}k{/Meta}");
    await user.keyboard("personal");
    expect(await screen.findByText("Personal tokens")).toBeTruthy();
  });

  it("names the command and the portal page in the first-run state", async () => {
    mine = [];
    boot("#/personal-tokens", {
      me: { customerOrigin: "https://polaris.locker" },
      extra: lists(),
    });
    await screen.findByText("No personal tokens yet");
    expect(screen.getByText("pkey login")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy pkey login" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "create a personal token" })
        .getAttribute("href"),
    ).toBe("https://polaris.locker/#/account/packages");
    // Docs point at the CLI reference.
    expect(
      document.querySelector("a[href='/docs/reference/cli/']"),
    ).toBeTruthy();
    expect(screen.queryByText(/packages token/)).toBeNull();
  });

  it("says nothing matches without 'your', and keeps the caption plain", async () => {
    const user = userEvent.setup();
    boot("#/personal-tokens", { extra: lists() });
    await screen.findByText("CI build server");
    await user.type(screen.getByPlaceholderText("Search label"), "zzz");
    expect(
      await screen.findByText(/No personal tokens match these filters/),
    ).toBeTruthy();
    expect(screen.queryByText(/No your/)).toBeNull();
  });

  it("says what failed and retries", async () => {
    const user = userEvent.setup();
    let fail = true;
    boot("#/personal-tokens", {
      extra: {
        ...lists(),
        [ME_PATH]: () =>
          fail
            ? new Response(JSON.stringify({ error: "boom" }), { status: 500 })
            : { tokens: mine },
      },
    });
    const retry = await screen.findByRole("button", { name: "Try again" });
    fail = false;
    await user.click(retry);
    await yours();
  });

  it("asks to sign in again for a v1 cookie (409 reauth), once and with the right button", async () => {
    boot("#/personal-tokens", {
      extra: {
        ...lists(),
        [ME_PATH]: () =>
          new Response(
            JSON.stringify({ error: "reauth", message: "sign in again" }),
            { status: 409 },
          ),
      },
    });
    await screen.findByText("Sign in again to see your tokens");
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByText(/Sign out and back in/)).toBeNull();
  });

  it("revokes an admin token behind an L2 confirm that says what stops and when", async () => {
    const user = userEvent.setup();
    const log = boot("#/personal-tokens", {
      extra: {
        ...lists(),
        [`DELETE ${ME_PATH}/pt_cli`]: () => {
          mine = mine.map((t) =>
            t.id === "pt_cli"
              ? { ...t, status: "revoked", revokedAt: 1_750_100_000 }
              : t,
          );
          return { ok: true, token: mine[0] };
        },
      },
    });
    const table = await yours();
    const dialog = await openActions(table, "pkey on ada-mbp.local", user);
    expect(
      within(dialog).getByText("Revoke pkey on ada-mbp.local?"),
    ).toBeTruthy();
    expect(
      within(dialog).getByText("pkey on that computer stops working at once."),
    ).toBeTruthy();
    expect(
      within(dialog).getByText("Run pkey login there to sign in again."),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Revoke token" }).className,
    ).toMatch(/danger/);
    expect(log.calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(
      within(dialog).getByRole("button", { name: "Revoke token" }),
    );
    await waitFor(() =>
      expect(log.calls.find((c) => c.method === "DELETE")?.path).toBe(
        `${ME_PATH}/pt_cli`,
      ),
    );
    await waitFor(() =>
      expect(within(table).getAllByText("Revoked").length).toBeGreaterThan(0),
    );
  });

  it("revokes a packages token behind an L1 confirm with the quoted name and a linked next step", async () => {
    const user = userEvent.setup();
    boot("#/personal-tokens", {
      me: { customerOrigin: "https://polaris.locker" },
      extra: lists(),
    });
    const table = await yours();
    const dialog = await openActions(table, "CI build server", user);
    expect(
      within(dialog).getByText(
        /Installs using “CI build server” stop within 30 seconds/,
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/stops working/)).toBeNull();
    expect(
      within(dialog)
        .getByRole("link", { name: "Account → Packages" })
        .getAttribute("href"),
    ).toBe("https://polaris.locker/#/account/packages");
    expect(
      within(dialog).getByRole("button", { name: "Revoke token" }).className,
    ).not.toMatch(/danger/);
  });

  it("offers Revoke only on an active token", async () => {
    const user = userEvent.setup();
    mine = [packages, expired];
    boot("#/personal-tokens", { extra: lists() });
    const table = await yours();
    await within(table).findByText("Old CI");
    expect(
      within(table).queryByRole("button", { name: "Actions for Old CI" }),
    ).toBeNull();
    expect(
      within(table).getByRole("button", {
        name: "Actions for CI build server",
      }),
    ).toBeTruthy();
    void user;
  });
});

describe("Personal tokens: Everyone", () => {
  it("shows Scope and the same column order as Yours", async () => {
    const user = userEvent.setup();
    boot("#/personal-tokens?who=everyone", { extra: lists() });
    const table = await yours();
    await within(table).findByText("ada@example.com");
    const heads = within(table)
      .getAllByRole("columnheader")
      .map((h) => h.textContent?.trim());
    expect(heads.slice(0, 6)).toEqual([
      "Token",
      "Account",
      "Scope",
      "Status",
      "Last used",
      "Expires",
    ]);
    expect(within(table).getByText("Admin")).toBeTruthy();
    void user;
  });

  it("says what an admin token's revoke really stops, for whom", async () => {
    const user = userEvent.setup();
    boot("#/personal-tokens?who=everyone", { extra: lists() });
    const table = await yours();
    const dialog = await openActions(table, "pkey on ada-mbp.local", user);
    expect(
      within(dialog).getByText(
        "pkey on that computer stops working at once, for ada@example.com.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText("They run pkey login there to sign in again."),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/Installs using/)).toBeNull();
  });

  it("says a packages token's revoke stops installs, for its owner", async () => {
    const user = userEvent.setup();
    boot("#/personal-tokens?who=everyone", { extra: lists() });
    const table = await yours();
    const dialog = await openActions(table, "CI build server", user);
    expect(
      within(dialog).getByText(
        /Installs using “CI build server” stop within 30 seconds, for lucia@example.com/,
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText(/Its owner makes a new one/)).toBeTruthy();
  });

  it("no longer says the tokens come only from Account → Packages when empty", async () => {
    everyone = [];
    boot("#/personal-tokens?who=everyone", { extra: lists() });
    await screen.findByText("No personal tokens");
    expect(screen.getByText("pkey login")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Account → Packages" }),
    ).toBeTruthy();
  });
});

describe("revoke copy", () => {
  it("reads the host back from pkey login's label", () => {
    expect(hostOfLabel("pkey on ada-mbp.local")).toBe("ada-mbp.local");
    expect(hostOfLabel("CI build server")).toBeNull();
    expect(hostOfLabel("pkey on ")).toBeNull();
  });
  it("falls back to 'This admin token' for a label with no host", () => {
    const c = revokeCopy({ scope: "admin", label: "pkey on " });
    expect(c.title).toBe("Revoke this admin token?");
    expect(c.consequences[0]).toBe("This admin token stops working at once.");
  });
});
