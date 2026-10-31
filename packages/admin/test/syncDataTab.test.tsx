/**
 * U-11a.3, U-11a.4: Users → Data. The tab fills the user record's `dataTab` slot from the Core
 * chunk and shows while Cloud Sync is on (the regression: `cloudSyncOn` was always false); its
 * sections read one audited summary (`GET …/sync/subjects/<subject>`), sizes and names only; and
 * every state reads as a word: a skeleton after the grace, nothing synced yet, no access, an
 * error with Try again. Driven through the whole console against a scripted backend.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProductUserDetail, SyncSubjectResponse } from "../src/api.js";
import {
  ALL_ON,
  NONE,
  PENDING,
  boot,
  resetConsole,
  type Enablement,
  type FetchLog,
} from "./consoleHarness.js";
import { API, NOW_S } from "./licenseFixture.js";
import { expectNoAxeViolations } from "./coreTestUtils.js";
import { lastAnnouncement } from "../src/ui/LiveRegion.js";
import { setStepUpRedirectForTests } from "../src/lib/stepUp.js";

const SUBJECT = "ps_AAAAAAAAAAAAAAAAAAAAAA";
const USER = `${API}/users/${SUBJECT}`;
const SUMMARY = `${API}/sync/subjects/${SUBJECT}`;

type Data = Extract<SyncSubjectResponse, { enabled: true }>;

function data(over: Partial<Data> = {}): Data {
  return {
    enabled: true,
    empty: false,
    encryption: "server",
    encryptionSince: null,
    quota: {
      bytes: 10_240,
      defaultBytes: 5_120,
      tierId: "pro",
      tierLabel: "Pro",
    },
    usage: { bytes: 2_048, settings: 3, settingsBytes: 2_048 },
    settings: {
      declared: [
        { key: "ui.theme", bytes: 24, updatedAt: NOW_S - 60, platform: null },
        {
          key: "game.volume",
          bytes: 14,
          updatedAt: NOW_S - 120,
          platform: "desktop",
        },
      ],
      open: { count: 2, bytes: 1_100 },
    },
    collections: [],
    uploadsOpen: 0,
    ring: null,
    ...over,
  };
}

/** The user record the tab sits in: only what the record's header and tabs read. */
const userDetail = (): ProductUserDetail =>
  ({
    subject: SUBJECT,
    createdAt: NOW_S - 1000,
    contact: { email: "buyer@x.io", source: "license" },
    identityOn: true,
    licenses: [],
    devices: [],
    mergedFrom: [],
    relinks: [],
    events: [],
    audit: [],
    data: { bytes: 0, stores: [] },
  }) as unknown as ProductUserDetail;

const failure = (status: number, body: object): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** The console at the person's Data tab (or another), with the summary scripted. */
function bootTab(
  summary: unknown = data(),
  opts: { tab?: string; services?: Enablement } = {},
): FetchLog {
  const tab = opts.tab === undefined ? "/data" : opts.tab;
  return boot(`#/p/djdl/users/${SUBJECT}${tab}`, {
    services: opts.services ?? ALL_ON,
    extra: { [USER]: { user: userDetail() }, [SUMMARY]: summary },
  });
}

const reads = (log: FetchLog): number =>
  log.calls.filter((c) => c.path === SUMMARY).length;

/** An element's text, with the non-breaking space that keeps a number to its unit read as a space. */
const text = (el: Element | null): string =>
  (el?.textContent ?? "").replace(/\u00a0/g, " ");
const valueText = (el: Element): string =>
  (el.getAttribute("aria-valuetext") ?? "").replace(/\u00a0/g, " ");

beforeEach(resetConsole);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the Data tab on the user record", () => {
  it("is a tab while Cloud Sync is on, and reads nothing until it is opened", async () => {
    const log = bootTab(data(), { tab: "" });
    const nav = await screen.findByRole("navigation", {
      name: "User sections",
    });
    await waitFor(() =>
      expect(
        within(nav)
          .getAllByRole("link")
          .map((l) => l.textContent?.replace(/\d+$/, "")),
      ).toEqual(["Overview", "Licenses", "Devices", "Activity", "Data"]),
    );
    // The tab was not opened: nothing was read, so nothing was audited.
    expect(reads(log)).toBe(0);
  });

  it("is not a tab while Cloud Sync is off", async () => {
    for (const services of [{ ...ALL_ON, sync: { enabled: false } }, NONE]) {
      cleanup();
      resetConsole();
      bootTab(data(), { tab: "", services });
      const nav = await screen.findByRole("navigation", {
        name: "User sections",
      });
      await screen.findByRole("heading", { level: 1, name: SUBJECT });
      expect(within(nav).queryByRole("link", { name: "Data" })).toBeNull();
    }
  });

  it("opens from the tab, and a window that regains focus does not read it again", async () => {
    const log = bootTab(data(), { tab: "" });
    await userEvent.click(await screen.findByRole("link", { name: "Data" }));
    expect(
      await screen.findByRole("heading", { level: 2, name: "Storage" }),
    ).toBeTruthy();
    expect(reads(log)).toBe(1);
    fireEvent.focus(window);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(reads(log)).toBe(1);
  });
});

describe("Storage", () => {
  it("shows use against the limit, with the tier linked to Tiers", async () => {
    bootTab();
    const meter = await screen.findByRole("meter", { name: "Storage used" });
    expect(valueText(meter)).toBe("2 KiB of 10 KiB");
    const link = screen.getByRole("link", { name: "Pro" });
    expect(link.getAttribute("href")).toBe("#/p/djdl/license/tiers/pro");
  });

  it("falls back to the default limit before the first sync is counted", async () => {
    bootTab(
      data({
        quota: {
          bytes: null,
          defaultBytes: 5_120,
          tierId: null,
          tierLabel: null,
        },
      }),
    );
    const meter = await screen.findByRole("meter", { name: "Storage used" });
    expect(meter.getAttribute("aria-valuemax")).toBe("5120");
    expect(
      screen.getByText("Default limit, until their first sync."),
    ).toBeTruthy();
  });

  it("reads the limit in words, not by colour alone", async () => {
    bootTab(
      data({ usage: { bytes: 10_240, settings: 3, settingsBytes: 10_240 } }),
    );
    const meter = await screen.findByRole("meter", { name: "Storage used" });
    expect(valueText(meter)).toBe("10 KiB of 10 KiB");
  });

  it("reads a tier that allows no storage as reads only", async () => {
    bootTab(
      data({
        quota: {
          bytes: 0,
          defaultBytes: 5_120,
          tierId: "free",
          tierLabel: "Free",
        },
      }),
    );
    expect(await screen.findByText(/This tier allows reads only/)).toBeTruthy();
    expect(screen.queryByRole("meter")).toBeNull();
  });
});

describe("Settings", () => {
  it("lists declared settings by name, place, size and age, and counts the open ones", async () => {
    bootTab();
    const table = await screen.findByRole("table", { name: "Synced settings" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(
      rows.map((r) => within(r).getByRole("rowheader").textContent),
    ).toEqual(["ui.theme", "game.volume"]);
    expect(within(rows[0]!).getByText("Everywhere")).toBeTruthy();
    expect(within(rows[1]!).getByText("Desktop")).toBeTruthy();
    expect(text(within(rows[0]!).getAllByRole("cell")[1]!)).toBe("24 bytes");
    expect(text(screen.getByText(/^2 open settings the catalog/))).toBe(
      "2 open settings the catalog doesn't declare, 1.07 KiB.",
    );
  });

  it("names the one open setting in the singular, and omits the line when there are none", async () => {
    const declared = data().settings.declared;
    bootTab(data({ settings: { declared, open: { count: 1, bytes: 40 } } }));
    expect(text(await screen.findByText(/^1 open setting the catalog/))).toBe(
      "1 open setting the catalog doesn't declare, 40 bytes.",
    );
    cleanup();
    resetConsole();
    bootTab(data({ settings: { declared, open: { count: 0, bytes: 0 } } }));
    await screen.findByRole("table", { name: "Synced settings" });
    expect(screen.queryByText(/open setting/)).toBeNull();
  });

  it("says plainly when only open settings are stored", async () => {
    bootTab(
      data({ settings: { declared: [], open: { count: 2, bytes: 90 } } }),
    );
    expect(await screen.findByText("No settings stored")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Synced settings" })).toBeNull();
  });
});

const SAVES = {
  name: "saves",
  label: "Saves",
  records: 3,
  bytes: 600,
  files: 2,
  fileBytes: 3_000,
  revisionBytes: 1_000,
  lastWriteAt: NOW_S - 300,
};

describe("Collections", () => {
  it("lists records, files and size per collection, with the history the files keep", async () => {
    bootTab(
      data({
        collections: [
          SAVES,
          {
            name: "notes",
            label: "notes",
            records: 0,
            bytes: 0,
            files: 0,
            fileBytes: 0,
            revisionBytes: 0,
            lastWriteAt: null,
          },
        ],
      }),
    );
    const table = await screen.findByRole("table", {
      name: "Collection counts",
    });
    const rows = within(table).getAllByRole("row").slice(1);
    const cells = within(rows[0]!).getAllByRole("cell");
    expect(cells.slice(0, 3).map((c) => text(c))).toEqual([
      "3",
      "2",
      "4.49 KiB1,000 bytes history",
    ]);
    expect(cells[3]!.querySelector("time")).not.toBeNull();
    // The label first; the collection's own name beneath it only when the two differ.
    const head = within(rows[0]!).getByRole("rowheader");
    expect(text(head)).toBe("Savessaves");
    expect(text(within(rows[1]!).getByRole("rowheader"))).toBe("notes");
    expect(within(rows[1]!).getByText("None")).toBeTruthy();
  });

  it("is absent for a product with no collections", async () => {
    bootTab();
    await screen.findByRole("heading", { level: 2, name: "Storage" });
    expect(screen.queryByRole("heading", { name: "Collections" })).toBeNull();
  });

  it("says how many uploads are in progress, and nothing when none are", async () => {
    bootTab(data({ collections: [SAVES], uploadsOpen: 2 }));
    expect(await screen.findByText(/^2 uploads in progress/)).toBeTruthy();
    cleanup();
    resetConsole();
    bootTab(data({ collections: [SAVES], uploadsOpen: 1 }));
    expect(await screen.findByText(/^1 upload in progress/)).toBeTruthy();
    cleanup();
    resetConsole();
    bootTab(data({ collections: [SAVES], uploadsOpen: 0 }));
    await screen.findByRole("table", { name: "Collection counts" });
    expect(screen.queryByText(/in progress/)).toBeNull();
  });
});

describe("Encryption", () => {
  it("names a server-mode product as readable by Polaris Key, with no key", async () => {
    bootTab();
    expect(await screen.findByText("Readable by Polaris Key")).toBeTruthy();
    expect(screen.queryByText("Recovery code")).toBeNull();
    expect(screen.queryByText("No key yet.")).toBeNull();
  });

  it("shows an end-to-end person's key ring: which key, the recovery code and the devices", async () => {
    bootTab(
      data({
        encryption: "e2e",
        encryptionSince: 1,
        ring: {
          kid: "kid-1",
          createdAt: NOW_S - 86_400,
          recoverySet: true,
          devices: ["Ada's laptop", "Unnamed device"],
          previousUntil: NOW_S + 86_400,
        },
      }),
    );
    expect(await screen.findByText("End-to-end")).toBeTruthy();
    const dl = screen.getByText("Key").closest("dl")!;
    expect(text(dl.querySelector("code"))).toBe("kid-1");
    expect(within(dl).getByText("Set")).toBeTruthy();
    const devices = within(dl).getByText("Devices that can open it")
      .nextElementSibling as HTMLElement;
    expect(
      within(devices)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Ada's laptop", "Unnamed device"]);
    expect(within(dl).getByText("Previous key")).toBeTruthy();
  });

  it("says a missing recovery code and a missing key plainly", async () => {
    bootTab(
      data({
        encryption: "e2e",
        ring: {
          kid: "kid-2",
          createdAt: NOW_S - 60,
          recoverySet: false,
          devices: [],
        },
      }),
    );
    expect(await screen.findByText("Not set")).toBeTruthy();
    expect(screen.getByText("None")).toBeTruthy();
    expect(screen.queryByText("Previous key")).toBeNull();
    cleanup();
    resetConsole();
    bootTab(data({ encryption: "e2e", ring: null }));
    expect(await screen.findByText("No key yet.")).toBeTruthy();
  });

  it("still shows a person who has a key and no data yet", async () => {
    bootTab(
      data({
        empty: true,
        encryption: "e2e",
        usage: { bytes: 0, settings: 0, settingsBytes: 0 },
        settings: { declared: [], open: { count: 0, bytes: 0 } },
        ring: {
          kid: "kid-3",
          createdAt: NOW_S - 60,
          recoverySet: true,
          devices: ["Ada's laptop"],
        },
      }),
    );
    expect(await screen.findByText("End-to-end")).toBeTruthy();
    expect(screen.queryByText("Nothing synced yet")).toBeNull();
  });
});

describe("states", () => {
  it("shows a skeleton while loading, announced, and no data", async () => {
    bootTab(PENDING);
    await screen.findByText("Loading Cloud Sync data");
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Storage" })).toBeNull();
  });

  it("says nothing synced yet for a person with no data and no key", async () => {
    bootTab(
      data({
        empty: true,
        usage: { bytes: 0, settings: 0, settingsBytes: 0 },
        settings: { declared: [], open: { count: 0, bytes: 0 } },
      }),
    );
    expect(await screen.findByText("Nothing synced yet")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Storage" })).toBeNull();
  });

  it("reads a refused permission as no access, not as a failed load", async () => {
    bootTab(
      failure(403, { error: { code: "forbidden", reason: "no_access" } }),
    );
    expect(
      await screen.findByText("You don't have access to this"),
    ).toBeTruthy();
    expect(screen.queryByText("Cloud Sync data didn't load")).toBeNull();
  });

  it("shows an error with a retry that reads again", async () => {
    let calls = 0;
    const log = bootTab(() => {
      calls += 1;
      return calls === 1
        ? failure(503, { error: { code: "unavailable" } })
        : data();
    });
    expect(await screen.findByText("Cloud Sync data didn't load")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("heading", { level: 2, name: "Storage" }),
    ).toBeTruthy();
    expect(reads(log)).toBe(2);
  });

  it("answers an off service in words", async () => {
    bootTab({ enabled: false });
    expect(await screen.findByText("Cloud Sync is off")).toBeTruthy();
  });

  it("has no axe violations once loaded", async () => {
    bootTab();
    await screen.findByRole("table", { name: "Synced settings" });
    await expectNoAxeViolations(document.body);
  });
});

// ── U-11a.5: Values, the records browser, file history and Download ─────────────────────────

const VALUES = `${SUMMARY}/values`;
const FILE = `${SUMMARY}/files/saves/slot-1`;
const stepUpRefusal = (): Response =>
  failure(403, {
    error: { code: "step_up_required" },
    code: "step_up_required",
  });

const setting = (key: string, value: unknown) => ({
  key,
  declared: true,
  platform: null,
  bytes: 20,
  updatedAt: NOW_S - 60,
  value,
  sealed: false,
});
const rec = (id: string, over: object = {}) => ({
  id,
  version: 3,
  updatedAt: NOW_S - 30,
  bytes: 40,
  value: { level: 4 },
  sealed: false,
  ...over,
});
const FILE_PTR = {
  version: 3,
  size: 2_048,
  sha256: "ab".repeat(32),
  format: "whole",
};

/** The tab with Values scripted: settings with no `collection`, and records paged by `cursor`. */
function bootValues(
  over: Partial<Data> = {},
  values: unknown = undefined,
  extra: Record<string, unknown> = {},
): FetchLog {
  const reply =
    values ??
    ((q: URLSearchParams) => {
      if (!q.get("collection"))
        return {
          settings: [setting("ui.theme", "dark")],
          records: [],
          next: null,
        };
      return q.get("cursor")
        ? { settings: null, records: [rec("slot-3")], next: null }
        : {
            settings: null,
            records: [rec("slot-1", { file: FILE_PTR }), rec("slot-2")],
            next: "slot-2",
          };
    });
  return boot(`#/p/djdl/users/${SUBJECT}/data`, {
    services: ALL_ON,
    extra: {
      [USER]: { user: userDetail() },
      [SUMMARY]: data({ collections: [SAVES], ...over }),
      [VALUES]: reply,
      ...extra,
    },
  });
}

/** The tab with no settings and one collection holding exactly these records. */
function bootRecords(...records: object[]): FetchLog {
  return bootValues({}, (q: URLSearchParams) =>
    q.get("collection")
      ? { settings: null, records, next: null }
      : { settings: [], records: [], next: null },
  );
}

describe("Values (server mode)", () => {
  it("reads nothing until Show values, then lists settings and a page of records", async () => {
    const log = bootValues();
    const button = await screen.findByRole("button", { name: "Show values" });
    expect(log.calls.some((c) => c.path === VALUES)).toBe(false);
    await userEvent.click(button);
    const settings = await screen.findByRole("table", {
      name: "Setting values",
    });
    expect(within(settings).getByText('"dark"')).toBeTruthy();
    const records = await screen.findByRole("table", { name: "Saves records" });
    expect(
      within(records)
        .getAllByRole("rowheader")
        .map((h) => h.textContent),
    ).toEqual(["slot-1", "slot-2"]);
    expect(
      within(records).getAllByText('{"level":4}', { selector: "code" }),
    ).toBeTruthy();
    // Pages by cursor: "Show more" asks after the last id.
    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    await within(records).findByText("slot-3");
    expect(
      log.calls.filter((c) => c.path === VALUES).map((c) => c.query),
    ).toEqual(["", "collection=saves", "collection=saves&cursor=slot-2"]);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    expect(screen.getByRole("button", { name: "Hide values" })).toBeTruthy();
  });

  it("says a sealed value is sealed, and has no axe violations open", async () => {
    bootRecords(rec("slot-1", { value: null, sealed: true }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Show values" }),
    );
    expect(await screen.findByText("Sealed")).toBeTruthy();
    expect(await screen.findByText("No settings stored.")).toBeTruthy();
    await expectNoAxeViolations(document.body);
  });

  it("asks for a new sign-in when the read is refused, and opens again on return", async () => {
    const redirect = vi.fn();
    setStepUpRedirectForTests(redirect);
    try {
      bootValues({}, stepUpRefusal());
      await userEvent.click(
        await screen.findByRole("button", { name: "Show values" }),
      );
      const alert = await screen.findByRole("alert");
      expect(text(alert)).toContain("Sign in again to show values");
      await userEvent.click(
        within(alert).getByRole("button", { name: "Sign in again" }),
      );
      expect(redirect).toHaveBeenCalledTimes(1);
      // Back on the page after the sign-in: the section opens by itself.
      cleanup();
      resetConsole();
      const log = bootValues();
      await screen.findByRole("table", { name: "Setting values" });
      expect(log.calls.some((c) => c.path === VALUES)).toBe(true);
    } finally {
      setStepUpRedirectForTests();
    }
  });

  it("names a failed read with Try again, and keeps the page", async () => {
    bootValues({}, failure(503, { error: { code: "unavailable" } }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Show values" }),
    );
    expect(await screen.findByText(/Values didn't load/)).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 2, name: "Storage" }),
    ).toBeTruthy();
  });

  it("offers no Values to an end-to-end product, and says what stays on the devices", async () => {
    bootValues({ encryption: "e2e", encryptionSince: 1 });
    expect(await screen.findByText("End-to-end")).toBeTruthy();
    expect(
      screen.getByText(/Values and names stay on the person's devices/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show values" })).toBeNull();
  });
});

describe("the record drawer, file history and Download", () => {
  const blobFetch = (): void => {
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();
  };
  const openRecord = async (id: string) => {
    await userEvent.click(
      await screen.findByRole("button", { name: "Show values" }),
    );
    await userEvent.click(await screen.findByRole("button", { name: id }));
    return screen.findByRole("dialog");
  };
  const REVS = {
    revisions: [
      {
        version: 2,
        size: 1_024,
        sha256: "cd".repeat(32),
        format: "whole",
        createdAt: NOW_S - 900,
      },
    ],
  };

  it("reads a value whole, pretty-printed, with Copy, and RTL strings kept in order", async () => {
    const rtl = { שם: "מרים", level: 12, long: "x".repeat(300) };
    bootRecords(rec("slot-1", { value: rtl }));
    const dialog = await openRecord("slot-1");
    const pre = dialog.querySelector("pre")!;
    expect(pre.getAttribute("dir")).toBe("ltr");
    expect(text(pre)).toContain('  "level": 12');
    expect(text(pre)).toContain("x".repeat(300));
    // Every string token is isolated, so the right-to-left words do not reorder the braces.
    expect(
      [...pre.querySelectorAll("bdi")].some((b) => b.textContent === '"שם"'),
    ).toBe(true);
    expect(
      within(dialog).getByRole("button", { name: "Copy value of slot-1" }),
    ).toBeTruthy();
    expect(text(dialog)).toContain("In Saves");
  });

  it("clamps a long value to two lines in the row, with no tooltip to read it by", async () => {
    bootRecords(rec("slot-1", { value: { text: "y".repeat(400) } }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Show values" }),
    );
    const records = await screen.findByRole("table", { name: "Saves records" });
    const code = records.querySelector("code")!;
    expect(code.className).toContain("line-clamp-2");
    expect(code.getAttribute("title")).toBeNull();
    expect(text(code).length).toBeGreaterThan(400);
  });

  /** Saved files: the names the page gave them (the link click is stubbed). */
  const saved = (): { names: string[]; click: { mockRestore: () => void } } => {
    blobFetch();
    const names: string[] = [];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        names.push(this.download);
      });
    return { names, click };
  };

  it("lists the current version and the kept ones, and saves each as <id>-v<n>.bin", async () => {
    const { names, click } = saved();
    const log = bootValues({}, undefined, {
      [`${FILE}/revisions`]: REVS,
      [FILE]: () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    });
    const dialog = await openRecord("slot-1");
    const table = await within(dialog).findByRole("table", {
      name: "File versions",
    });
    expect(within(table).getByText("Current")).toBeTruthy();
    for (const v of ["2", "3"])
      await userEvent.click(
        within(dialog).getByRole("button", { name: `Download version ${v}` }),
      );
    await waitFor(() =>
      expect(names).toEqual(["slot-1-v2.bin", "slot-1-v3.bin"]),
    );
    expect(
      log.calls.filter((c) => c.path === FILE).map((c) => c.query),
    ).toEqual(["version=2", ""]);
    await waitFor(() =>
      expect(lastAnnouncement()).toBe("Downloaded slot-1-v3.bin"),
    );
    click.mockRestore();
  });

  it("says what failed with Try again, in the drawer, not a toast", async () => {
    const { click } = saved();
    let tries = 0;
    bootValues({}, undefined, {
      [`${FILE}/revisions`]: REVS,
      [FILE]: () =>
        ++tries === 1
          ? failure(500, { error: { code: "internal_error" } })
          : new Response(new Uint8Array([9]), { status: 200 }),
    });
    const dialog = await openRecord("slot-1");
    await userEvent.click(
      await within(dialog).findByRole("button", { name: "Download version 3" }),
    );
    const alert = await within(dialog).findByRole("alert");
    expect(text(alert)).toContain("Couldn't download slot-1");
    await userEvent.click(
      within(alert).getByRole("button", { name: "Try again" }),
    );
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(tries).toBe(2);
    click.mockRestore();
  });

  it("asks for a new sign-in when Download is refused, in the drawer only", async () => {
    bootValues({}, undefined, {
      [`${FILE}/revisions`]: REVS,
      [FILE]: stepUpRefusal(),
    });
    const dialog = await openRecord("slot-1");
    await userEvent.click(
      await within(dialog).findByRole("button", { name: "Download version 3" }),
    );
    expect(text(await within(dialog).findByRole("alert"))).toContain(
      "Sign in again to download this file",
    );
  });
});

describe("Values: collections, paging, settings and the way back", () => {
  const fiveCollections = ["a", "b", "c", "d", "e"].map((n) => ({
    ...SAVES,
    name: n,
    label: `Coll ${n}`,
    records: 2,
  }));

  it("picks among five or more collections with a Select, counts in the options", async () => {
    bootValues({ collections: fiveCollections }, (q: URLSearchParams) =>
      q.get("collection")
        ? {
            settings: null,
            records: [rec(`rec-${q.get("collection")}`)],
            next: null,
          }
        : { settings: [], records: [], next: null },
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Show values" }),
    );
    const select = await screen.findByRole("combobox", { name: "Collection" });
    expect(text(select)).toContain("Coll a · 2");
    await userEvent.click(select);
    await userEvent.click(
      await screen.findByRole("option", { name: "Coll d · 2" }),
    );
    expect(await screen.findByText("rec-d")).toBeTruthy();
  });

  it("switches two to four collections with a segmented control", async () => {
    bootValues({ collections: fiveCollections.slice(0, 3) });
    await userEvent.click(
      await screen.findByRole("button", { name: "Show values" }),
    );
    expect(
      await screen.findByRole("radiogroup", { name: "Collection" }),
    ).toBeTruthy();
  });

  it("shows the settings' values only: the keys' size and age are in Settings above", async () => {
    bootValues();
    await userEvent.click(
      await screen.findByRole("button", { name: "Show values" }),
    );
    const t = await screen.findByRole("table", { name: "Setting values" });
    expect(
      within(t)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Setting", "Value"]);
  });

  it("moves focus to a note when the last page loads, and counts what is shown", async () => {
    bootValues({ collections: [{ ...SAVES, records: 3 }] });
    await userEvent.click(
      await screen.findByRole("button", { name: "Show values" }),
    );
    expect(await screen.findByText("2 of 3")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    const note = await screen.findByText("All 3 records shown");
    await waitFor(() => expect(document.activeElement).toBe(note));
    expect(lastAnnouncement()).toBe("1 more record");
  });

  it("lands on the Values heading when back from the sign-in, with the record open again", async () => {
    const redirect = vi.fn();
    setStepUpRedirectForTests(redirect);
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    try {
      bootValues({}, undefined, {
        [FILE]: stepUpRefusal(),
        [`${FILE}/revisions`]: { revisions: [] },
      });
      await userEvent.click(
        await screen.findByRole("button", { name: "Show values" }),
      );
      await userEvent.click(
        await screen.findByRole("button", { name: "slot-1" }),
      );
      const dialog = await screen.findByRole("dialog");
      await userEvent.click(
        await within(dialog).findByRole("button", {
          name: "Download version 3",
        }),
      );
      await userEvent.click(
        await within(dialog).findByRole("button", { name: "Sign in again" }),
      );
      cleanup();
      resetConsole();
      bootValues();
      const heading = await screen.findByRole("heading", { name: "Values" });
      await waitFor(() => expect(document.activeElement).toBe(heading));
      expect(scroll).toHaveBeenCalled();
      expect(await screen.findByRole("dialog")).toBeTruthy();
    } finally {
      setStepUpRedirectForTests();
    }
  });
});

// ── U-11a.6: Delete Cloud Sync data ─────────────────────────────────────────────────────────

describe("Delete Cloud Sync data", () => {
  const DELETE = `POST ${SUMMARY}/delete`;
  const open = async () => {
    await userEvent.click(
      await screen.findByRole("button", { name: "Delete Cloud Sync data" }),
    );
    return screen.findByRole("alertdialog");
  };

  it("needs the typed word, then deletes, announces once and reads the summary afresh", async () => {
    let deleted = false;
    const log = boot(`#/p/djdl/users/${SUBJECT}/data`, {
      services: ALL_ON,
      extra: {
        [USER]: { user: userDetail() },
        [SUMMARY]: () =>
          deleted
            ? data({
                empty: true,
                usage: { bytes: 0, settings: 0, settingsBytes: 0 },
                settings: { declared: [], open: { count: 0, bytes: 0 } },
              })
            : data(),
        [DELETE]: () => {
          deleted = true;
          return { deleted: true };
        },
      },
    });
    const dialog = await open();
    const confirm = () =>
      within(dialog).getByRole("button", { name: "Delete data" });
    expect(confirm().getAttribute("aria-disabled")).toBe("true");
    await userEvent.type(within(dialog).getByRole("textbox"), "delete");
    await userEvent.click(confirm());
    await waitFor(() =>
      expect(
        log.calls.filter(
          (c) => c.method === "POST" && c.path === `${SUMMARY}/delete`,
        ),
      ).toHaveLength(1),
    );
    expect(log.calls.find((c) => c.path === `${SUMMARY}/delete`)?.json).toEqual(
      { confirm: true },
    );
    const empty = await screen.findByRole("heading", {
      name: "Nothing synced yet",
    });
    await waitFor(() => expect(document.activeElement).toBe(empty));
    expect(reads(log)).toBe(2);
    expect(lastAnnouncement()).toBe("Cloud Sync data deleted");
  });

  it("asks for a new sign-in when the delete is refused, keeping the typed word", async () => {
    bootTab();
    boot(`#/p/djdl/users/${SUBJECT}/data`, {
      services: ALL_ON,
      extra: {
        [USER]: { user: userDetail() },
        [SUMMARY]: data(),
        [DELETE]: stepUpRefusal(),
      },
    });
    const dialog = await open();
    await userEvent.type(within(dialog).getByRole("textbox"), "delete");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete data" }),
    );
    expect(
      await within(dialog).findByRole("button", { name: "Sign in again" }),
    ).toBeTruthy();
    // The words ask for a sign-in; they never say the operator lacks edit access.
    expect(text(dialog)).toContain(
      "This needs a sign-in from the last 5 minutes",
    );
    expect(text(dialog)).not.toContain("edit access");
  });

  it("is offered to an end-to-end product too", async () => {
    bootTab(data({ encryption: "e2e", encryptionSince: 1 }));
    expect(
      await screen.findByRole("button", { name: "Delete Cloud Sync data" }),
    ).toBeTruthy();
  });
});
