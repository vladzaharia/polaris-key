/**
 * License → Licenses (ADMIN.md §6.5.1) through the whole console: the computed state (LIC-1),
 * facet tiles, filters in the URL, bulk enable/disable, the stepped Create license dialog
 * (LIC-2 to LIC-6, LIC-10) and the channel picker it shares with the license and tier forms.
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
import { API, axe, bootLicense, failing, writes } from "./licenseFixture.js";
import { endOfLocalDay } from "../src/lib/format.js";

beforeEach(resetConsole);
afterEach(cleanup);

const table = () => screen.findByRole("table", { name: "Licenses" });
const rowNames = (t: HTMLElement) =>
  within(t)
    .getAllByRole("row")
    .slice(1)
    .map(
      (r) =>
        within(r).queryAllByRole("link")[0]?.querySelector(".truncate")
          ?.textContent ?? "",
    );
const row = (t: HTMLElement, name: string) =>
  within(t).getByText(name).closest("tr")!;

describe("Licenses list", () => {
  it("shows every license with its computed state, tier, expiry and seats", async () => {
    bootLicense("#/p/djdl/license/licenses");
    const t = await table();
    await within(t).findByText("Ada Lovelace");
    expect(
      screen.getByRole("heading", { level: 1, name: "Licenses" }),
    ).toBeTruthy();
    // LIC-1: an expired license no longer reads as active.
    expect(within(row(t, "Old seat")).getByText("Expired")).toBeTruthy();
    expect(within(row(t, "Lab 3")).getByText(/Expires in 4 days/)).toBeTruthy();
    expect(within(row(t, "Chargeback Ltd")).getByText("Disabled")).toBeTruthy();
    // The tier's label, not its id; seats against the tier's limit.
    const ada = row(t, "Ada Lovelace");
    expect(within(ada).getByText("Pro")).toBeTruthy();
    expect(within(ada).getByRole("meter", { name: "Seats" })).toBeTruthy();
    expect(within(ada).getByText("2 of 5")).toBeTruthy();
    // The id moved to the record header; the holder links to the record.
    expect(within(t).queryByText("lic_1")).toBeNull();
    expect(
      within(t)
        .getByRole("link", { name: /Ada Lovelace/ })
        .getAttribute("href"),
    ).toBe("#/p/djdl/license/licenses/lic_1");
  });

  it("counts each state on a facet tile, and a tile filters the table through the URL", async () => {
    bootLicense("#/p/djdl/license/licenses");
    const t = await table();
    await within(t).findByText("Ada Lovelace");
    const expired = screen.getByRole("button", { name: /^Expired\s*1$/ });
    expect(expired.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(expired);
    await waitFor(() =>
      expect(window.location.hash).toContain("status=expired"),
    );
    await waitFor(() => expect(rowNames(t)).toEqual(["Old seat"]));
    expect(
      screen
        .getByRole("button", { name: /^Expired\s*1$/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await userEvent.click(
      screen.getByRole("button", { name: /^Expired\s*1$/ }),
    );
    await waitFor(() => expect(window.location.hash).not.toContain("status="));
  });

  it("restores search and facets from the URL", async () => {
    bootLicense("#/p/djdl/license/licenses?status=active,disabled&q=charge");
    const t = await table();
    await waitFor(() => expect(rowNames(t)).toEqual(["Chargeback Ltd"]));
    expect(
      (screen.getByPlaceholderText(/Search name/) as HTMLInputElement).value,
    ).toBe("charge");
  });

  it("searches the email and the id, not only the name", async () => {
    bootLicense("#/p/djdl/license/licenses?q=lic_3");
    const t = await table();
    await waitFor(() => expect(rowNames(t)).toEqual(["Old seat"]));
  });

  it("says no license matches, and clears the filters", async () => {
    bootLicense("#/p/djdl/license/licenses?q=nobody");
    expect(
      await screen.findByText("No licenses match these filters"),
    ).toBeTruthy();
    await userEvent.click(
      screen.getAllByRole("button", { name: /Clear filters/ })[0]!,
    );
    await waitFor(() => expect(window.location.hash).not.toContain("q="));
  });

  it("shows the first-run state when there are no licenses", async () => {
    bootLicense("#/p/djdl/license/licenses", {
      routes: { [`${API}/license/licenses`]: { licenses: [] } },
    });
    expect(await screen.findByText("No licenses yet")).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "Create license" }).length,
    ).toBe(2);
    expect(screen.queryByRole("button", { name: /^Expired/ })).toBeNull();
  });

  it("shows the error with a working retry", async () => {
    const log = bootLicense("#/p/djdl/license/licenses", {
      routes: { [`${API}/license/licenses`]: failing(500) },
    });
    const retry = await screen.findByRole("button", { name: /Retry/ });
    const reads = () =>
      log.calls.filter((c) => c.path === `${API}/license/licenses`).length;
    const before = reads();
    await userEvent.click(retry);
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it("disables the selected licenses after a caution confirm that lists the effect", async () => {
    const log = bootLicense("#/p/djdl/license/licenses");
    const t = await table();
    await within(t).findByText("Ada Lovelace");
    await userEvent.click(within(row(t, "Ada Lovelace")).getByRole("checkbox"));
    await userEvent.click(within(row(t, "Lab 3")).getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Disable…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Disable 2 licenses?")).toBeTruthy();
    expect(
      within(dialog).getByText(/stop authenticating right away/),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Disable 2 licenses" }),
    );
    await waitFor(() =>
      expect(writes(log).map((c) => c.path)).toEqual([
        `${API}/license/licenses/lic_1/disable`,
        `${API}/license/licenses/lic_2/disable`,
      ]),
    );
    // The declared invalidation refetches the list.
    await waitFor(() =>
      expect(
        log.calls.filter(
          (c) => c.method === "GET" && c.path === `${API}/license/licenses`,
        ).length,
      ).toBeGreaterThan(1),
    );
  });

  it("passes axe", async () => {
    bootLicense("#/p/djdl/license/licenses");
    const t = await table();
    await within(t).findByText("Ada Lovelace");
    const results = await axe(document.body);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("Create license", () => {
  async function open(routes: Record<string, unknown> = {}) {
    const log = bootLicense("#/p/djdl/license/licenses", { routes });
    await table();
    await userEvent.click(
      screen.getAllByRole("button", { name: "Create license" })[0]!,
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Create license",
    });
    return { log, dialog };
  }

  async function toTerms(dialog: HTMLElement) {
    await userEvent.type(
      within(dialog).getByLabelText(/^Name/),
      "Grace Hopper",
    );
    await userEvent.type(within(dialog).getByLabelText(/^Email/), "grace@x.io");
    await userEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    await within(dialog).findByText("Effective policy");
  }

  async function pick(dialog: HTMLElement, field: string, option: RegExp) {
    await userEvent.click(within(dialog).getByLabelText(field));
    await userEvent.click(await screen.findByRole("option", { name: option }));
  }

  it("shows every holder error on Next, so none is unreachable (LIC-10)", async () => {
    const { log, dialog } = await open();
    await userEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    expect(
      await within(dialog).findByText("Enter the holder's name."),
    ).toBeTruthy();
    expect(within(dialog).getByText("Enter the holder's email.")).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText(/^Name/), "Grace");
    await userEvent.type(within(dialog).getByLabelText(/^Email/), "bad-email");
    await userEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    expect(
      await within(dialog).findByText("Enter a valid email address."),
    ).toBeTruthy();
    expect(writes(log)).toEqual([]);
  });

  it("creates with every term and profiles in order, and shows the key once (LIC-2, LIC-3, LIC-5)", async () => {
    const { log, dialog } = await open();
    await toTerms(dialog);
    await pick(dialog, "Expiry", /On a date/);
    fireEvent.change(within(dialog).getByLabelText(/^Expires/), {
      target: { value: "2027-12-31" },
    });
    await userEvent.type(
      within(dialog).getByLabelText(/Max offline days/),
      "21",
    );
    await userEvent.click(within(dialog).getByLabelText("stable"));
    await userEvent.type(
      within(dialog).getByLabelText(/Minimum version/),
      "1.2.0",
    );
    await userEvent.type(
      within(dialog).getByLabelText(/Maximum version/),
      "2.0.0",
    );
    await pick(dialog, "Add profile", /Studio/);
    await pick(dialog, "Add profile", /Base/);
    expect(within(dialog).getByText("21 days")).toBeTruthy();

    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create license" }),
    );
    expect(await within(dialog).findByText("PK-NEWKEY-ONESHOT")).toBeTruthy();
    expect(writes(log)[0]!.body).toEqual({
      name: "Grace Hopper",
      email: "grace@x.io",
      // The end of that LOCAL day (LIC-5), not UTC midnight.
      expiresAt: Math.floor(endOfLocalDay("2027-12-31")! / 1000),
      maxOfflineDays: 21,
      channels: ["stable"],
      minVersion: "1.2.0",
      maxVersion: "2.0.0",
      profiles: ["studio", "base"],
    });

    // The key panel won't close uncopied: Escape asks first.
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(
      await within(dialog).findByText(/Close without copying\?/),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Keep it open" }),
    );
    await userEvent.click(within(dialog).getByLabelText(/I've stored this/));
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Open license" }),
    );
    await waitFor(() =>
      expect(window.location.hash).toBe("#/p/djdl/license/licenses/lic_new"),
    );
  });

  it("omits the expiry with a tier so its term applies, and names the tier's device limit (LIC-4)", async () => {
    const { log, dialog } = await open();
    await toTerms(dialog);
    await pick(dialog, "Tier", /Edu/);
    expect(within(dialog).getByText("180 days from today")).toBeTruthy();
    const policy = within(dialog).getByRole("region", {
      name: "Effective policy",
    });
    expect(within(policy).getByText("Device limit")).toBeTruthy();
    expect(within(policy).getAllByText(/\(tier “Edu”\)/).length).toBe(1);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create license" }),
    );
    await within(dialog).findByText("PK-NEWKEY-ONESHOT");
    expect(writes(log)[0]!.body).toEqual({
      name: "Grace Hopper",
      email: "grace@x.io",
      tier: "edu",
    });
  });

  it("sends an explicit null for No expiry", async () => {
    const { log, dialog } = await open();
    await toTerms(dialog);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create license" }),
    );
    await within(dialog).findByText("PK-NEWKEY-ONESHOT");
    expect(writes(log)[0]!.body).toEqual({
      name: "Grace Hopper",
      email: "grace@x.io",
      expiresAt: null,
    });
  });

  it("refuses an out-of-range offline window and an inverted version window", async () => {
    const { log, dialog } = await open();
    await toTerms(dialog);
    await userEvent.type(
      within(dialog).getByLabelText(/Max offline days/),
      "0",
    );
    await userEvent.type(
      within(dialog).getByLabelText(/Minimum version/),
      "2.0.0",
    );
    await userEvent.type(
      within(dialog).getByLabelText(/Maximum version/),
      "1.0.0",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create license" }),
    );
    expect(
      await within(dialog).findByText(/whole number of days from 1 to 365/),
    ).toBeTruthy();
    expect(within(dialog).getByText(/maximum version must be/)).toBeTruthy();
    expect(writes(log)).toEqual([]);
  });

  it("says a failed tier or profile lookup inline, not 'none defined' (LIC-6)", async () => {
    const { dialog } = await open({
      [`${API}/license/tiers`]: failing(500),
      [`${API}/config/profiles`]: failing(500),
    });
    await toTerms(dialog);
    expect(await within(dialog).findByText("Couldn't load tiers")).toBeTruthy();
    expect(within(dialog).getByText("Couldn't load profiles")).toBeTruthy();
    expect(within(dialog).queryByText(/has no profiles/)).toBeNull();
  });

  it("keeps the dialog open with the error when the create fails", async () => {
    const { dialog } = await open({
      [`POST ${API}/license/licenses`]: failing(500),
    });
    await toTerms(dialog);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create license" }),
    );
    expect(
      await within(dialog).findByText("The license wasn't created"),
    ).toBeTruthy();
    expect(within(dialog).queryByText("PK-NEWKEY-ONESHOT")).toBeNull();
  });
});

// ── The channel picker (P0-04, WIRE-CONTRACT-V3 §5.1) ─────────────────────────────────
describe("license channel picker", () => {
  const channelRows = (names: string[]) => ({
    releases: [],
    channels: names.map((channel) => ({
      channel,
      releaseId: "v1",
      modifiedAt: null,
    })),
  });

  async function openTerms(routes: Record<string, unknown> = {}) {
    bootLicense("#/p/djdl/license/licenses", { routes });
    await table();
    await userEvent.click(
      screen.getAllByRole("button", { name: "Create license" })[0]!,
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Create license",
    });
    await userEvent.type(within(dialog).getByLabelText(/^Name/), "G");
    await userEvent.type(within(dialog).getByLabelText(/^Email/), "g@x.io");
    await userEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    // The field's group wraps the picker's own group; both carry the label.
    await within(dialog).findAllByRole("group", { name: "Release channels" });
    return within(dialog)
      .getAllByRole("group", { name: "Release channels" })
      .at(-1)!;
  }

  it("offers neither dev nor staging on create for a product with no manual channels", async () => {
    const group = await openTerms();
    for (const name of ["stable", "beta", "pr"])
      expect(within(group).getByLabelText(name)).toBeTruthy();
    expect(within(group).queryByLabelText("dev")).toBeNull();
    expect(within(group).queryByLabelText("staging")).toBeNull();
  });

  it("drops reserved and non-canonical manual names; a manual staging is listed once", async () => {
    const group = await openTerms({
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
    expect(within(group).getAllByLabelText("pr")).toHaveLength(1);
    expect(within(group).getByText("Every PR build")).toBeTruthy();
    expect(
      within(group).getByText("Manual; the grant also covers beta"),
    ).toBeTruthy();
  });
});
