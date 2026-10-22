/**
 * The license record (ADMIN.md §6.5.2) through the whole console: the header (LDT-7 to LDT-9,
 * LDT-14), route tabs (LDT-4), the one Terms form (LDT-1 to LDT-3, LDT-12), Keys (LDT-11,
 * LIC-2), Devices (LDT-10, DEV-8), Config overrides (LDT-5, LDT-6) and the offline bundle
 * (LDT-13).
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
import { NONE, resetConsole, type Enablement } from "./consoleHarness.js";
import {
  API,
  DETAIL,
  NOW_S,
  axe,
  bootLicense,
  failing,
  writes,
} from "./licenseFixture.js";

beforeEach(resetConsole);
afterEach(cleanup);

const REC = "#/p/djdl/license/licenses/lic_1";
const LIC = `${API}/license/licenses/lic_1`;

async function header() {
  return screen.findByRole("heading", { level: 1, name: "Ada Lovelace" });
}

async function more(item: string) {
  await userEvent.click(
    screen.getAllByRole("button", { name: "More actions" })[0]!,
  );
  await userEvent.click(await screen.findByRole("menuitem", { name: item }));
}

describe("license record: header and tabs", () => {
  it("shows the status once, the holder, the id, the tier control and who changed it", async () => {
    bootLicense(REC);
    await header();
    // Beside the title; a second copy in the facts strip shows only at 200 % text (CSS, conbig).
    expect(screen.getAllByText("Active")).toHaveLength(2);
    expect(screen.getByText("ada@x.io")).toBeTruthy();
    // The tier is a control that opens Change tier (licenses.detail).
    expect(
      await screen.findByRole("button", { name: "Tier: Pro. Change tier" }),
    ).toBeTruthy();
    // modifiedBy is the signed-in operator: named, not a raw sub (LDT-9).
    expect(screen.getByText(/Changed .* by Ada Lovelace/)).toBeTruthy();
    const tabs = screen.getByRole("navigation", { name: "License sections" });
    expect(
      within(tabs)
        .getByRole("link", { name: /Status/ })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(within(tabs).getByRole("link", { name: "Activity" })).toBeTruthy();
    expect(within(tabs).getByRole("link", { name: /Keys\s*1/ })).toBeTruthy();
    expect(
      await within(tabs).findByRole("link", { name: /Devices\s*2\/5/ }),
    ).toBeTruthy();
  });

  it("puts the tab in the URL", async () => {
    bootLicense(REC);
    await header();
    await userEvent.click(screen.getByRole("link", { name: /Keys/ }));
    await waitFor(() => expect(window.location.hash).toBe(`${REC}/keys`));
    expect(await screen.findByRole("table", { name: "Keys" })).toBeTruthy();
  });

  it("disables from the danger menu with an L1 confirm, not a switch (LDT-7)", async () => {
    const log = bootLicense(REC);
    await header();
    expect(screen.queryByRole("switch")).toBeNull();
    await more("Disable license…");
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/stop authenticating right away/),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Disable license" }),
    );
    await waitFor(() =>
      expect(writes(log).map((c) => c.path)).toEqual([`${LIC}/disable`]),
    );
  });

  it("deletes from the danger menu after typing delete <id>, then returns to the list", async () => {
    const log = bootLicense(REC, {
      routes: {
        [LIC]: {
          ...DETAIL,
          status: "disabled",
          origin: "oidc",
          deletion: { allowed: true, reasons: [] },
        },
        [`DELETE ${LIC}`]: { ok: true, id: "lic_1", devices: 2 },
      },
    });
    await header();
    await more("Delete license…");
    const dialog = await screen.findByRole("alertdialog", {
      name: /Delete Ada Lovelace\?/,
    });
    expect(
      within(dialog).getByText(/2 devices stop authenticating/),
    ).toBeTruthy();
    expect(within(dialog).getByText(/activity history is kept/)).toBeTruthy();
    // A disabled sign-in license: deleting it lifts the refusal.
    expect(
      within(dialog).getByText(
        "If its holder signs in again, they get a new license.",
      ),
    ).toBeTruthy();
    const confirm = within(dialog).getByRole("button", {
      name: "Delete license",
    });
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(confirm);
    expect(writes(log)).toEqual([]);
    await userEvent.type(within(dialog).getByRole("textbox"), "delete lic_1");
    // The soft-disabled button is re-rendered once the text matches: query it again.
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete license" }),
    );
    await waitFor(() =>
      expect(writes(log)).toEqual([
        { path: LIC, method: "DELETE", body: { confirm: "delete lic_1" } },
      ]),
    );
    await waitFor(() =>
      expect(window.location.hash).toBe("#/p/djdl/license/licenses"),
    );
  });

  it("keeps Delete license visible but unavailable, with the Worker's reason", async () => {
    const log = bootLicense(REC, {
      routes: {
        [LIC]: {
          ...DETAIL,
          deletion: {
            allowed: false,
            reasons: [
              {
                code: "issued_active",
                message:
                  "It is active and was issued by the developer. Disable it first.",
              },
            ],
          },
        },
      },
    });
    await header();
    await userEvent.click(
      screen.getAllByRole("button", { name: "More actions" })[0]!,
    );
    const item = await screen.findByRole("menuitem", {
      name: /Delete license…/,
    });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(within(item).getByText(/Disable it first/)).toBeTruthy();
    await userEvent.click(item);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(writes(log)).toEqual([]);
  });

  it("shows the Worker's refusal inline when the license changed since it loaded", async () => {
    bootLicense(REC, {
      routes: {
        [LIC]: { ...DETAIL, deletion: { allowed: true, reasons: [] } },
        [`DELETE ${LIC}`]: new Response(
          JSON.stringify({
            error: {
              code: "license_not_deletable",
              message:
                "License lic_1 can't be deleted: 1 store purchase is recorded against it.",
            },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      },
    });
    await header();
    await more("Delete license…");
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.type(within(dialog).getByRole("textbox"), "delete lic_1");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete license" }),
    );
    expect(
      await within(dialog).findByText("This license can't be deleted"),
    ).toBeTruthy();
    expect(within(dialog).getByText(/store purchase is recorded/)).toBeTruthy();
  });

  it("offers Enable as the primary action while disabled", async () => {
    const log = bootLicense(REC, {
      routes: { [LIC]: { ...DETAIL, status: "disabled" } },
    });
    await header();
    await userEvent.click(
      screen.getAllByRole("button", { name: "Enable license" })[0]!,
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Enable license" }),
    );
    await waitFor(() =>
      expect(writes(log).map((c) => c.path)).toEqual([`${LIC}/enable`]),
    );
  });

  it("says a license that doesn't exist is not found, with a way back (LDT-14)", async () => {
    bootLicense(REC, { routes: { [LIC]: failing(404, "not_found") } });
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "License not found",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Back to licenses" }),
    ).toBeTruthy();
  });

  it("shows a load failure with a retry", async () => {
    bootLicense(REC, { routes: { [LIC]: failing(500) } });
    expect(
      await screen.findByRole("button", { name: /Try again/ }),
    ).toBeTruthy();
  });

  it("edits the holder in its own dialog", async () => {
    const log = bootLicense(REC);
    await header();
    await more("Edit holder…");
    const dialog = await screen.findByRole("dialog", { name: "Edit holder" });
    const name = within(dialog).getByLabelText(/^Name/);
    await userEvent.clear(name);
    await userEvent.type(name, "Ada King");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save holder" }),
    );
    await waitFor(() =>
      expect(writes(log)).toEqual([
        { path: LIC, method: "PATCH", body: { name: "Ada King" } },
      ]),
    );
  });

  it("asks before Escape drops unsaved holder changes (C-20)", async () => {
    bootLicense(REC);
    await header();
    await more("Edit holder…");
    const dialog = await screen.findByRole("dialog", { name: "Edit holder" });
    await userEvent.type(within(dialog).getByLabelText(/^Name/), " Jr");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "Discard your changes?",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Discard" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit holder" })).toBeNull(),
    );
  });

  it("links to this license's activity (LDT-17)", async () => {
    bootLicense(REC);
    await header();
    await more("View in activity");
    await waitFor(() =>
      expect(window.location.hash).toBe("#/p/djdl/activity?q=lic_1"),
    );
  });

  it("passes axe", async () => {
    bootLicense(REC);
    await header();
    await screen.findByRole("table", { name: /Limits/ });
    const results = await axe(document.body);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("license record: Status (Limits, Duration, Change tier)", () => {
  async function limits() {
    await header();
    return screen.findByRole("table", { name: /Limits/ });
  }
  const row = (table: HTMLElement, name: RegExp) =>
    within(table).getByRole("row", { name });

  it("lists each limit with the layer it came from (LX-32, LX-33)", async () => {
    bootLicense(REC);
    const table = await limits();
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Limit", "Value", "From", "Action"]);
    const offline = row(table, /Offline days/);
    expect(within(offline).getByText("14 days")).toBeTruthy();
    expect(within(offline).getByText("Set on this license")).toBeTruthy();
    const tracks = row(table, /Release tracks/);
    expect(within(tracks).getByText("stable, beta")).toBeTruthy();
    expect(within(tracks).getByText("This license and Pro")).toBeTruthy();
    // Without the Worker's terms the tier's fingerprint mode is unknown: the product default.
    expect(
      within(row(table, /Fingerprint mode/)).getByText("Platform default"),
    ).toBeTruthy();
  });

  it("uses the Worker's terms, and links a tier-set fingerprint mode to its tier", async () => {
    bootLicense(REC, {
      routes: {
        [LIC]: {
          ...DETAIL,
          terms: {
            deviceLimit: { value: 7, source: "tier" },
            inheritedDeviceLimit: { value: 7, source: "tier" },
            maxOfflineDays: { value: 30, source: "product" },
            channels: { value: [], source: "none" },
            minVersion: { value: null, source: "none" },
            maxVersion: { value: null, source: "none" },
            fingerprintMode: { value: "strict", source: "tier" },
          },
        },
      },
    });
    const table = await limits();
    expect(within(row(table, /Devices/)).getByText("7")).toBeTruthy();
    expect(within(row(table, /Versions/)).getByText("Any")).toBeTruthy();
    expect(
      within(row(table, /Fingerprint mode/)).getByText("Strict"),
    ).toBeTruthy();
    expect(
      (
        await within(row(table, /Fingerprint mode/)).findByRole("link", {
          name: "Open tier",
        })
      ).getAttribute("href"),
    ).toBe("#/p/djdl/license/tiers/pro");
  });

  it("clears an override with Use the platform default (null)", async () => {
    const log = bootLicense(REC);
    await limits();
    await userEvent.click(
      screen.getByRole("button", {
        name: "Offline days: use the platform default",
      }),
    );
    await waitFor(() =>
      expect(writes(log)).toEqual([
        { path: LIC, method: "PATCH", body: { maxOfflineDays: null } },
      ]),
    );
  });

  it("edits offline days in a dialog and clears them as null (LDT-2)", async () => {
    const log = bootLicense(REC);
    await limits();
    await userEvent.click(
      screen.getByRole("button", { name: "Edit offline days" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Override offline days",
    });
    await userEvent.clear(
      within(dialog).getByRole("textbox", { name: /^Offline days/ }),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(writes(log)).toEqual([
        { path: LIC, method: "PATCH", body: { maxOfflineDays: null } },
      ]),
    );
  });

  it("checks the version window on the client", async () => {
    const log = bootLicense(REC);
    await limits();
    await userEvent.click(
      screen.getByRole("button", { name: "Override versions" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Override versions",
    });
    await userEvent.type(
      within(dialog).getByLabelText(/^Minimum version/),
      "3.0.0",
    );
    await userEvent.type(
      within(dialog).getByLabelText(/^Maximum version/),
      "2.0.0",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(
      await within(dialog).findByText(/maximum version must be/),
    ).toBeTruthy();
    expect(writes(log)).toEqual([]);
  });

  it("removes a held dev grant and keeps a held value the picker doesn't offer", async () => {
    const log = bootLicense(REC, {
      routes: { [LIC]: { ...DETAIL, channels: ["stable", "dev", "Legacy.X"] } },
    });
    await limits();
    await userEvent.click(
      screen.getByRole("button", { name: "Edit release tracks" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Override release tracks",
    });
    const group = within(dialog)
      .getAllByRole("group", { name: "Release tracks" })
      .at(-1)!;
    expect(within(group).getByText("Not offered")).toBeTruthy();
    await userEvent.click(within(group).getByLabelText("dev"));
    await userEvent.click(within(group).getByLabelText("beta"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes(log)).toHaveLength(1));
    expect((writes(log)[0]!.body as { channels: string[] }).channels).toEqual([
      "stable",
      "beta",
      "Legacy.X",
    ]);
  });

  it("reorders profiles in a dialog (LDT-3)", async () => {
    const log = bootLicense(REC);
    await header();
    await more("Edit profiles…");
    const dialog = await screen.findByRole("dialog", { name: "Profiles" });
    expect(within(dialog).getByText("Position 1:")).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Move Studio up" }),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(writes(log)).toEqual([
        {
          path: LIC,
          method: "PATCH",
          body: { profiles: ["studio", "base"] },
        },
      ]),
    );
  });

  it("shows the duration and changes the end date in a dialog", async () => {
    const log = bootLicense(REC);
    await header();
    const card = await screen.findByRole("region", { name: "Duration" });
    expect(within(card).getByText(/^Today · /)).toBeTruthy();
    await userEvent.click(within(card).getByRole("button", { name: "Change" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Change duration",
    });
    await userEvent.clear(within(dialog).getByLabelText(/^Ends/));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(writes(log)).toEqual([
        { path: LIC, method: "PATCH", body: { expiresAt: null } },
      ]),
    );
  });

  it("Change tier lists what changes, old to new, and moves the license", async () => {
    const log = bootLicense(REC);
    await header();
    await userEvent.click(
      screen.getByRole("button", { name: "Tier: Pro. Change tier" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Change Ada Lovelace's tier",
    });
    await userEvent.click(within(dialog).getByLabelText(/^Move to/));
    await userEvent.click(await screen.findByRole("option", { name: /Edu/ }));
    const diff = within(dialog).getByRole("region", { name: "What changes" });
    const devices = within(diff).getByText("Devices").closest("div")!;
    expect(devices.textContent).toContain("5");
    expect(devices.textContent).toContain("1");
    expect(
      within(devices).getByText(/2 devices are signed in; none is signed out/),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Move to Edu" }),
    );
    await waitFor(() =>
      expect(writes(log)).toEqual([
        { path: LIC, method: "PATCH", body: { tier: "edu" } },
      ]),
    );
  });

  it("a license with no tier shows a muted No tier (D12)", async () => {
    bootLicense(REC, { routes: { [LIC]: { ...DETAIL, tier: null } } });
    await header();
    expect(
      screen.getByRole("button", { name: "Tier: No tier. Change tier" }),
    ).toBeTruthy();
  });

  it("the Activity tab asks the server for this license's entries", async () => {
    const log = bootLicense(`${REC}/activity`, {
      routes: {
        [`${API}/activity`]: {
          items: [
            {
              id: "a1",
              at: NOW_S,
              actor: { sub: "u1", name: "Ada Lovelace", email: "ada@x.io" },
              action: "license.disable",
              target: { kind: "license", id: "lic_1" },
              summary: "Disabled",
            },
          ],
          nextCursor: null,
        },
      },
    });
    await header();
    expect(await screen.findByText("disabled license")).toBeTruthy();
    expect(
      log.calls.some(
        (c) =>
          c.path === `${API}/activity` &&
          c.query.includes("targetKind=license") &&
          c.query.includes("targetId=lic_1"),
      ),
    ).toBe(true);
  });
});

describe("license record: Keys", () => {
  it("collapses revoked keys and shows the hash as first 6 … last 4 (LDT-11)", async () => {
    bootLicense(`${REC}/keys`);
    const t = await screen.findByRole("table", { name: "Keys" });
    expect(within(t).getByText("laptop")).toBeTruthy();
    expect(within(t).queryByText(/deadbe/)).toBeNull();
    expect(within(t).getByText("abcdef…cdef")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Show 1 revoked" }),
    );
    expect(within(t).getByText("Revoked")).toBeTruthy();
  });

  it("revokes behind an L2 confirm", async () => {
    const log = bootLicense(`${REC}/keys`);
    const t = await screen.findByRole("table", { name: "Keys" });
    await userEvent.click(
      within(t).getByRole("button", { name: "Actions for laptop" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Revoke" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/can't be restored/)).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Revoke key" }),
    );
    await waitFor(() =>
      expect(writes(log).map((c) => c.path)).toEqual([
        `${LIC}/keys/abcdef0123456789abcdef/revoke`,
      ]),
    );
  });

  it("mints a key and shows it once, guarded until copied (LIC-2)", async () => {
    const log = bootLicense(`${REC}/keys`, {
      routes: {
        [`POST ${LIC}/keys`]: {
          key: "PK-MINTED-ONESHOT",
          hash: "h",
          record: DETAIL.keys[0],
        },
      },
    });
    await screen.findByRole("table", { name: "Keys" });
    await userEvent.click(
      screen.getAllByRole("button", { name: "Add key" })[0]!,
    );
    const dialog = await screen.findByRole("dialog", { name: "Mint key" });
    await userEvent.type(within(dialog).getByLabelText(/^Label/), "Studio");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Mint key" }),
    );
    expect(await within(dialog).findByText("PK-MINTED-ONESHOT")).toBeTruthy();
    expect(writes(log)[0]).toMatchObject({
      path: `${LIC}/keys`,
      body: { label: "Studio" },
    });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(
      await within(dialog).findByText(/Close without copying\?/),
    ).toBeTruthy();
  });
});

describe("license record: Devices", () => {
  it("uses the shared device table with only valid row actions (LDT-10, DEV-8)", async () => {
    bootLicense(`${REC}/devices`);
    const t = await screen.findByRole("table", { name: "Devices" });
    expect(screen.getByRole("meter", { name: "Seats" })).toBeTruthy();
    // No License column on a license's own devices.
    expect(
      within(t).queryByRole("columnheader", { name: /License/ }),
    ).toBeNull();
    // A deauthorized device without a binding has no actions at all.
    expect(
      within(t).queryByRole("button", { name: "Actions for dev_gone" }),
    ).toBeNull();
    // A row opens the shared device drawer.
    expect(
      within(t)
        .getByRole("link", { name: /Studio Mac/ })
        .getAttribute("href"),
    ).toBe("#/p/djdl/devices/dev_bound");
    await userEvent.click(
      within(t).getByRole("button", { name: "Actions for Studio Mac" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Reset binding" }),
    ).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Deauthorize" })).toBeTruthy();
  });

  it("resets a binding without deauthorizing the device", async () => {
    const log = bootLicense(`${REC}/devices`);
    const t = await screen.findByRole("table", { name: "Devices" });
    await userEvent.click(
      within(t).getByRole("button", { name: "Actions for Studio Mac" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Reset binding" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/stays authorized and keeps its seat/),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Reset binding" }),
    );
    await waitFor(() =>
      expect(writes(log).map((c) => c.path)).toEqual([
        `${LIC}/devices/dev_bound/fingerprint/reset`,
      ]),
    );
  });

  it("deauthorizes behind an L2 confirm", async () => {
    const log = bootLicense(`${REC}/devices`);
    const t = await screen.findByRole("table", { name: "Devices" });
    await userEvent.click(
      within(t).getByRole("button", { name: "Actions for Studio Mac" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Deauthorize" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Deauthorize" }),
    );
    await waitFor(() =>
      expect(writes(log).map((c) => c.path)).toEqual([
        `${LIC}/devices/dev_bound`,
      ]),
    );
  });

  it("filters through the URL under its own keys", async () => {
    bootLicense(`${REC}/devices?devices.status=deauthorized`);
    const t = await screen.findByRole("table", { name: "Devices" });
    await waitFor(() => expect(within(t).queryByText("Studio Mac")).toBeNull());
    expect(within(t).getByText("dev_gone")).toBeTruthy();
  });
});

describe("license record: Config overrides", () => {
  it("shows enforced and hidden states and submits a batch", async () => {
    const log = bootLicense(`${REC}/config`);
    expect(await screen.findByText("feature.timeout")).toBeTruthy();
    // The secret's and the flag's states (a badge and the selected radio each; chunk 7's editor).
    expect(screen.getAllByText("Read-only").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Hidden").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole("button", { name: /Save overrides/ })).toBeNull();
    const timeout = screen.getByLabelText(/^Timeout/);
    await userEvent.clear(timeout);
    await userEvent.type(timeout, "60");
    await userEvent.click(
      await screen.findByRole("button", { name: /Save overrides/ }),
    );
    await waitFor(() =>
      expect(writes(log)[0]).toMatchObject({
        path: `${LIC}/overrides`,
        method: "PUT",
        body: {
          updates: [{ key: "feature.timeout", state: "default", value: 60 }],
        },
      }),
    );
  });

  it("refuses a value the catalog rejects, with the server's own wording", async () => {
    const log = bootLicense(`${REC}/config`);
    const timeout = await screen.findByLabelText(/^Timeout/);
    await userEvent.clear(timeout);
    await userEvent.type(timeout, "500");
    expect(await screen.findByText(/must be <= 120/)).toBeTruthy();
    // Save is refused while the changed row is invalid: it jumps to the error instead (MPE-2).
    expect(screen.getByText(/fix 1 error to save/)).toBeTruthy();
    await userEvent.click(
      await screen.findByRole("button", { name: /Save overrides/ }),
    );
    expect(writes(log)).toEqual([]);
  });

  it("places a 422's fields on the rows that caused them", async () => {
    bootLicense(`${REC}/config`, {
      routes: {
        [`PUT ${LIC}/overrides`]: new Response(
          JSON.stringify({
            error: "bad_request",
            fields: ["feature.timeout must be <= 120"],
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
      },
    });
    const timeout = await screen.findByLabelText(/^Timeout/);
    await userEvent.clear(timeout);
    await userEvent.type(timeout, "60");
    await userEvent.click(
      await screen.findByRole("button", { name: /Save overrides/ }),
    );
    expect(await screen.findByText("must be <= 120")).toBeTruthy();
  });

  it("shows what a profile below contributes to a key the license doesn't set", async () => {
    bootLicense(`${REC}/config`, {
      routes: {
        [`${API}/config/profiles/base`]: {
          id: "base",
          name: "Base",
          payload: {
            config: {
              "feature.retries": { state: "default", value: 3, updatedAt: 1 },
            },
            secrets: {},
            entitlements: {},
          },
        },
        [`${API}/config/catalog`]: {
          schemaVersion: 2,
          entries: [
            {
              key: "feature.retries",
              kind: "config",
              category: "general",
              label: "Retries",
              description: "Retry count.",
              schema: { type: "integer", minimum: 0 },
            },
          ],
        },
      },
    });
    expect(
      await screen.findByText(/inherits 3 from profile “Base”/),
    ).toBeTruthy();
  });

  it("says when Config is off (LDT-5)", async () => {
    bootLicense(`${REC}/config`, {
      services: { ...NONE, license: { enabled: true } },
    });
    expect(
      await screen.findByText("Managed config is off for this product"),
    ).toBeTruthy();
  });

  it("shows the catalog failure instead of an endless skeleton (LDT-5)", async () => {
    bootLicense(`${REC}/config`, {
      routes: { [`${API}/config/catalog`]: failing(500) },
    });
    expect(
      await screen.findByRole("button", { name: /Try again/ }),
    ).toBeTruthy();
  });

  it("warns that inherited values may be incomplete when a profile fails (LDT-6)", async () => {
    bootLicense(`${REC}/config`, {
      routes: { [`${API}/config/profiles/base`]: failing(500) },
    });
    expect(
      await screen.findByText("Inherited values may be incomplete"),
    ).toBeTruthy();
  });
});

describe("license record: offline bundle", () => {
  async function openBundle(
    routes: Record<string, unknown> = {},
    services?: Enablement,
  ) {
    const log = bootLicense(REC, {
      routes: {
        [`POST ${API}/bundles`]: {
          bundleId: "01JBUNDLEID0000000000000A",
          bundle: "eyJhbGciOiJFZERTQSJ9.e30.sig",
        },
        ...routes,
      },
      services,
    });
    await header();
    await more("Mint offline bundle…");
    const dialog = await screen.findByRole("dialog", {
      name: "Mint offline bundle",
    });
    return { log, dialog };
  }
  const CODE = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

  it("defaults the grace window to the ceiling and offers config when Config is on", async () => {
    const { dialog } = await openBundle();
    expect(
      (within(dialog).getByLabelText(/^Grace days/) as HTMLInputElement).value,
    ).toBe("365");
    expect(within(dialog).getByLabelText(/Include configuration/)).toBeTruthy();
  });

  it("mints a bundle and shows its id with a reliable download (LDT-13)", async () => {
    const { log, dialog } = await openBundle();
    await userEvent.type(within(dialog).getByLabelText(/^Device ID/), CODE);
    const grace = within(dialog).getByLabelText(/^Grace days/);
    await userEvent.clear(grace);
    await userEvent.type(grace, "30");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Mint bundle" }),
    );
    expect(
      await within(dialog).findByText("01JBUNDLEID0000000000000A"),
    ).toBeTruthy();
    expect(writes(log)[0]!.body).toEqual({
      deviceId: CODE,
      graceDays: 30,
      includeConfig: true,
      licenseId: "lic_1",
    });
    expect(
      within(dialog).getByRole("button", { name: "Copy ID" }),
    ).toBeTruthy();
    // The bundle itself stays on screen to copy, whatever the browser does with the download.
    expect(
      within(dialog).getByText("eyJhbGciOiJFZERTQSJ9.e30.sig"),
    ).toBeTruthy();
    const download = within(dialog).getByRole("button", { name: /Download/ });
    expect(() => download.click()).not.toThrow();
  });

  it("keeps the minted bundle on Escape until it is saved (C-21)", async () => {
    const { dialog } = await openBundle();
    await userEvent.type(within(dialog).getByLabelText(/^Device ID/), CODE);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Mint bundle" }),
    );
    await within(dialog).findByText("01JBUNDLEID0000000000000A");
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Bundle minted"),
    );
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(
      await within(dialog).findByText(/Close without copying\?/),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Keep it open" }),
    );
    await userEvent.click(within(dialog).getByLabelText(/I've stored it/));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Bundle minted" }),
      ).toBeNull(),
    );
  });

  it("refuses a request code that is not 32 characters", async () => {
    const { log, dialog } = await openBundle();
    await userEvent.type(within(dialog).getByLabelText(/^Device ID/), "short");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Mint bundle" }),
    );
    expect(
      await within(dialog).findByText(/exactly 32 characters/),
    ).toBeTruthy();
    expect(writes(log)).toEqual([]);
  });

  it("asserts no config preference when Config is off", async () => {
    const { log, dialog } = await openBundle(
      {},
      {
        ...NONE,
        license: { enabled: true },
      },
    );
    expect(within(dialog).queryByLabelText(/Include configuration/)).toBeNull();
    await userEvent.type(within(dialog).getByLabelText(/^Device ID/), CODE);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Mint bundle" }),
    );
    await waitFor(() =>
      expect(writes(log)[0]!.body).toEqual({
        deviceId: CODE,
        graceDays: 365,
        licenseId: "lic_1",
      }),
    );
  });
});

describe("license record: device limit (LX-14a)", () => {
  const OWN = {
    ...DETAIL,
    deviceLimit: 3,
    effectiveDeviceLimit: 3,
    deviceLimitSource: "license" as const,
    inheritedDeviceLimit: 5,
    inheritedDeviceLimitSource: "tier" as const,
  };

  it("shows the effective limit and its source in Limits and on the Devices tab", async () => {
    bootLicense(REC, { routes: { [LIC]: OWN } });
    await header();
    const row = within(
      await screen.findByRole("table", { name: /Limits/ }),
    ).getByRole("row", { name: /Devices/ });
    expect(within(row).getByText("3")).toBeTruthy();
    expect(within(row).getByText("Set on this license")).toBeTruthy();
    expect(within(row).getByText("Pro gives 5")).toBeTruthy();
    const tabs = screen.getByRole("navigation", { name: "License sections" });
    expect(
      await within(tabs).findByRole("link", { name: /Devices\s*2\/3/ }),
    ).toBeTruthy();

    await userEvent.click(
      within(screen.getByRole("main")).getByRole("link", { name: /Devices/ }),
    );
    expect((await screen.findByTestId("seat-limit-source")).textContent).toBe(
      "Device limit: 3 · set on this license",
    );
  });

  it("names the tier when the limit is inherited", async () => {
    bootLicense(REC, {
      routes: {
        [LIC]: {
          ...DETAIL,
          deviceLimit: null,
          effectiveDeviceLimit: 5,
          deviceLimitSource: "tier",
          inheritedDeviceLimit: 5,
          inheritedDeviceLimitSource: "tier",
        },
      },
    });
    await header();
    const row = within(
      await screen.findByRole("table", { name: /Limits/ }),
    ).getByRole("row", { name: /Devices/ });
    expect(within(row).getByText("5")).toBeTruthy();
    expect(within(row).getByText("Pro")).toBeTruthy();
    expect(
      within(row).getByRole("button", { name: /Override devices/ }),
    ).toBeTruthy();
  });

  it("sets a lower limit from the sheet, warning that nobody is signed out", async () => {
    const log = bootLicense(REC, {
      routes: {
        [LIC]: {
          ...DETAIL,
          deviceLimit: null,
          effectiveDeviceLimit: 5,
          deviceLimitSource: "tier",
          inheritedDeviceLimit: 5,
          inheritedDeviceLimitSource: "tier",
        },
        [`PATCH ${LIC}`]: {
          ok: true,
          id: "lic_1",
          overLimit: { deviceCount: 2, deviceLimit: 1 },
        },
      },
    });
    await header();
    await more("Device limit…");
    const sheet = await screen.findByRole("dialog", { name: "Device limit" });
    const field = within(sheet).getByRole("textbox", { name: /Devices/ });
    expect(field.getAttribute("placeholder")).toBe("Inherits 5 from Pro");
    expect(
      within(sheet).getByRole("button", { name: "Use inherited limit" }),
    ).toHaveProperty("disabled", true);
    await userEvent.type(field, "1");
    expect(
      within(sheet).getByText(
        "2 devices are signed in. None is signed out; new devices are refused until the count is under 1.",
      ),
    ).toBeTruthy();
    await userEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(writes(log)).toEqual([
        expect.objectContaining({
          path: LIC,
          method: "PATCH",
          body: { deviceLimit: 1 },
        }),
      ]),
    );
    const results = await axe(document.body);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });

  it("warns from the server's dormancy-aware seat count", async () => {
    bootLicense(REC, { routes: { [LIC]: { ...OWN, seatDeviceCount: 1 } } });
    await header();
    await more("Device limit…");
    const sheet = await screen.findByRole("dialog", { name: "Device limit" });
    const field = within(sheet).getByRole("textbox", { name: /Devices/ });
    await userEvent.clear(field);
    await userEvent.type(field, "1");
    // DETAIL has 2 authorized devices, but only 1 still holds a seat: no warning at 1.
    expect(within(sheet).queryByText(/None is signed out/)).toBeNull();
  });

  it("Use inherited limit clears it with null", async () => {
    const log = bootLicense(REC, { routes: { [LIC]: OWN } });
    await header();
    await more("Device limit…");
    const sheet = await screen.findByRole("dialog", { name: "Device limit" });
    expect(
      within(sheet).getByRole("textbox", { name: /Devices/ }),
    ).toHaveProperty("value", "3");
    await userEvent.click(
      within(sheet).getByRole("button", { name: "Use inherited limit" }),
    );
    await waitFor(() =>
      expect(writes(log)).toEqual([
        expect.objectContaining({
          path: LIC,
          method: "PATCH",
          body: { deviceLimit: null },
        }),
      ]),
    );
  });
});
