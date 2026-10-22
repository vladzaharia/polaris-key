/**
 * License → Tiers: the list beside the open tier's record (ADMIN.md §6.5.3) through the whole console: Used by
 * (TIR-2), profile links (TIR-9), rows that open the record (TIR-5), the one-pane create drawer
 * (TIR-8), nullable numbers sent as null (TIR-1), client checks (TIR-3), minimal patches
 * (TIR-4) and delete gated on use.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resetConsole } from "./consoleHarness.js";
import {
  API,
  PRO,
  axe,
  bootLicense,
  failing,
  writes,
} from "./licenseFixture.js";

beforeEach(resetConsole);
afterEach(cleanup);

const TIERS = `${API}/license/tiers`;
const list = () => screen.findByRole("navigation", { name: "Tiers" });
const item = (l: HTMLElement, name: string) =>
  within(l).getByText(name).closest("li")!;

describe("Tiers", () => {
  it("lists each tier with its license count beside the open tier's record", async () => {
    bootLicense("#/p/djdl/license/tiers");
    const l = await list();
    await within(l).findByText("Pro");
    await waitFor(() =>
      expect(within(item(l, "Pro")).getByText("2 licenses")).toBeTruthy(),
    );
    // Rows open the tier (TIR-5); the first tier is open by default.
    const pro = within(item(l, "Pro")).getByRole("link", { name: /Pro/ });
    expect(pro.getAttribute("href")).toBe("#/p/djdl/license/tiers/pro");
    expect(pro.getAttribute("aria-current")).toBe("page");
    expect(await screen.findByRole("form", { name: "Tier" })).toBeTruthy();
    // Used by links to the filtered list (TIR-2).
    expect(
      screen
        .getByRole("link", { name: "Used by 2 licenses" })
        .getAttribute("href"),
    ).toBe("#/p/djdl/license/licenses?tier=pro");
  });

  it("shows a Duration, Limits and Profile record for the open tier", async () => {
    bootLicense("#/p/djdl/license/tiers/trial");
    const f = await screen.findByRole("form", { name: "Tier" });
    for (const g of ["Duration", "Limits", "Profile"])
      expect(within(f).getByRole("heading", { name: g })).toBeTruthy();
    expect(
      within(f).queryByText(/Offline days|Includes|Fingerprint/),
    ).toBeNull();
  });

  it("disables delete with its reason while used, and deletes an unused tier behind L2", async () => {
    const log = bootLicense("#/p/djdl/license/tiers");
    const l = await list();
    await waitFor(() =>
      expect(within(item(l, "Pro")).getByText("2 licenses")).toBeTruthy(),
    );
    await userEvent.click(
      within(item(l, "Pro")).getByRole("button", { name: "Actions for Pro" }),
    );
    const del = await screen.findByRole("menuitem", { name: /Delete/ });
    expect(del.getAttribute("aria-disabled")).toBe("true");
    expect(within(del).getByText("Used by 2 licenses")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(
      within(item(l, "Trial")).getByRole("button", {
        name: "Actions for Trial",
      }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Delete/ }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete tier “Trial”?")).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete tier" }),
    );
    await waitFor(() =>
      expect(writes(log)).toEqual([
        { path: `${TIERS}/trial`, method: "DELETE" },
      ]),
    );
  });

  it("says a 409 on delete in the dialog", async () => {
    bootLicense("#/p/djdl/license/tiers", {
      routes: {
        [`DELETE ${TIERS}/trial`]: new Response(
          JSON.stringify({ error: "bad_request", references: 3 }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      },
    });
    const l = await list();
    await within(l).findByText("Trial");
    await userEvent.click(
      within(item(l, "Trial")).getByRole("button", {
        name: "Actions for Trial",
      }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Delete/ }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete tier" }),
    );
    expect(
      await within(dialog).findByText("Licenses are on this tier"),
    ).toBeTruthy();
  });

  it("creates a tier from a one-pane drawer, omitting blank numbers", async () => {
    const log = bootLicense("#/p/djdl/license/tiers");
    await list();
    await userEvent.click(
      screen.getAllByRole("button", { name: "New tier" })[0]!,
    );
    const drawer = await screen.findByRole("dialog", { name: "New tier" });
    expect(within(drawer).queryByRole("tab")).toBeNull();
    await userEvent.type(within(drawer).getByLabelText(/^Id/), "team");
    await userEvent.type(within(drawer).getByLabelText(/^Label/), "Team");
    await userEvent.type(within(drawer).getByLabelText(/^Device limit/), "10");
    const channels = within(drawer)
      .getAllByRole("group", { name: "Release tracks" })
      .at(-1)!;
    await userEvent.click(within(channels).getByLabelText("stable"));
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Create tier" }),
    );
    await waitFor(() =>
      expect(writes(log)).toEqual([
        {
          path: TIERS,
          method: "POST",
          body: {
            id: "team",
            label: "Team",
            channels: ["stable"],
            policyDeviceLimit: 10,
          },
        },
      ]),
    );
  });

  it("asks before Escape drops a typed tier (C-29)", async () => {
    bootLicense("#/p/djdl/license/tiers");
    await list();
    await userEvent.click(
      screen.getAllByRole("button", { name: "New tier" })[0]!,
    );
    const drawer = await screen.findByRole("dialog", { name: "New tier" });
    await userEvent.type(within(drawer).getByLabelText(/^Id/), "team");
    fireEvent.keyDown(drawer, { key: "Escape" });
    expect((await within(drawer).findByRole("alert")).textContent).toContain(
      "Discard your changes?",
    );
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Keep editing" }),
    );
    expect(
      (within(drawer).getByLabelText(/^Id/) as HTMLInputElement).value,
    ).toBe("team");
  });

  it("refuses a taken or malformed id, and a zero device limit, before sending", async () => {
    const log = bootLicense("#/p/djdl/license/tiers");
    await list();
    await userEvent.click(
      screen.getAllByRole("button", { name: "New tier" })[0]!,
    );
    const drawer = await screen.findByRole("dialog", { name: "New tier" });
    await userEvent.type(within(drawer).getByLabelText(/^Id/), "pro");
    await userEvent.type(within(drawer).getByLabelText(/^Device limit/), "0");
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Create tier" }),
    );
    expect(
      await within(drawer).findByText("A tier with this id already exists."),
    ).toBeTruthy();
    expect(
      within(drawer).getByText(/whole number of devices from 1 to 1000/),
    ).toBeTruthy();
    const id = within(drawer).getByLabelText(/^Id/);
    await userEvent.clear(id);
    await userEvent.type(id, "Bad Id");
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Create tier" }),
    );
    expect(
      await within(drawer).findByText(/Use lowercase letters/),
    ).toBeTruthy();
    expect(writes(log)).toEqual([]);
  });

  it("shows the first-run state and the error state", async () => {
    bootLicense("#/p/djdl/license/tiers", {
      routes: { [TIERS]: { tiers: [] } },
    });
    expect(await screen.findByText("No tiers yet")).toBeTruthy();
    cleanup();
    resetConsole();
    bootLicense("#/p/djdl/license/tiers", {
      routes: { [TIERS]: failing(500) },
    });
    expect(
      await screen.findByRole("button", { name: /Try again/ }),
    ).toBeTruthy();
  });

  it("passes axe", async () => {
    bootLicense("#/p/djdl/license/tiers");
    const l = await list();
    await within(l).findByText("Pro");
    await screen.findByRole("form", { name: "Tier" });
    const results = await axe(document.body);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("tier record", () => {
  const REC = "#/p/djdl/license/tiers/pro";

  async function form() {
    await screen.findByRole("heading", { level: 2, name: "Pro" });
    return screen.findByRole("form", { name: "Tier" });
  }

  it("clears numbers and the profile as null, and sends only what changed (TIR-1, TIR-4)", async () => {
    const log = bootLicense(REC);
    const f = await form();
    await userEvent.clear(within(f).getByLabelText(/^Devices/));
    await userEvent.clear(within(f).getByLabelText(/^Runs for/));
    await userEvent.click(
      within(f).getByRole("combobox", { name: /^Profile/ }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "No profile" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save Pro" }));
    await waitFor(() =>
      expect(writes(log)).toEqual([
        {
          path: `${TIERS}/pro`,
          method: "PATCH",
          body: {
            profile: null,
            policyExpiryDays: null,
            policyDeviceLimit: null,
          },
        },
      ]),
    );
  });

  it("checks min ≤ max on the client (TIR-3)", async () => {
    const log = bootLicense(REC);
    const f = await form();
    await userEvent.type(within(f).getByLabelText(/^Maximum version/), "0.9.0");
    await userEvent.click(screen.getByRole("button", { name: "Save Pro" }));
    expect(await within(f).findByText(/maximum version must be/)).toBeTruthy();
    expect(writes(log)).toEqual([]);
  });

  it("removes a held dev grant and keeps a held value the picker doesn't offer", async () => {
    const log = bootLicense(REC, {
      routes: {
        [TIERS]: {
          tiers: [{ ...PRO, channels: ["stable", "dev", "Legacy.X"] }],
        },
      },
    });
    const f = await form();
    const group = within(f)
      .getAllByRole("group", { name: "Release tracks" })
      .at(-1)!;
    expect(within(group).getByText("Not offered")).toBeTruthy();
    await userEvent.click(within(group).getByLabelText("dev"));
    await userEvent.click(screen.getByRole("button", { name: "Save Pro" }));
    await waitFor(() => expect(writes(log)).toHaveLength(1));
    expect((writes(log)[0]!.body as { channels: string[] }).channels).toEqual([
      "stable",
      "Legacy.X",
    ]);
  });

  it("says how many licenses a change reaches, and asks before leaving it", async () => {
    bootLicense(REC);
    const f = await form();
    await screen.findByRole("link", { name: "Used by 2 licenses" });
    await userEvent.type(within(f).getByLabelText(/^Label/), "x");
    const bar = await screen.findByRole("region", { name: /Unsaved changes/ });
    expect(within(bar).getByText("1 change. Reaches 2 licenses.")).toBeTruthy();
    await userEvent.click(
      within(await list()).getByRole("link", { name: /Trial/ }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Discard 1 change to Pro?")).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Keep editing" }),
    );
    expect(window.location.hash).toBe(REC);
  });

  it("counts the invalid fields in the save bar", async () => {
    bootLicense(REC);
    const f = await form();
    await userEvent.clear(within(f).getByLabelText(/^Runs for/));
    await userEvent.type(within(f).getByLabelText(/^Runs for/), "0");
    await userEvent.click(screen.getByRole("button", { name: "Save Pro" }));
    expect(await screen.findByText(/Fix 1 field/)).toBeTruthy();
  });

  it("disables Delete with the reason while the tier is used", async () => {
    bootLicense(REC);
    await form();
    await waitFor(() =>
      expect(screen.getByText(/Used by 2 licenses/)).toBeTruthy(),
    );
    await userEvent.click(
      screen.getAllByRole("button", { name: "More actions" })[0]!,
    );
    const del = await screen.findByRole("menuitem", { name: /Delete tier/ });
    expect(del.getAttribute("aria-disabled")).toBe("true");
  });

  it("says a tier that doesn't exist is not found", async () => {
    bootLicense("#/p/djdl/license/tiers/nope");
    expect(await screen.findByText("This tier doesn't exist")).toBeTruthy();
  });

  it("passes axe", async () => {
    bootLicense(REC);
    await form();
    const results = await axe(document.body);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("tier channel picker", () => {
  const channelRows = (names: string[]) => ({
    releases: [],
    channels: names.map((channel) => ({
      channel,
      releaseId: "v1",
      modifiedAt: null,
    })),
  });

  async function openCreate(routes: Record<string, unknown> = {}) {
    bootLicense("#/p/djdl/license/tiers", { routes });
    await list();
    await userEvent.click(
      screen.getAllByRole("button", { name: "New tier" })[0]!,
    );
    const drawer = await screen.findByRole("dialog", { name: "New tier" });
    return within(drawer)
      .getAllByRole("group", { name: "Release tracks" })
      .at(-1)!;
  }

  it("offers dev with its hint, and not staging, on create for a product with no manual channels", async () => {
    const group = await openCreate();
    for (const name of ["stable", "beta", "dev", "pr"])
      expect(within(group).getByLabelText(name)).toBeTruthy();
    expect(
      within(group).getByText("Skips the version window and channel checks"),
    ).toBeTruthy();
    expect(within(group).queryByLabelText("staging")).toBeNull();
  });

  it("drops reserved and non-canonical manual names; a manual staging is listed once", async () => {
    const group = await openCreate({
      [`${API}/release/releases`]: channelRows([
        "stable",
        "beta",
        "dev",
        "pr",
        "Nightly",
        "staging",
      ]),
    });
    await waitFor(() =>
      expect(within(group).getAllByLabelText("staging")).toHaveLength(1),
    );
    // The reserved `dev` row is the built-in option, once, never a second manual one.
    expect(within(group).getAllByLabelText("dev")).toHaveLength(1);
    expect(within(group).queryByLabelText("Nightly")).toBeNull();
    expect(within(group).getByText("Every PR build")).toBeTruthy();
  });
});
