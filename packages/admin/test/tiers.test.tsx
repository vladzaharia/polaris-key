/**
 * License → Tiers and the tier record (ADMIN.md §6.5.3) through the whole console: Used by
 * (TIR-2), profile links (TIR-9), rows that open the record (TIR-5), the one-pane create drawer
 * (TIR-8), nullable numbers sent as null (TIR-1), client checks (TIR-3), minimal patches
 * (TIR-4) and delete gated on use.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
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
const table = () => screen.findByRole("table", { name: "Tiers" });
const row = (t: HTMLElement, name: string) =>
  within(t).getByText(name).closest("tr")!;

describe("Tiers", () => {
  it("lists label, id, profile link, term, limit and how many licenses use each tier", async () => {
    bootLicense("#/p/djdl/license/tiers");
    const t = await table();
    await within(t).findByText("Pro");
    const pro = row(t, "Pro");
    expect(within(pro).getByText("pro")).toBeTruthy();
    expect(
      within(pro).getByRole("link", { name: "Base" }).getAttribute("href"),
    ).toBe("#/p/djdl/config/profiles/base");
    expect(within(pro).getByText("365-day term")).toBeTruthy();
    expect(within(pro).getByText("5")).toBeTruthy();
    // Used by: two licenses are on Pro in the fixture (TIR-2), linked to the filtered list.
    await waitFor(() =>
      expect(
        within(pro).getByRole("link", { name: "2" }).getAttribute("href"),
      ).toBe("#/p/djdl/license/licenses?tier=pro"),
    );
    expect(within(row(t, "Trial")).getByText("No term")).toBeTruthy();
    expect(within(row(t, "Trial")).getByText("Product default")).toBeTruthy();
    // The row opens the record (TIR-5).
    expect(
      within(pro).getByRole("link", { name: "Pro" }).getAttribute("href"),
    ).toBe("#/p/djdl/license/tiers/pro");
  });

  it("disables delete with its reason while used, and deletes an unused tier behind L2", async () => {
    const log = bootLicense("#/p/djdl/license/tiers");
    const t = await table();
    await waitFor(() =>
      expect(
        within(row(t, "Pro")).getByRole("link", { name: "2" }),
      ).toBeTruthy(),
    );
    await userEvent.click(
      within(row(t, "Pro")).getByRole("button", { name: "Actions for Pro" }),
    );
    const del = await screen.findByRole("menuitem", { name: /Delete/ });
    expect(del.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Used by 2 licenses")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(
      within(row(t, "Trial")).getByRole("button", {
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
    const t = await table();
    await within(t).findByText("Trial");
    await userEvent.click(
      within(row(t, "Trial")).getByRole("button", {
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
    await table();
    await userEvent.click(
      screen.getAllByRole("button", { name: "New tier" })[0]!,
    );
    const drawer = await screen.findByRole("dialog", { name: "New tier" });
    expect(within(drawer).queryByRole("tab")).toBeNull();
    await userEvent.type(within(drawer).getByLabelText(/^Id/), "team");
    await userEvent.type(within(drawer).getByLabelText(/^Label/), "Team");
    await userEvent.type(within(drawer).getByLabelText(/^Device limit/), "10");
    const channels = within(drawer)
      .getAllByRole("group", { name: "Release channels" })
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

  it("refuses a taken or malformed id, and a zero device limit, before sending", async () => {
    const log = bootLicense("#/p/djdl/license/tiers");
    await table();
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
      within(drawer).getByText(/whole number of devices, 1 or more/),
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

  it("shows the first-run state, the error state, and no results", async () => {
    bootLicense("#/p/djdl/license/tiers", {
      routes: { [TIERS]: { tiers: [] } },
    });
    expect(await screen.findByText("No tiers yet")).toBeTruthy();
    cleanup();
    resetConsole();
    bootLicense("#/p/djdl/license/tiers", {
      routes: { [TIERS]: failing(500) },
    });
    expect(await screen.findByRole("button", { name: /Retry/ })).toBeTruthy();
    cleanup();
    resetConsole();
    bootLicense("#/p/djdl/license/tiers?q=zzz");
    expect(
      await screen.findByText("No tiers match these filters"),
    ).toBeTruthy();
  });

  it("passes axe", async () => {
    bootLicense("#/p/djdl/license/tiers");
    const t = await table();
    await within(t).findByText("Pro");
    const results = await axe(document.body);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("tier record", () => {
  const REC = "#/p/djdl/license/tiers/pro";

  async function form() {
    await screen.findByRole("heading", { level: 1, name: "Pro" });
    return screen.findByRole("form", { name: "Tier" });
  }

  it("clears numbers and the profile as null, and sends only what changed (TIR-1, TIR-4)", async () => {
    const log = bootLicense(REC);
    const f = await form();
    await userEvent.clear(within(f).getByLabelText(/^Device limit/));
    await userEvent.clear(within(f).getByLabelText(/^Term/));
    await userEvent.click(within(f).getByLabelText(/^Profile/));
    await userEvent.click(
      await screen.findByRole("option", { name: "No profile" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save tier" }));
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
    await userEvent.click(screen.getByRole("button", { name: "Save tier" }));
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
      .getAllByRole("group", { name: "Release channels" })
      .at(-1)!;
    expect(within(group).getByText("Not offered")).toBeTruthy();
    await userEvent.click(within(group).getByLabelText("dev"));
    await userEvent.click(screen.getByRole("button", { name: "Save tier" }));
    await waitFor(() => expect(writes(log)).toHaveLength(1));
    expect((writes(log)[0]!.body as { channels: string[] }).channels).toEqual([
      "stable",
      "Legacy.X",
    ]);
  });

  it("lists the licenses on the tier under Used by", async () => {
    bootLicense(`${REC}/used-by`);
    const t = await screen.findByRole("table", {
      name: "Licenses on this tier",
    });
    expect(await within(t).findByText("Ada Lovelace")).toBeTruthy();
    expect(within(t).queryByText("Lab 3")).toBeNull();
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
    expect(
      await screen.findByRole("heading", { level: 1, name: "Tier not found" }),
    ).toBeTruthy();
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
    await table();
    await userEvent.click(
      screen.getAllByRole("button", { name: "New tier" })[0]!,
    );
    const drawer = await screen.findByRole("dialog", { name: "New tier" });
    return within(drawer)
      .getAllByRole("group", { name: "Release channels" })
      .at(-1)!;
  }

  it("offers neither dev nor staging on create for a product with no manual channels", async () => {
    const group = await openCreate();
    for (const name of ["stable", "beta", "pr"])
      expect(within(group).getByLabelText(name)).toBeTruthy();
    expect(within(group).queryByLabelText("dev")).toBeNull();
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
    expect(within(group).queryByLabelText("dev")).toBeNull();
    expect(within(group).queryByLabelText("Nightly")).toBeNull();
    expect(within(group).getByText("Every PR build")).toBeTruthy();
  });
});
