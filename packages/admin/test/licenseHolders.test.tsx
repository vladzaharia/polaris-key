/**
 * LX-30: the console's holder surfaces (notes/S-24 §8.8; ADMIN.md §6.5.1–§6.5.2) through the
 * whole console over a scripted backend:
 *
 *   - Licenses: the Holder cell for each state (in an account, waiting, floating), the Holder
 *     facet in the URL, the Batch column and facet, and the link to a filtered batch.
 *   - The record: the holder line for each state and its batch, PX-W9's key entries, Assign… on a
 *     floating licence, Edit holder with the name only, Reassign… and Make floating… (step-up,
 *     reason, the typed name or id, the request each sends), and the newest move's Undo….
 *   - The batch pages: the facts, "Keys can't be downloaded again", and Disable unused keys…
 *     typed with the batch label.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  LicenseBatch,
  LicenseDetail,
  LicenseHolderMove,
  LicenseSummary,
} from "../src/api.js";
import { resetConsole } from "./consoleHarness.js";
import {
  API,
  DETAIL,
  NOW_S,
  axe,
  bootLicense,
  summary,
  writes,
} from "./licenseFixture.js";

beforeEach(resetConsole);
afterEach(cleanup);

const DAY = 86_400;
const FRESH = { authAt: NOW_S - 30, stepUpMaxAgeSeconds: 300 };
const STALE = { authAt: NOW_S - 3600, stepUpMaxAgeSeconds: 300 };

const BATCH: LicenseBatch = {
  id: "batch_oct",
  label: "Steam keys, October",
  count: 50,
  tier: "pro",
  createdBy: "u1",
  createdAt: NOW_S - 5 * DAY,
  used: 12,
  unused: 37,
  disabled: 1,
};

const IN_ACCOUNT = summary("lic_in", {
  name: "Lena Ortiz",
  email: "lena@ortiz.audio",
  holder: { kind: "assigned", inAccount: true, email: "lena@ortiz.audio" },
  ownerSubject: "ps_BBBBBBBBBBBBBBBBBBBBBB",
});
const WAITING = summary("lic_wait", {
  name: "Sam Reyes",
  email: "sam@reyes.fm",
  holder: { kind: "assigned", inAccount: false, email: "sam@reyes.fm" },
  ownerSubject: null,
  keyEntries: { used: 3, limit: 10 },
});
const FLOATING = summary("lic_float", {
  name: "",
  email: "",
  holder: { kind: "floating" },
  ownerSubject: null,
  batchId: BATCH.id,
  keyEntries: { used: 12, limit: 10 },
});
const LIST: LicenseSummary[] = [IN_ACCOUNT, WAITING, FLOATING];

function detail(s: LicenseSummary): LicenseDetail {
  return { ...DETAIL, ...s, keys: DETAIL.keys, devices: DETAIL.devices };
}

const ROUTES = {
  [`${API}/license/licenses`]: { licenses: LIST },
  [`${API}/license/batches`]: { batches: [BATCH], nextCursor: null },
  [`${API}/license/batches/${BATCH.id}`]: BATCH,
  [`${API}/license/licenses/lic_in`]: detail(IN_ACCOUNT),
  [`${API}/license/licenses/lic_wait`]: detail(WAITING),
  [`${API}/license/licenses/lic_float`]: detail(FLOATING),
  [`${API}/users/licenses/lic_in/relinks`]: { relinks: [] },
  [`${API}/users/licenses/lic_wait/relinks`]: { relinks: [] },
  [`${API}/users/licenses/lic_float/relinks`]: { relinks: [] },
};

/** The Licenses table once the batch read has landed (the table remounts with its Batch column). */
async function table(withBatches = true): Promise<HTMLElement> {
  if (withBatches) await screen.findByRole("columnheader", { name: /Batch/ });
  return screen.findByRole("table", { name: "Licenses" });
}
const rowOf = (t: HTMLElement, text: string) =>
  within(t).getByText(text).closest("tr")!;
const rowNames = (t: HTMLElement) =>
  within(t)
    .getAllByRole("row")
    .slice(1)
    .map((r) => r.querySelector("[data-vt-shared]")?.textContent ?? "");

async function more(item: string) {
  await userEvent.click(
    screen.getAllByRole("button", { name: "More actions" })[0]!,
  );
  await userEvent.click(await screen.findByRole("menuitem", { name: item }));
}

describe("Licenses: the Holder column and filters", () => {
  it("shows each holder state: name and email, waiting, and Floating with anyone with the key", async () => {
    bootLicense("#/p/djdl/license/licenses", { routes: ROUTES });
    const t = await table();
    await within(t).findByText("Lena Ortiz");
    expect(
      within(rowOf(t, "Lena Ortiz")).getByText("lena@ortiz.audio"),
    ).toBeTruthy();
    expect(
      within(rowOf(t, "Sam Reyes")).getByText("Waiting for sam@reyes.fm"),
    ).toBeTruthy();
    const floating = rowOf(t, "anyone with the key");
    expect(within(floating).getByText("Floating")).toBeTruthy();
    // The batch label links to the batch page.
    const batch = within(floating).getByRole("link", {
      name: "Steam keys, October",
    });
    expect(batch.getAttribute("href")).toBe(
      "#/p/djdl/license/batches/batch_oct",
    );
  });

  it("filters by holder through the URL", async () => {
    bootLicense("#/p/djdl/license/licenses?holder=floating", {
      routes: ROUTES,
    });
    const t = await table();
    await waitFor(() => expect(rowNames(t)).toEqual(["Floating"]));
    cleanup();
    resetConsole();
    bootLicense("#/p/djdl/license/licenses?holder=inAccount,waiting", {
      routes: ROUTES,
    });
    const t2 = await table();
    await waitFor(() =>
      expect(rowNames(t2)).toEqual(["Lena Ortiz", "Sam Reyes"]),
    );
  });

  it("filters by batch and links to the batch it shows", async () => {
    bootLicense("#/p/djdl/license/licenses?batch=batch_oct", {
      routes: ROUTES,
    });
    const t = await table();
    await waitFor(() => expect(rowNames(t)).toEqual(["Floating"]));
    const link = within(
      await screen.findByTestId("batch-filter-link"),
    ).getByRole("link", { name: "Steam keys, October" });
    expect(link.getAttribute("href")).toBe(
      "#/p/djdl/license/batches/batch_oct",
    );
  });

  it("has no Batch column or facet on a product with no batch", async () => {
    bootLicense("#/p/djdl/license/licenses", {
      routes: {
        ...ROUTES,
        [`${API}/license/licenses`]: { licenses: [IN_ACCOUNT, WAITING] },
        [`${API}/license/batches`]: { batches: [], nextCursor: null },
      },
    });
    const t = await table(false);
    await within(t).findByText("Lena Ortiz");
    expect(within(t).queryByRole("columnheader", { name: /Batch/ })).toBeNull();
  });
});

describe("the record's holder line", () => {
  it("in an account: name, email and In an account; no key entries", async () => {
    bootLicense("#/p/djdl/license/licenses/lic_in", { routes: ROUTES });
    await screen.findByRole("heading", { level: 1, name: "Lena Ortiz" });
    const line = screen.getByTestId("record-holder");
    expect(line.textContent).toMatch(
      /Lena Ortiz.*lena@ortiz\.audio.*In an account/,
    );
    expect(screen.queryByTestId("record-key-entries")).toBeNull();
  });

  it("waiting: Waiting for the email, with the key entries", async () => {
    bootLicense("#/p/djdl/license/licenses/lic_wait", { routes: ROUTES });
    await screen.findByRole("heading", { level: 1, name: "Sam Reyes" });
    expect(screen.getByTestId("record-holder").textContent).toContain(
      "Waiting for sam@reyes.fm",
    );
    expect(screen.getByTestId("record-key-entries").textContent).toBe(
      "Key entries 3 of 10",
    );
  });

  it("floating: the title, the line, its batch, Assign… first, and the true count past the limit", async () => {
    bootLicense("#/p/djdl/license/licenses/lic_float", { routes: ROUTES });
    await screen.findByRole("heading", { level: 1, name: "Floating license" });
    const line = screen.getByTestId("record-holder");
    expect(line.textContent).toMatch(/Floating.*anyone with the key/);
    expect(
      (
        await within(line).findByRole("link", { name: "Steam keys, October" })
      ).getAttribute("href"),
    ).toBe("#/p/djdl/license/batches/batch_oct");
    expect(screen.getByTestId("record-key-entries").textContent).toBe(
      "Key entries 12 of 10",
    );
    expect(screen.getByText("Not in anyone's account")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Assign…" }).length).toBe(1);
    // No Reassign or Make floating on a licence with no holder.
    await userEvent.click(
      screen.getAllByRole("button", { name: "More actions" })[0]!,
    );
    expect(
      screen.queryByRole("menuitem", { name: "Make floating…" }),
    ).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Reassign…" })).toBeNull();
  });

  it("has no axe violations on a floating record", async () => {
    bootLicense("#/p/djdl/license/licenses/lic_float", { routes: ROUTES });
    await screen.findByRole("heading", { level: 1, name: "Floating license" });
    const results = await axe(document.body);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("Assign… and Edit holder", () => {
  it("assigns a floating licence with an email and an optional name (PATCH)", async () => {
    const log = bootLicense("#/p/djdl/license/licenses/lic_float", {
      routes: {
        ...ROUTES,
        [`PATCH ${API}/license/licenses/lic_float`]: {
          ok: true,
          id: "lic_float",
        },
      },
    });
    await screen.findByRole("heading", { level: 1, name: "Floating license" });
    await userEvent.click(screen.getByRole("button", { name: "Assign…" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Assign license",
    });
    await userEvent.type(
      within(dialog).getByLabelText(/^Email/),
      "ada@example.com",
    );
    // D4: the line never says whether the address has an account.
    expect(
      within(dialog).getByText(
        "When ada@example.com signs in with that email, it's in their library.",
      ),
    ).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText(/^Name/), "Ada");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Assign license" }),
    );
    await waitFor(() =>
      expect(writes(log)).toEqual([
        {
          path: `${API}/license/licenses/lic_float`,
          method: "PATCH",
          body: { email: "ada@example.com", name: "Ada" },
        },
      ]),
    );
  });

  it("Edit holder edits the name only on an assigned licence", async () => {
    bootLicense("#/p/djdl/license/licenses/lic_in", { routes: ROUTES });
    await screen.findByRole("heading", { level: 1, name: "Lena Ortiz" });
    await userEvent.click(
      screen.getAllByRole("button", { name: "Edit holder…" })[0]!,
    );
    const dialog = await screen.findByRole("dialog", { name: "Edit holder" });
    expect(within(dialog).getByLabelText(/^Name/)).toBeTruthy();
    expect(within(dialog).queryByLabelText(/^Email/)).toBeNull();
  });
});

describe("Reassign… and Make floating… (I-12's relink tool)", () => {
  it("Reassign needs the step-up, a reason, a new email and the typed name, then posts them", async () => {
    const log = bootLicense("#/p/djdl/license/licenses/lic_in", {
      me: FRESH,
      routes: {
        ...ROUTES,
        [`POST ${API}/users/licenses/lic_in/reassign`]: {
          ok: true,
          relinkId: "rlk_1",
          undoUntil: NOW_S + 3 * DAY,
          noticesSent: 2,
          alert: false,
        },
      },
    });
    await screen.findByRole("heading", { level: 1, name: "Lena Ortiz" });
    await more("Reassign…");
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).queryByText("Sign in again to continue")).toBeNull();
    const go = within(dialog).getByRole("button", { name: "Reassign license" });
    expect(
      go.hasAttribute("disabled") || go.getAttribute("aria-disabled"),
    ).toBeTruthy();
    await userEvent.type(
      within(dialog).getByLabelText("New email"),
      "jun@parkstudio.kr",
    );
    await userEvent.type(
      within(dialog).getByLabelText(/^Reason/),
      "Wrong buyer",
    );
    await userEvent.type(
      within(dialog).getByLabelText(/Type the license name/),
      "Lena Ortiz",
    );
    // The button is re-rendered once enabled (its tooltip wrapper goes): query it again.
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Reassign license" }),
    );
    await waitFor(() =>
      expect(writes(log)).toEqual([
        {
          path: `${API}/users/licenses/lic_in/reassign`,
          method: "POST",
          body: {
            email: "jun@parkstudio.kr",
            name: null,
            reason: "Wrong buyer",
            confirm: "Lena Ortiz",
          },
        },
      ]),
    );
  });

  it("refuses the same email before sending", async () => {
    const log = bootLicense("#/p/djdl/license/licenses/lic_in", {
      me: FRESH,
      routes: ROUTES,
    });
    await screen.findByRole("heading", { level: 1, name: "Lena Ortiz" });
    await more("Reassign…");
    const dialog = await screen.findByRole("alertdialog");
    const email = within(dialog).getByLabelText("New email");
    await userEvent.type(email, "LENA@ortiz.audio");
    await userEvent.tab();
    expect(
      within(dialog).getByText("That is the email it already has."),
    ).toBeTruthy();
    expect(writes(log)).toEqual([]);
  });

  it("Make floating sends the reason, the typed name and the sign-out choice", async () => {
    const log = bootLicense("#/p/djdl/license/licenses/lic_wait", {
      me: FRESH,
      routes: {
        ...ROUTES,
        [`POST ${API}/users/licenses/lic_wait/make-floating`]: {
          ok: true,
          relinkId: "rlk_2",
          undoUntil: NOW_S + 3 * DAY,
          noticesSent: 1,
          alert: false,
          devicesSignedOut: 2,
        },
      },
    });
    await screen.findByRole("heading", { level: 1, name: "Sam Reyes" });
    await more("Make floating…");
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText("It stops waiting for sam@reyes.fm."),
    ).toBeTruthy();
    expect(within(dialog).getByText("Its devices keep working.")).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText(/^Reason/), "Refunded");
    await userEvent.click(
      within(dialog).getByRole("checkbox", {
        name: /Also sign out its devices/,
      }),
    );
    await userEvent.type(
      within(dialog).getByLabelText(/Type the license name/),
      "Sam Reyes",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Make floating" }),
    );
    await waitFor(() =>
      expect(writes(log)).toEqual([
        {
          path: `${API}/users/licenses/lic_wait/make-floating`,
          method: "POST",
          body: {
            reason: "Refunded",
            confirm: "Sam Reyes",
            signOutDevices: true,
          },
        },
      ]),
    );
  });

  it("types the id when the licence has no name", async () => {
    const unnamed = summary("lic_anon", {
      name: "",
      email: "anon@example.com",
      holder: { kind: "assigned", inAccount: false, email: "anon@example.com" },
    });
    bootLicense("#/p/djdl/license/licenses/lic_anon", {
      me: FRESH,
      routes: {
        ...ROUTES,
        [`${API}/license/licenses/lic_anon`]: detail(unnamed),
        [`${API}/users/licenses/lic_anon/relinks`]: { relinks: [] },
      },
    });
    await screen.findByRole("heading", { level: 1, name: "Unnamed license" });
    await more("Make floating…");
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByLabelText(/Type the license id/)).toBeTruthy();
  });

  it("asks for a fresh sign-in first and keeps the action off until then", async () => {
    bootLicense("#/p/djdl/license/licenses/lic_in", {
      me: STALE,
      routes: ROUTES,
    });
    await screen.findByRole("heading", { level: 1, name: "Lena Ortiz" });
    await more("Make floating…");
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Sign in again to continue")).toBeTruthy();
    const link = within(dialog).getByRole("link", { name: "Sign in again" });
    expect(link.getAttribute("href")).toContain(
      encodeURIComponent("/manage/#/p/djdl/license/licenses/lic_in"),
    );
    await userEvent.type(within(dialog).getByLabelText(/^Reason/), "Refunded");
    await userEvent.type(
      within(dialog).getByLabelText(/Type the license name/),
      "Lena Ortiz",
    );
    // Typed and reasoned, still off: the step-up is what is missing.
    expect(
      within(dialog).getByRole("button", { name: "Make floating" }),
    ).toHaveProperty("disabled", true);
  });
});

describe("the newest move and its undo", () => {
  const MOVE: LicenseHolderMove = {
    id: "rlk_9",
    kind: "floating",
    reason: "Refunded",
    actorName: "Ada Lovelace",
    createdAt: NOW_S - 3600,
    undoUntil: NOW_S + 2 * DAY,
    undoneAt: null,
    undoable: true,
    fromSubject: "ps_CCCCCCCCCCCCCCCCCCCCCC",
    toSubject: null,
    from: { name: "Kim Lee", email: "kim@example.com" },
    to: { name: null, email: null },
    devicesSignedOut: 0,
  };

  it("moves focus to the page heading once the undone change's note has gone", async () => {
    let undone = false;
    bootLicense("#/p/djdl/license/licenses/lic_float", {
      me: FRESH,
      routes: {
        ...ROUTES,
        [`${API}/users/licenses/lic_float/relinks`]: () => ({
          relinks: undone
            ? [{ ...MOVE, undoable: false, undoneAt: NOW_S }]
            : [MOVE],
        }),
        [`POST ${API}/users/relinks/rlk_9/undo`]: () => {
          undone = true;
          return { ok: true, licenseId: "lic_float", subject: null };
        },
      },
    });
    await screen.findByRole("heading", { level: 1, name: "Floating license" });
    await userEvent.click(await screen.findByRole("button", { name: "Undo…" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.type(within(dialog).getByLabelText(/^Reason/), "Mistake");
    await userEvent.click(within(dialog).getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Undo…" })).toBeNull(),
    );
    const h1 = screen.getByRole("heading", {
      level: 1,
      name: "Floating license",
    });
    await waitFor(() => expect(document.activeElement).toBe(h1));
    expect(h1.getAttribute("tabindex")).toBe("-1");
  });

  it("shows what changed and undoes it with a reason", async () => {
    const log = bootLicense("#/p/djdl/license/licenses/lic_float", {
      me: FRESH,
      routes: {
        ...ROUTES,
        [`${API}/users/licenses/lic_float/relinks`]: { relinks: [MOVE] },
        [`POST ${API}/users/relinks/rlk_9/undo`]: {
          ok: true,
          licenseId: "lic_float",
          subject: "ps_CCCCCCCCCCCCCCCCCCCCCC",
        },
      },
    });
    await screen.findByRole("heading", { level: 1, name: "Floating license" });
    expect(
      await screen.findByText("This license was made floating by Ada Lovelace"),
    ).toBeTruthy();
    expect(
      screen.getByText(/Before, it was Kim Lee · kim@example\.com/),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Undo…" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.type(within(dialog).getByLabelText(/^Reason/), "Mistake");
    await userEvent.click(within(dialog).getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(writes(log)).toEqual([
        {
          path: `${API}/users/relinks/rlk_9/undo`,
          method: "POST",
          body: { reason: "Mistake" },
        },
      ]),
    );
  });
});

describe("the batch pages", () => {
  it("shows the batch's facts and that its keys can't be downloaded again", async () => {
    bootLicense("#/p/djdl/license/batches/batch_oct", { routes: ROUTES });
    await screen.findByRole("heading", {
      level: 1,
      name: "Steam keys, October",
    });
    expect(screen.getByText("Keys can't be downloaded again")).toBeTruthy();
    expect(screen.getByRole("meter", { name: "Used" })).toBeTruthy();
    expect(screen.getByText("37")).toBeTruthy();
    expect(screen.getByText(/by Ada Lovelace/)).toBeTruthy();
    const results = await axe(document.body);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });

  it("disables the unused keys after the typed batch label", async () => {
    const log = bootLicense("#/p/djdl/license/batches/batch_oct", {
      routes: {
        ...ROUTES,
        [`POST ${API}/license/batches/batch_oct/disable-unused`]: {
          disabled: 37,
        },
      },
    });
    await screen.findByRole("heading", {
      level: 1,
      name: "Steam keys, October",
    });
    await more("Disable unused keys…");
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(
        /37 licenses of this batch that no device has used are disabled/,
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText("Licenses already in use keep working."),
    ).toBeTruthy();
    const go = within(dialog).getByRole("button", {
      name: "Disable 37 unused keys",
    });
    await userEvent.click(go);
    expect(writes(log)).toEqual([]);
    await userEvent.type(
      within(dialog).getByLabelText(/Type the batch label/),
      "Steam keys, October",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Disable 37 unused keys" }),
    );
    await waitFor(() =>
      expect(writes(log)).toEqual([
        {
          path: `${API}/license/batches/batch_oct/disable-unused`,
          method: "POST",
          body: { confirm: "Steam keys, October" },
        },
      ]),
    );
  });

  it("offers no disable when every key was used", async () => {
    bootLicense("#/p/djdl/license/batches/batch_oct", {
      routes: {
        ...ROUTES,
        [`${API}/license/batches/batch_oct`]: { ...BATCH, used: 49, unused: 0 },
      },
    });
    await screen.findByRole("heading", {
      level: 1,
      name: "Steam keys, October",
    });
    await userEvent.click(
      screen.getAllByRole("button", { name: "More actions" })[0]!,
    );
    const item = await screen.findByRole("menuitem", {
      name: /Disable unused keys/,
    });
    expect(item.getAttribute("aria-disabled")).toBe("true");
  });

  it("lists the batches, each linking to its page", async () => {
    bootLicense("#/p/djdl/license/batches", { routes: ROUTES });
    const t = await screen.findByRole("table", { name: "Batches" });
    const link = await within(t).findByRole("link", {
      name: "Steam keys, October",
    });
    expect(link.getAttribute("href")).toBe(
      "#/p/djdl/license/batches/batch_oct",
    );
  });

  it("reads every page of the batch list", async () => {
    const second: LicenseBatch = {
      ...BATCH,
      id: "batch_sep",
      label: "September",
    };
    const log = bootLicense("#/p/djdl/license/batches", {
      routes: {
        ...ROUTES,
        [`${API}/license/batches`]: (q: URLSearchParams) =>
          q.get("cursor") === "c2"
            ? { batches: [second], nextCursor: null }
            : { batches: [BATCH], nextCursor: "c2" },
      },
    });
    const t = await screen.findByRole("table", { name: "Batches" });
    await within(t).findByRole("link", { name: "September" });
    const reads = log.calls.filter((c) => c.path === `${API}/license/batches`);
    expect(reads.map((c) => c.query)).toEqual([
      "limit=500",
      "limit=500&cursor=c2",
    ]);
  });
});
