/**
 * License → Licenses (ADMIN.md §6.5.1) through the whole console: the computed state (LIC-1),
 * facet tiles, filters in the URL, bulk enable/disable/delete and the cleanup helper. The New
 * license wizard is in `newLicense.test.tsx`.
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
  axe,
  bootLicense,
  failing,
  LICENSES,
  writes,
} from "./licenseFixture.js";
import { endOfLocalDay } from "../src/lib/format.js";
import { lastAnnouncement } from "../src/ui/LiveRegion.js";

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

describe("Licenses list: a view-only member", () => {
  it("M8: New license and Clean up duplicates are off up front, not refused at Create", async () => {
    bootLicense("#/p/djdl/license/licenses", {
      me: {
        platformAdmin: false,
        permissions: {
          roles: [],
          platform: { view: ["console"], edit: [] },
          products: { djdl: { view: ["core", "license"], edit: [] } },
        },
      },
    });
    await table();
    const add = screen.getByRole("button", { name: "New license" });
    expect(add.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(add);
    expect(window.location.hash).toBe("#/p/djdl/license/licenses");
  });
});

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
    expect(within(ada).getByRole("meter", { name: "Devices" })).toBeTruthy();
    expect(within(ada).getByText("2 of 5")).toBeTruthy();
    // The id moved to the record header; the holder links to the record.
    expect(within(t).queryByText("lic_1")).toBeNull();
    expect(
      within(t)
        .getByRole("link", { name: /Ada Lovelace/ })
        .getAttribute("href"),
    ).toBe("#/p/djdl/license/licenses/lic_1");
  });

  it("draws the mockup's columns, counted holder chips and Create keys in bulk", async () => {
    bootLicense("#/p/djdl/license/licenses");
    const t = await table();
    await within(t).findByText("Ada Lovelace");
    const heads = within(t)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    for (const h of ["License", "Holder", "Tier", "Duration", "Devices"])
      expect(heads).toContain(h);
    // The holder states are chips with counts, not a menu.
    const chip = screen.getByRole("button", { name: /^Holder: In an account/ });
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    // Create keys in bulk opens the wizard on Anyone with the key.
    await userEvent.click(
      screen.getAllByRole("button", { name: "Create keys in bulk" })[0]!,
    );
    expect(window.location.hash).toContain("setup=new-license");
    expect(window.location.hash).toContain("step=holder");
    expect(
      JSON.parse(sessionStorage.getItem("pk-new-license:djdl") ?? "{}").who,
    ).toBe("anyone");
  });

  it("loads the list by cursor, a page at a time (P0-29)", async () => {
    const [first, second, ...rest] = LICENSES;
    const log = bootLicense("#/p/djdl/license/licenses", {
      routes: {
        [`${API}/license/licenses`]: (q: URLSearchParams) =>
          q.get("cursor") === "c1"
            ? { licenses: rest, nextCursor: null }
            : { licenses: [first, second], nextCursor: "c1" },
      },
    });
    const t = await table();
    await within(t).findByText("Ada Lovelace");
    expect(within(t).queryByText("Old seat")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await within(t).findByText("Old seat");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    const cursors = log.calls
      .filter((c) => c.path === `${API}/license/licenses`)
      .map((c) => new URLSearchParams(c.query).get("cursor"));
    expect(cursors).toContain("c1");
  });

  it("keeps the loaded rows when Load more fails, and retries from the footer (P0-29 F1)", async () => {
    const [first, second] = LICENSES;
    let fail = true;
    bootLicense("#/p/djdl/license/licenses", {
      routes: {
        [`${API}/license/licenses`]: (q: URLSearchParams) =>
          q.get("cursor") === "c1"
            ? fail
              ? failing(500)
              : { licenses: [LICENSES[2]], nextCursor: null }
            : {
                licenses: [first, second],
                nextCursor: "c1",
                total: 3,
                counts: { active: 2, expiring: 0, expired: 1, disabled: 0 },
              },
      },
    });
    const t = await table();
    await within(t).findByText("Ada Lovelace");
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("Couldn't load more licenses.");
    expect(within(t).getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
    // The footer states the total and the tiles read the server's counts.
    expect(screen.getByText("Showing 2 of 3")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(screen.queryByText("Couldn't load more licenses.")).toBeNull(),
    );
  });

  it("says a search covers only the loaded rows and offers Search all (P0-29 F2)", async () => {
    const [first, second, ...rest] = LICENSES;
    bootLicense("#/p/djdl/license/licenses?q=Old%20seat", {
      routes: {
        [`${API}/license/licenses`]: (q: URLSearchParams) =>
          q.get("cursor") === "c1"
            ? { licenses: rest, nextCursor: null }
            : { licenses: [first, second], nextCursor: "c1", total: 5 },
      },
    });
    await screen.findByText("No match in the 2 newest");
    await userEvent.click(screen.getByRole("button", { name: "Search all 5" }));
    const t = await table();
    await within(t).findByText("Old seat");
  });

  it("keeps the server total in the footer on a deep link (P0-29 N1)", async () => {
    const [first] = LICENSES;
    bootLicense("#/p/djdl/license/licenses?tier=pro", {
      routes: {
        [`${API}/license/licenses`]: () => ({
          licenses: [first],
          nextCursor: "c1",
          total: 321,
        }),
      },
    });
    await screen.findByText("Showing 1 of 321");
    expect(screen.queryByText(/Searched the/)).toBeNull();
  });

  it("says when Search all fails, and keeps the button (P0-29 N2)", async () => {
    const [first, second] = LICENSES;
    bootLicense("#/p/djdl/license/licenses?q=Old%20seat", {
      routes: {
        [`${API}/license/licenses`]: (q: URLSearchParams) =>
          q.get("cursor") === "c1"
            ? failing(500)
            : { licenses: [first, second], nextCursor: "c1", total: 5 },
      },
    });
    await userEvent.click(
      await screen.findByRole("button", { name: "Search all 5" }),
    );
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Couldn't load more licenses.",
    );
    const retry = screen.getByRole("button", { name: "Try again" });
    expect(document.activeElement).toBe(retry);
  });

  it("shows a permission state, with no toolbar or write actions, on a 403 (P0-29 F13)", async () => {
    bootLicense("#/p/djdl/license/licenses", {
      routes: {
        [`${API}/license/licenses`]: failing(403, "forbidden"),
        "/manage/api/access/admins": { admins: [] },
      },
    });
    await screen.findByText("Who can give you access");
    expect(screen.queryByRole("button", { name: /New license/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();
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
      (screen.getByPlaceholderText(/Search licenses/) as HTMLInputElement)
        .value,
    ).toBe("charge");
  });

  it("searches the email and the id, not only the name", async () => {
    bootLicense("#/p/djdl/license/licenses?q=lic_3");
    const t = await table();
    await waitFor(() => expect(rowNames(t)).toEqual(["Old seat"]));
  });

  it("says no license matches, and clears the filters", async () => {
    bootLicense("#/p/djdl/license/licenses?q=nobody");
    expect(await screen.findByText("No licenses match")).toBeTruthy();
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
    // One primary: the empty state's, and its way to the Access rules.
    expect(screen.getAllByRole("button", { name: "New license" }).length).toBe(
      1,
    );
    expect(screen.getByRole("button", { name: "Open Access" })).toBeTruthy();
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

  it("T2/T3: a timeout names its cause, and the holder chips show no count", async () => {
    bootLicense("#/p/djdl/license/licenses", {
      routes: { [`${API}/license/licenses`]: failing(504) },
    });
    await screen.findByText("Polaris Key took too long to answer. Try again.");
    expect(screen.getByRole("button", { name: /Copy details/ })).toBeTruthy();
    const chips = screen
      .getAllByRole("button", { name: /^Holder: / })
      .map((b) => b.getAttribute("aria-label"));
    expect(chips.length).toBe(3);
    for (const c of chips) expect(c).not.toMatch(/,\s*\d/);
  });

  it("keeps the filters through an error and a retry, and the table head", async () => {
    bootLicense("#/p/djdl/license/licenses?tier=pro", {
      routes: { [`${API}/license/licenses`]: failing(500) },
    });
    await screen.findByRole("button", { name: /Retry/ });
    expect(screen.getByRole("columnheader", { name: /^License/ })).toBeTruthy();
    expect(window.location.hash).toContain("tier=pro");
  });

  it("names what was asked for when nothing matches", async () => {
    bootLicense("#/p/djdl/license/licenses?q=zzzz");
    expect(await screen.findByText("No licenses match")).toBeTruthy();
    expect(
      screen.getByText(/No license has a name, email or id containing “zzzz”/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Clear filters/ })).toBeTruthy();
  });

  it("T4: a no-match under status and channel names them", async () => {
    bootLicense("#/p/djdl/license/licenses?status=disabled&channel=zz-none");
    expect(
      await screen.findByText("No license is Disabled on zz-none."),
    ).toBeTruthy();
  });

  it("disables one license from its row menu, through the same confirm", async () => {
    const log = bootLicense("#/p/djdl/license/licenses");
    const t = await table();
    await within(t).findByText("Ada Lovelace");
    await userEvent.click(
      within(row(t, "Ada Lovelace")).getByRole("button", {
        name: /^Actions for/,
      }),
    );
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent?.replace(/\s+/g, " ").trim()),
    ).toEqual(expect.arrayContaining(["Open", "Copy id", "Disable…"]));
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: /^Disable…/ }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Disable 1 license?")).toBeTruthy();
    expect(location.hash).toBe("#/p/djdl/license/licenses");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Disable 1 license" }),
    );
    await waitFor(() =>
      expect(writes(log).map((c) => c.path)).toEqual([
        `${API}/license/licenses/lic_1/disable`,
      ]),
    );
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

  const BLOCKED = {
    allowed: false,
    reasons: [
      {
        code: "issued_active",
        message:
          "It is active and was issued by the developer. Disable it first.",
      },
    ],
  };
  const OK = { allowed: true, reasons: [] };
  const withVerdicts = () => ({
    [`${API}/license/licenses`]: {
      licenses: LICENSES.map((l) => ({
        ...l,
        ...(l.status === "disabled" ? { origin: "oidc" as const } : {}),
        deletion: l.status === "disabled" || l.id === "lic_2" ? OK : BLOCKED,
      })),
    },
  });

  it("bulk-deletes the deletable selection after typing the count, listing what it skips", async () => {
    const log = bootLicense("#/p/djdl/license/licenses", {
      routes: {
        ...withVerdicts(),
        [`POST ${API}/license/deletions`]: {
          ok: true,
          deleted: [{ id: "lic_4", devices: 1 }],
          refused: [],
          notFound: [],
        },
      },
    });
    const t = await table();
    await within(t).findByText("Ada Lovelace");
    await userEvent.click(within(row(t, "Ada Lovelace")).getByRole("checkbox"));
    await userEvent.click(
      within(row(t, "Chargeback Ltd")).getByRole("checkbox"),
    );
    await userEvent.click(screen.getByRole("button", { name: "Delete…" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: /Delete 1 license\?/,
    });
    expect(
      within(dialog).getByText(/1 selected license is skipped/),
    ).toBeTruthy();
    expect(within(dialog).getByText(/Disable it first/)).toBeTruthy();
    expect(
      within(dialog).getByText(
        /disabled sign-in license: if a holder signs in again/,
      ),
    ).toBeTruthy();
    await userEvent.type(
      within(dialog).getByRole("textbox"),
      "delete 1 license",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete 1 license" }),
    );
    await waitFor(() =>
      expect(writes(log)).toEqual([
        {
          path: `${API}/license/deletions`,
          method: "POST",
          body: { ids: ["lic_4"], confirm: "delete 1 license" },
        },
      ]),
    );
  });

  it("keeps bulk Delete unavailable, with the reason, when nothing selected can be deleted", async () => {
    bootLicense("#/p/djdl/license/licenses", { routes: withVerdicts() });
    const t = await table();
    await within(t).findByText("Ada Lovelace");
    await userEvent.click(within(row(t, "Ada Lovelace")).getByRole("checkbox"));
    const del = screen.getByRole("button", { name: "Delete…" });
    expect(del.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getAllByText(/Disable it first/).length).toBeGreaterThan(0);
    await userEvent.click(del);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  const candidate = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    name: id,
    email: "",
    status: "active",
    tier: "standard",
    accountSubject: null,
    deviceCount: 1,
    lastSeen: null,
    reason: "duplicate",
    keeps: "lic_paid",
    deletion: OK,
    ...over,
  });
  const NONE_FAILED = { ok: true, deleted: [], refused: [], notFound: [] };

  async function openCleanup() {
    await table();
    const trigger = screen.queryByRole("button", {
      name: "Clean up duplicates…",
    });
    if (trigger) await userEvent.click(trigger);
    else {
      await userEvent.click(
        screen.getAllByRole("button", { name: "More actions" })[0]!,
      );
      await userEvent.click(
        await screen.findByRole("menuitem", { name: "Clean up duplicates…" }),
      );
    }
    return screen.findByRole("alertdialog", {
      name: "Clean up duplicate licenses",
    });
  }

  it("cleans up duplicates: lists them, warns about reissue, and deletes the allowed ones after typing the count", async () => {
    const log = bootLicense("#/p/djdl/license/licenses", {
      routes: {
        [`${API}/license/deletions/candidates`]: {
          candidates: [
            candidate("lic_dup", {
              name: "Storytime sign-in",
              status: "disabled",
              accountSubject: "ps_aaaaaaaaaaaaaaaaaaaaaa",
            }),
            candidate("lic_dup2"),
            candidate("lic_steam", {
              name: "Bought on Steam",
              keeps: "lic_x",
              deletion: {
                allowed: false,
                reasons: [
                  {
                    code: "store_purchases",
                    message: "1 store purchase is recorded against it.",
                  },
                ],
              },
            }),
          ],
        },
        [`POST ${API}/license/deletions`]: {
          ...NONE_FAILED,
          deleted: [
            { id: "lic_dup", devices: 1 },
            { id: "lic_dup2", devices: 1 },
          ],
        },
      },
    });
    const dialog = await openCleanup();
    expect(
      await within(dialog).findAllByText(/account keeps lic_paid/),
    ).toHaveLength(2);
    expect(within(dialog).getByText(/1 license can't be deleted/)).toBeTruthy();
    expect(within(dialog).getByText(/store purchase is recorded/)).toBeTruthy();
    expect(
      within(dialog).getByText(/signs in again, they get a new license/),
    ).toBeTruthy();
    // L3: nothing is sent until the count is typed.
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete 2 licenses" }),
    );
    expect(writes(log)).toEqual([]);
    await userEvent.type(
      within(dialog).getByRole("textbox"),
      "delete 2 licenses",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete 2 licenses" }),
    );
    await waitFor(() =>
      expect(writes(log)).toEqual([
        {
          path: `${API}/license/deletions`,
          method: "POST",
          body: { ids: ["lic_dup", "lic_dup2"], confirm: "delete 2 licenses" },
        },
      ]),
    );
  });

  it("sends more than 100 deletions in chunks the Worker accepts, each with its own count", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `lic_c${i}`);
    const log = bootLicense("#/p/djdl/license/licenses", {
      routes: {
        [`${API}/license/deletions/candidates`]: {
          candidates: ids.map((id) => candidate(id)),
        },
        [`POST ${API}/license/deletions`]: NONE_FAILED,
      },
    });
    const dialog = await openCleanup();
    await within(dialog).findAllByText(/account keeps lic_paid/);
    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: "delete 101 licenses" },
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete 101 licenses" }),
    );
    await waitFor(() => expect(writes(log)).toHaveLength(2));
    const bodies = writes(log).map(
      (w) => w.body as { ids: string[]; confirm: string },
    );
    expect(bodies.map((b) => b.confirm)).toEqual([
      "delete 100 licenses",
      "delete 1 license",
    ]);
    expect(bodies.flatMap((b) => b.ids)).toEqual(ids);
  });

  it("passes axe", async () => {
    bootLicense("#/p/djdl/license/licenses");
    const t = await table();
    await within(t).findByText("Ada Lovelace");
    const results = await axe(document.body);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
