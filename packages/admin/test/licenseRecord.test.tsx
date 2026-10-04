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
  it("shows the status once, the expiry, the holder, the id, sign-in and who changed it", async () => {
    bootLicense(REC);
    await header();
    expect(screen.getAllByText("Active")).toHaveLength(1);
    expect(screen.getByText(/Expires .* \(in \d+ days\)/)).toBeTruthy();
    expect(screen.getByText("ada@x.io")).toBeTruthy();
    expect(screen.getByText("Manual")).toBeTruthy();
    // modifiedBy is the signed-in operator: named, not a raw sub (LDT-9).
    expect(screen.getByText(/Changed .* by Ada Lovelace/)).toBeTruthy();
    const tabs = screen.getByRole("navigation", { name: "License sections" });
    expect(
      within(tabs)
        .getByRole("link", { name: /Overview/ })
        .getAttribute("aria-current"),
    ).toBe("page");
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
    expect(await screen.findByRole("button", { name: /Retry/ })).toBeTruthy();
  });

  it("edits the holder in its own dialog", async () => {
    const log = bootLicense(REC);
    await header();
    await userEvent.click(
      screen.getAllByRole("button", { name: "Edit holder…" })[0]!,
    );
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
    await screen.findByRole("form", { name: "Terms" });
    const results = await axe(document.body);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("license record: Terms", () => {
  async function terms() {
    await header();
    return screen.findByRole("form", { name: "Terms" });
  }

  it("holds every policy field in one form, profiles in order (LDT-1, LDT-3)", async () => {
    bootLicense(REC);
    const form = await terms();
    for (const label of [
      "Tier",
      "Expires",
      "Max offline days",
      "Minimum version",
      "Maximum version",
    ])
      expect(within(form).getByLabelText(new RegExp(`^${label}`))).toBeTruthy();
    expect(within(form).getByText("Position 1:")).toBeTruthy();
    const items = within(form).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining("Base"),
      expect.stringContaining("Studio"),
    ]);
  });

  it("clears max offline days as null and reorders profiles in one save (LDT-2, LDT-3)", async () => {
    const log = bootLicense(REC);
    const form = await terms();
    await userEvent.clear(within(form).getByLabelText(/^Max offline days/));
    await userEvent.click(
      within(form).getByRole("button", { name: "Move Studio up" }),
    );
    const bar = await screen.findByRole("region", {
      name: "Unsaved changes in Terms",
    });
    expect(within(bar).getByText("2 changes in Terms")).toBeTruthy();
    await userEvent.click(
      within(bar).getByRole("button", { name: "Save terms" }),
    );
    await waitFor(() =>
      expect(writes(log)).toEqual([
        {
          path: LIC,
          method: "PATCH",
          body: { maxOfflineDays: null, profiles: ["studio", "base"] },
        },
      ]),
    );
  });

  it("warns on a downgrade below the device count, from the server's count (LDT-12)", async () => {
    bootLicense(REC);
    const form = await terms();
    await userEvent.click(within(form).getByLabelText(/^Tier/));
    await userEvent.click(await screen.findByRole("option", { name: /Edu/ }));
    expect(
      await within(form).findByText(/allows 1 device and this license has 2/),
    ).toBeTruthy();
    // A tier change re-derives the expiry unless one is set: said before saving.
    expect(
      within(form).getByText(/resets the expiry to the new tier's term/),
    ).toBeTruthy();
  });

  it("checks the version window on the client", async () => {
    const log = bootLicense(REC);
    const form = await terms();
    await userEvent.type(
      within(form).getByLabelText(/^Minimum version/),
      "3.0.0",
    );
    await userEvent.type(
      within(form).getByLabelText(/^Maximum version/),
      "2.0.0",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save terms" }));
    expect(
      await within(form).findByText(/maximum version must be/),
    ).toBeTruthy();
    expect(writes(log)).toEqual([]);
  });

  it("keeps the draft across a tab switch and asks before leaving the record (LDT-4)", async () => {
    bootLicense(REC);
    const form = await terms();
    const offline = within(form).getByLabelText(/^Max offline days/);
    await userEvent.clear(offline);
    await userEvent.type(offline, "7");
    await userEvent.click(screen.getByRole("link", { name: /Keys/ }));
    await waitFor(() => expect(window.location.hash).toBe(`${REC}/keys`));
    expect(
      screen.getByRole("link", { name: /Overview/ }).textContent,
    ).toContain("unsaved changes");
    await userEvent.click(screen.getByRole("link", { name: /Overview/ }));
    expect(
      (
        within(await terms()).getByLabelText(
          /^Max offline days/,
        ) as HTMLInputElement
      ).value,
    ).toBe("7");
    // Leaving the record asks first.
    await userEvent.click(
      within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole(
        "link",
        { name: "Licenses" },
      ),
    );
    const confirm = await screen.findByRole("alertdialog");
    expect(
      within(confirm).getByText("Discard unsaved changes to these terms?"),
    ).toBeTruthy();
  });

  it("removes a held dev grant and keeps a held value the picker doesn't offer", async () => {
    const log = bootLicense(REC, {
      routes: { [LIC]: { ...DETAIL, channels: ["stable", "dev", "Legacy.X"] } },
    });
    const form = await terms();
    const group = within(form)
      .getAllByRole("group", { name: "Release channels" })
      .at(-1)!;
    expect(within(group).getByText("not offered")).toBeTruthy();
    await userEvent.click(within(group).getByLabelText("dev"));
    await userEvent.click(within(group).getByLabelText("beta"));
    await userEvent.click(screen.getByRole("button", { name: "Save terms" }));
    await waitFor(() => expect(writes(log)).toHaveLength(1));
    expect((writes(log)[0]!.body as { channels: string[] }).channels).toEqual([
      "stable",
      "beta",
      "Legacy.X",
    ]);
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
      screen.getAllByRole("button", { name: "Mint key" })[0]!,
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
    expect(screen.getAllByText("Enforced").length).toBeGreaterThanOrEqual(2);
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
      await screen.findByText("Config is off for this product"),
    ).toBeTruthy();
  });

  it("shows the catalog failure instead of an endless skeleton (LDT-5)", async () => {
    bootLicense(`${REC}/config`, {
      routes: { [`${API}/config/catalog`]: failing(500) },
    });
    expect(await screen.findByRole("button", { name: /Retry/ })).toBeTruthy();
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
    await userEvent.click(
      screen.getAllByRole("button", { name: "Mint offline bundle…" })[0]!,
    );
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
