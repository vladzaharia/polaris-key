/**
 * Commerce → Overview, store identity (A-28.5, CM-20 D12/D14/D15): each store row shows the app
 * its purchases belong to and where that comes from; a typed value that differs from the assigned
 * app is named with "Use the assigned app" (an L1 confirm); no app and an unpinned own key say so.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ALL_ON, ME, productRow, resetConsole } from "./consoleHarness.js";
import { P, apiError, bootWith, writes } from "./distributionFixture.js";
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
    expect(apple.getByText("From the assignment")).toBeTruthy();
    const play = await row("Google Play");
    expect(play.getByText("gg.djdl.app")).toBeTruthy();
    expect(play.getByText(/Typed in/).textContent).toBe(
      "Typed in commerce.stores",
    );
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
    // Only the store's own channel page (A-22.7); no link to assign the app.
    expect(
      steam.getAllByRole("link").map((a) => a.getAttribute("href")),
    ).toEqual(["#/p/djdl/distribution/channels/steam/sales"]);
    expect(steam.getByText("A platform admin assigns it.")).toBeTruthy();
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
      steam.getByText(
        "Its own key names no app, so the platform's assignment is ignored.",
      ),
    ).toBeTruthy();
    expect(steam.queryByText("No app assigned")).toBeNull();
    expect(
      steam.getByRole("link", { name: "Pin the key" }).getAttribute("href"),
    ).toBe(r.credentials("djdl"));
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
    expect(dialog.textContent).toContain(
      "App Store purchases are checked against com.djdl.app instead of com.typo.app.",
    );
    expect(dialog.textContent).toContain(
      "Purchases of com.typo.app are refused.",
    );
    expect(dialog.textContent).toContain(
      "To undo, set commerce.stores again through the API.",
    );
    expect(dialog.textContent).not.toContain("typed app");
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
    // Focus lands on the store's row, never <body>.
    await waitFor(() => {
      const active = document.activeElement as HTMLElement;
      expect(active).not.toBe(document.body);
      expect(active.getAttribute("data-store-row")).toBe("app-store");
    });
  });

  it("agrees with the callout: a realistic mismatch reads App mismatch, not Needs a credential", async () => {
    // The key is pinned to the assigned app and the typed value differs: the server says not configured.
    const v = view();
    v.identity["app-store"] = {
      value: "com.typo.app",
      source: "typed",
      assigned: "com.djdl.app",
      mismatch: true,
      ambiguous: false,
    };
    v.setup["app-store"] = {
      configured: false,
      credential: "cred",
      reason: "wrong_app",
    };
    bootWith(PAGE, { [VIEW_PATH]: v });
    const apple = await row("App Store");
    expect(apple.getByText("App mismatch")).toBeTruthy();
    expect(apple.queryByText("Needs a credential")).toBeNull();
  });

  it("A-28.6: a mismatched store is not counted as ready", async () => {
    const v = view();
    v.identity["app-store"] = {
      value: "com.typo.app",
      source: "typed",
      assigned: "com.djdl.app",
      mismatch: true,
      ambiguous: false,
    };
    // The server still says configured; play is the only ready store.
    bootWith(PAGE, { [VIEW_PATH]: v });
    expect(await screen.findByText("1 storefront ready.")).toBeTruthy();
  });

  it("A-28.6: the phone rows wrap their pill instead of clipping it", async () => {
    bootWith(PAGE, { [VIEW_PATH]: view() });
    const pill = (await row("App Store")).getByText("Ready");
    const header = pill.closest("li")!.firstElementChild as HTMLElement;
    expect(header.className).toContain("flex-wrap");
    expect(header.className).toContain("gap-y-1");
  });

  it("A-28.6: the Apple ID line shows only when an Apple ID is typed", async () => {
    const open = async (v: CommerceView) => {
      bootWith(PAGE, { [VIEW_PATH]: v });
      await userEvent.click(
        await screen.findByRole("button", { name: "Use the assigned app" }),
      );
      return (await screen.findByRole("alertdialog")).textContent;
    };
    const mismatched = (): CommerceView => {
      const v = view();
      v.identity["app-store"] = {
        value: "com.typo.app",
        source: "typed",
        assigned: "com.djdl.app",
        mismatch: true,
        ambiguous: false,
      };
      return v;
    };
    expect(await open(mismatched())).not.toContain("Apple ID");
    cleanup();
    resetConsole();
    expect(
      await open({
        ...mismatched(),
        settings: { appStore: { appAppleId: "1234567890" } },
      }),
    ).toContain("The typed Apple ID is cleared too.");
  });

  it("shows one callout for a store that is mismatched and ambiguous", async () => {
    const v = view();
    v.identity["app-store"] = {
      value: "com.typo.app",
      source: "typed",
      assigned: "com.djdl.app",
      mismatch: true,
      ambiguous: true,
    };
    bootWith(PAGE, { [VIEW_PATH]: v });
    await screen.findByText("App Store app mismatch");
    expect(screen.queryByText("App Store keys name different apps")).toBeNull();
  });

  it("hides the identity callouts while Commerce is off", async () => {
    const v = view();
    v.identity["app-store"] = {
      value: "com.typo.app",
      source: "typed",
      assigned: "com.djdl.app",
      mismatch: true,
      ambiguous: false,
    };
    bootWith(
      PAGE,
      { [VIEW_PATH]: v },
      {
        services: {
          license: { enabled: true },
          commerce: { enabled: false },
          connect: { enabled: false },
        },
      },
    );
    await screen.findByText("Commerce is off for this product");
    await row("App Store");
    expect(screen.queryByText("App Store app mismatch")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Use the assigned app" }),
    ).toBeNull();
  });

  it("explains a 409 no_assigned_app and refetches the view", async () => {
    const mismatched = view();
    mismatched.identity["app-store"] = {
      value: "com.typo.app",
      source: "typed",
      assigned: "com.djdl.app",
      mismatch: true,
      ambiguous: false,
    };
    let reads = 0;
    bootWith(PAGE, {
      [VIEW_PATH]: () => {
        reads += 1;
        return mismatched;
      },
      [`POST ${VIEW_PATH}/settings/app-store/use-assigned`]: () =>
        apiError(
          409,
          "bad_request",
          { reason: "no_assigned_app" },
          "no app is assigned to this product on this store",
        ),
    });
    await userEvent.click(
      await screen.findByRole("button", { name: "Use the assigned app" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Use the assigned app" }),
    );
    await within(dialog).findByText("No app is assigned");
    await waitFor(() => expect(reads).toBeGreaterThan(1));
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
      within(callout)
        .getByRole("link", { name: "Open channel credentials" })
        .getAttribute("href"),
    ).toBe(r.credentials("djdl"));
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

/** A-28.7 chain merge: A-20.7's channel scope and A-28's identity attention share this page. */
const scoped = (ids: string[]) => ({
  "/manage/api/products/djdl": {
    product: {
      ...productRow("djdl", "DJDL", ALL_ON),
      channels: ids.map((id) => ({
        id,
        label: id,
        inScope: true,
        delivery: "not_set_up",
        notUsing: false,
      })),
      platforms: [
        {
          platform: "windows",
          arches: ["x64"],
          formats: ["zip"],
          sources: ["builds"],
        },
      ],
    },
  },
});
const mismatch = (assigned: string) => ({
  value: "typo",
  source: "typed" as const,
  assigned,
  mismatch: true,
  ambiguous: false,
});

describe("identity attention follows the channel scope (chain merge)", () => {
  it("an in-scope mismatched store is not ready and raises an attention", async () => {
    const v = view();
    v.identity.steam = mismatch("480");
    v.setup.steam = { configured: true, credential: "cred", reason: null };
    bootWith(PAGE, {
      ...scoped(["polaris-key", "steam"]),
      [VIEW_PATH]: v,
    });
    expect(await screen.findByText("Steam app mismatch")).toBeTruthy();
    expect((await row("Steam")).getByText("App mismatch")).toBeTruthy();
    expect(screen.queryByText(/storefronts? ready\./)).toBeNull();
  });

  it("an out-of-scope store with a mismatch has no row, no attention, and is not counted", async () => {
    const v = view();
    v.identity["app-store"] = mismatch("com.djdl.app");
    v.setup.steam = { configured: true, credential: "cred", reason: null };
    bootWith(PAGE, {
      ...scoped(["polaris-key", "steam"]),
      [VIEW_PATH]: v,
    });
    expect(await screen.findByText("1 storefront ready.")).toBeTruthy();
    expect((await rows()).queryByText("App Store")).toBeNull();
    expect(screen.queryByText("App Store app mismatch")).toBeNull();
  });

  it("an in-scope healthy store is counted ready, and out-of-scope ready stores are not", async () => {
    bootWith(PAGE, {
      ...scoped(["polaris-key", "app-store"]),
      [VIEW_PATH]: view(),
    });
    expect(await screen.findByText("1 storefront ready.")).toBeTruthy();
    expect((await row("App Store")).getByText("Ready")).toBeTruthy();
    expect((await rows()).queryByText("Google Play")).toBeNull();
  });
});
