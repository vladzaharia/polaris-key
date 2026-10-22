/**
 * Commerce → Overview, store identity (A-28.5, CM-20 D12/D14/D15): each store row shows the app
 * its purchases belong to and where that comes from; a typed value that differs from the assigned
 * app is named with "Use the assigned app" (an L1 confirm); no app and an unpinned own key say so.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ME, resetConsole } from "./consoleHarness.js";
import { P, bootWith, writes } from "./distributionFixture.js";
import type { CommerceView } from "../src/api.js";
import { r } from "../src/console/routes.js";

const PAGE = r.commerceOverview("djdl");
const VIEW_PATH = P("/commerce");

beforeEach(() => {
  resetConsole();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const READY = { configured: true, credential: "cred", reason: null };
const none = {
  value: null,
  source: null,
  assigned: null,
  mismatch: false,
  ambiguous: false,
} as const;

function view(over: Partial<CommerceView> = {}): CommerceView {
  return {
    licenseEnabled: true,
    identity: {
      "app-store": {
        value: "com.djdl.app",
        source: "assigned",
        assigned: "com.djdl.app",
        mismatch: false,
        ambiguous: false,
      },
      play: {
        value: "gg.djdl.app",
        source: "typed",
        assigned: "gg.djdl.app",
        mismatch: false,
        ambiguous: false,
      },
      steam: none,
    },
    setup: {
      "app-store": READY,
      play: READY,
      steam: {
        configured: false,
        credential: null,
        reason: "no_app_assigned",
      },
    },
    products: [],
    purchases: [],
    events: [],
    ...over,
  };
}

const rows = async () =>
  within(await screen.findByRole("list", { name: "Storefronts" }));
const row = async (store: string) => {
  const el = (await rows()).getByText(store).closest("li");
  if (!el) throw new Error(`no row for ${store}`);
  return within(el);
};

describe("store identity on the Commerce overview", () => {
  it("shows a derived identity with its source and a typed one as typed", async () => {
    bootWith(PAGE, { [VIEW_PATH]: view() });
    const apple = await row("App Store");
    expect(apple.getByText("com.djdl.app")).toBeTruthy();
    expect(apple.getByText("From the App Store assignment")).toBeTruthy();
    const play = await row("Google Play");
    expect(play.getByText("gg.djdl.app")).toBeTruthy();
    expect(play.getByText("Typed in settings")).toBeTruthy();
    expect(screen.queryByText("Use the assigned app")).toBeNull();
  });

  it("says No app assigned, and sends a platform admin to Store connections", async () => {
    bootWith(PAGE, { [VIEW_PATH]: view() });
    const steam = await row("Steam");
    expect(steam.getByText("No app assigned")).toBeTruthy();
    // Nothing is wrong with a credential: the store is just not set up.
    expect(steam.getByText("Not set up")).toBeTruthy();
    expect(steam.queryByText(/credential/i)).toBeNull();
    const link = steam.getByRole("link", {
      name: "Platform → Store connections",
    });
    expect(link.getAttribute("href")).toBe(r.platformStores());
  });

  it("gives a member who is not a platform admin no link", async () => {
    bootWith(PAGE, {
      [VIEW_PATH]: view(),
      "/manage/api/me": {
        ...ME,
        platformAdmin: false,
        permissions: {
          roles: [],
          platform: { view: ["console"], edit: [] },
          products: {
            djdl: { view: ["core", "commerce"], edit: ["commerce"] },
          },
        },
      },
    });
    const steam = await row("Steam");
    expect(steam.getByText("No app assigned")).toBeTruthy();
    expect(steam.queryByRole("link")).toBeNull();
  });

  it("explains an own key that names no app", async () => {
    const v = view();
    v.setup.steam = {
      configured: false,
      credential: null,
      reason: "own_credential_unpinned",
    };
    bootWith(PAGE, { [VIEW_PATH]: v });
    const steam = await row("Steam");
    expect(
      steam.getByText(/names no app and hides the platform's/),
    ).toBeTruthy();
    expect(steam.queryByText("No app assigned")).toBeNull();
    expect(steam.getByRole("link", { name: "Open keys" })).toBeTruthy();
  });

  it("shows a dash for a store with no settings", async () => {
    const v = view();
    v.setup.steam = {
      configured: false,
      credential: null,
      reason: "no settings for this store",
    };
    bootWith(PAGE, { [VIEW_PATH]: v });
    const steam = await row("Steam");
    expect(steam.queryByText("No app assigned")).toBeNull();
    expect(steam.getByText("None")).toBeTruthy();
  });

  it("names both apps on a mismatch and fixes it through an L1 confirm", async () => {
    const mismatched = view();
    mismatched.identity["app-store"] = {
      value: "com.typo.app",
      source: "typed",
      assigned: "com.djdl.app",
      mismatch: true,
      ambiguous: false,
    };
    let fixed = false;
    const { calls } = bootWith(PAGE, {
      [VIEW_PATH]: () => (fixed ? view() : mismatched),
      [`POST ${VIEW_PATH}/settings/app-store/use-assigned`]: () => {
        fixed = true;
        return view();
      },
    });
    const callout = (await screen.findByText("App Store app mismatch")).closest(
      "[data-tone]",
    ) as HTMLElement;
    expect(callout.textContent).toContain("com.typo.app");
    expect(callout.textContent).toContain("com.djdl.app");

    await userEvent.click(
      within(callout).getByRole("button", { name: "Use the assigned app" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Use the assigned app?");
    expect(writes(calls)).toEqual([]);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Use the assigned app" }),
    );
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({
      method: "POST",
      path: `${VIEW_PATH}/settings/app-store/use-assigned`,
    });
    await waitFor(() =>
      expect(screen.queryByText("App Store app mismatch")).toBeNull(),
    );
  });

  it("cancel leaves the typed value alone", async () => {
    const mismatched = view();
    mismatched.identity["app-store"] = {
      value: "com.typo.app",
      source: "typed",
      assigned: "com.djdl.app",
      mismatch: true,
      ambiguous: false,
    };
    const { calls } = bootWith(PAGE, { [VIEW_PATH]: mismatched });
    await userEvent.click(
      await screen.findByRole("button", { name: "Use the assigned app" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Cancel" }),
    );
    expect(writes(calls)).toEqual([]);
  });

  it("names the app in force when a store's own keys disagree", async () => {
    const v = view();
    v.identity["app-store"] = { ...v.identity["app-store"], ambiguous: true };
    bootWith(PAGE, { [VIEW_PATH]: v });
    const callout = (
      await screen.findByText("App Store keys name different apps")
    ).closest("[data-tone]") as HTMLElement;
    expect(callout.textContent).toContain("com.djdl.app");
    expect(
      within(callout).getByRole("link", { name: "Open keys" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Use the assigned app" }),
    ).toBeNull();
  });

  it("disables the fix for a member without Commerce edit, with who to ask", async () => {
    const mismatched = view();
    mismatched.identity.play = {
      value: "gg.typo",
      source: "typed",
      assigned: "gg.djdl.app",
      mismatch: true,
      ambiguous: false,
    };
    bootWith(PAGE, {
      [VIEW_PATH]: mismatched,
      "/manage/api/me": {
        ...ME,
        platformAdmin: false,
        permissions: {
          roles: [],
          platform: { view: ["console"], edit: [] },
          products: { djdl: { view: ["core", "commerce"], edit: [] } },
        },
      },
    });
    const btn = await screen.findByRole("button", {
      name: "Use the assigned app",
    });
    expect(btn.getAttribute("aria-disabled")).toBe("true");
  });
});
