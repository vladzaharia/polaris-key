import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OwnPersonalToken } from "../src/api.js";
import { hostOfLabel } from "../src/console/sections/global/pages/OwnPersonalTokens.js";
import { boot, resetConsole } from "./consoleHarness.js";

/** A member's own Personal tokens page: the Yours tab (ST-34.11). */

const ME_PATH = "/manage/api/me/personal-tokens";
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
let mine: OwnPersonalToken[] = [];
const PRODUCT_ADMIN = { platformAdmin: false };

beforeEach(() => {
  resetConsole();
  mine = [admin, packages];
});
afterEach(() => cleanup());

const lists = () => ({
  [ME_PATH]: () => ({ tokens: mine }),
  "/manage/api/account-tokens": () => ({
    tokens: [{ ...packages, email: "ada@example.com" }],
  }),
});

describe("Personal tokens: Yours", () => {
  it("lists both scopes with a scope tag, last used and status", async () => {
    boot("#/personal-tokens", { extra: lists() });
    const table = await screen.findByRole("table", {
      name: "Your personal tokens",
    });
    await within(table).findByText("pkey on ada-mbp.local");
    expect(within(table).getByText("CI build server")).toBeTruthy();
    expect(within(table).getByText("Admin")).toBeTruthy();
    expect(within(table).getByText("Packages")).toBeTruthy();
    expect(within(table).getByText("Never")).toBeTruthy();
    expect(within(table).getAllByText("Active").length).toBe(2);
  });

  it("shows the Everyone tab to a Superadmin, which loads the roster", async () => {
    const user = userEvent.setup();
    const log = boot("#/personal-tokens", { extra: lists() });
    await screen.findByText("CI build server");
    await user.click(screen.getByRole("radio", { name: "Everyone" }));
    await screen.findByRole("table", { name: "Personal tokens" });
    expect(log.calls.some((c) => c.path === "/manage/api/account-tokens")).toBe(
      true,
    );
  });

  it("gives a Product admin no Everyone tab and never asks for the roster", async () => {
    const log = boot("#/personal-tokens", {
      me: PRODUCT_ADMIN,
      extra: lists(),
    });
    await screen.findByRole("table", { name: "Your personal tokens" });
    expect(screen.queryByRole("radio", { name: "Everyone" })).toBeNull();
    expect(log.calls.some((c) => c.path === "/manage/api/account-tokens")).toBe(
      false,
    );
  });

  it("opens from the account menu", async () => {
    const user = userEvent.setup();
    boot("#/", { extra: lists() });
    await user.click(
      await screen.findByRole("button", { name: "Account menu" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: /Personal tokens/ }),
    );
    await screen.findByRole("table", { name: "Your personal tokens" });
    expect(window.location.hash).toBe("#/personal-tokens");
    // The sidebar no longer carries it.
    expect(
      document.querySelector("nav a[href='#/personal-tokens']"),
    ).toBeNull();
  });

  it("names the command and Account → Packages when there is none", async () => {
    mine = [];
    boot("#/personal-tokens", { extra: lists() });
    await screen.findByText("No tokens yet");
    expect(screen.getByText(/pkey login/)).toBeTruthy();
    expect(screen.getByText(/Account → Packages/)).toBeTruthy();
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
    await screen.findByRole("table", { name: "Your personal tokens" });
  });

  it("asks to sign in again for a v1 cookie (409 reauth)", async () => {
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
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("revokes an admin token behind an L2 confirm that names the host", async () => {
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
    const table = await screen.findByRole("table", {
      name: "Your personal tokens",
    });
    await user.click(
      await within(table).findByRole("button", {
        name: "Actions for pkey on ada-mbp.local",
      }),
    );
    await user.click(await screen.findByRole("menuitem", { name: /Revoke/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText("pkey on ada-mbp.local stops working."),
    ).toBeTruthy();
    // L2: the confirm button is the danger one; nothing is sent yet.
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

  it("revokes a packages token behind an L1 confirm that names installs", async () => {
    const user = userEvent.setup();
    boot("#/personal-tokens", { extra: lists() });
    const table = await screen.findByRole("table", {
      name: "Your personal tokens",
    });
    await user.click(
      await within(table).findByRole("button", {
        name: "Actions for CI build server",
      }),
    );
    await user.click(await screen.findByRole("menuitem", { name: /Revoke/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/Installs using CI build server stop/),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/stops working/)).toBeNull();
    // L1: caution, not the danger button.
    expect(
      within(dialog).getByRole("button", { name: "Revoke token" }).className,
    ).not.toMatch(/danger/);
    expect(within(dialog).getByText(/Account → Packages/)).toBeTruthy();
  });
});

describe("hostOfLabel", () => {
  it("reads the host back from pkey login's label", () => {
    expect(hostOfLabel("pkey on ada-mbp.local")).toBe("ada-mbp.local");
    expect(hostOfLabel("CI build server")).toBeNull();
    expect(hostOfLabel("pkey on ")).toBeNull();
  });
});
