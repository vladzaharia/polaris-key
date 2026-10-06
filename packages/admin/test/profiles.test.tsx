import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import type {
  ProductCatalog,
  ProfileDetail,
  ProfileSummary,
} from "../src/api.js";
import { resetConsole } from "./consoleHarness.js";
import { apiError, bootConfig } from "./configHarness.js";

/**
 * Config → Profiles and the profile record (docs/design/ADMIN.md §6.6.3), driven through the
 * whole console. Pins PRF-1 to PRF-8: edit details (A-7), Delete disabled while used, the id
 * shown once, the row as the link, create errors told apart, the guarded Back, the description on
 * two lines, and "Used by" with links to the tiers and licenses.
 */

const axe = configureAxe({
  rules: {
    "color-contrast": { enabled: false },
    region: { enabled: false },
  },
});

const P = "/manage/api/products/djdl";

const PROFILES: ProfileSummary[] = [
  {
    id: "base-pro",
    name: "Base (Pro)",
    description: "Baseline config for Pro licenses.",
    modifiedBy: "ada@x.io",
    modifiedAt: 1_700_000_000,
    usedBy: { tiers: 1, licenses: 2 },
  },
  { id: "spare", name: "Spare", usedBy: { tiers: 0, licenses: 0 } },
];

const CATALOG: ProductCatalog = {
  schemaVersion: 2,
  entries: [
    {
      key: "ui.theme",
      kind: "config",
      category: "appearance",
      label: "Theme",
      description: "UI theme",
      schema: { type: "string", enum: ["dark", "light"] },
    },
    {
      key: "beta",
      kind: "flag",
      category: "flags",
      label: "Beta features",
      description: "",
      schema: { type: "boolean" },
    },
  ],
};

const DETAIL: ProfileDetail = {
  id: "base-pro",
  name: "Base (Pro)",
  description: "Baseline config for Pro licenses.",
  modifiedBy: "ada@x.io",
  modifiedAt: 1_700_000_000,
  payload: {
    config: { "ui.theme": { value: "dark", state: "enforced", updatedAt: 1 } },
    secrets: {},
    entitlements: {},
  },
  usedBy: {
    tiers: [{ id: "pro", label: "Pro" }],
    licenses: [{ id: "lic_1", name: "Ada Lovelace", email: "ada@x.io" }],
  },
};

const UNUSED: ProfileDetail = {
  ...DETAIL,
  id: "spare",
  name: "Spare",
  description: undefined,
  usedBy: { tiers: [], licenses: [] },
};

beforeEach(resetConsole);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function axeClean(): Promise<void> {
  const results = await axe(document.querySelector("main")!);
  expect(
    results.violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    ),
  ).toEqual([]);
}

const listRoutes = (extra: Record<string, unknown> = {}) => ({
  [`${P}/config/profiles`]: { profiles: PROFILES },
  [`${P}/config/catalog`]: CATALOG,
  ...extra,
});

// ── the list ───────────────────────────────────────────────────────────────────────────────────

describe("Profiles page", () => {
  it("lists profiles with what uses them; the row is the link (PRF-4)", async () => {
    bootConfig("#/p/djdl/config/profiles", listRoutes());
    const link = await screen.findByRole("link", { name: "Base (Pro)" });
    expect(link.getAttribute("href")).toBe("#/p/djdl/config/profiles/base-pro");
    const row = link.closest("tr")!;
    expect(within(row).getByText("1 tier · 2 licenses")).toBeTruthy();
    expect(within(row).getByText("base-pro")).toBeTruthy();
    // The description wraps to two lines rather than being cut to one (PRF-7).
    expect(
      within(row).getByText("Baseline config for Pro licenses.").className,
    ).toContain("line-clamp-2");
    expect(screen.queryByRole("button", { name: /Edit base-pro/ })).toBeNull();
  });

  it("shows a skeleton while loading, and the first-run state when there are none", async () => {
    let release: (v: unknown) => void = () => undefined;
    bootConfig(
      "#/p/djdl/config/profiles",
      listRoutes({
        [`${P}/config/profiles`]: () =>
          new Promise((r) => {
            release = r;
          }),
      }),
    );
    await screen.findByRole("heading", { level: 1, name: "Profiles" });
    await waitFor(() =>
      expect(document.querySelector('tr[aria-hidden="true"]')).not.toBeNull(),
    );
    release({ profiles: [] });
    expect(await screen.findByText("No profiles yet")).toBeTruthy();
  });

  it("explains a failed load and retries", async () => {
    let fail = true;
    bootConfig(
      "#/p/djdl/config/profiles",
      listRoutes({
        [`${P}/config/profiles`]: () =>
          fail ? apiError(500) : { profiles: PROFILES },
      }),
    );
    const retry = await screen.findByRole("button", { name: "Retry" });
    fail = false;
    await userEvent.click(retry);
    expect(await screen.findByRole("link", { name: "Spare" })).toBeTruthy();
  });

  it("round-trips the search through the URL, with a no-results state", async () => {
    bootConfig("#/p/djdl/config/profiles?q=spare", listRoutes());
    expect(await screen.findByRole("link", { name: "Spare" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Base (Pro)" })).toBeNull();
    const search = screen.getByRole("searchbox", { name: /Search/ });
    await userEvent.clear(search);
    await userEvent.type(search, "zzz");
    await waitFor(() => expect(window.location.hash).toContain("q=zzz"));
    expect(await screen.findByText(/No .*match/)).toBeTruthy();
  });

  it("creates a profile in a drawer, then opens it", async () => {
    const backend = bootConfig(
      "#/p/djdl/config/profiles",
      listRoutes({
        [`POST ${P}/config/profiles`]: { ok: true, id: "studio" },
        [`${P}/config/profiles/studio`]: {
          ...UNUSED,
          id: "studio",
          name: "Studio",
        },
      }),
    );
    await screen.findByRole("link", { name: "Spare" });
    await userEvent.click(screen.getByRole("button", { name: "New profile" }));
    const drawer = await screen.findByRole("dialog", { name: "New profile" });
    await userEvent.type(
      within(drawer).getByRole("textbox", { name: /^Id/ }),
      "studio",
    );
    await userEvent.type(
      within(drawer).getByRole("textbox", { name: /^Name/ }),
      "Studio",
    );
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Create profile" }),
    );
    await waitFor(() =>
      expect(window.location.hash).toBe("#/p/djdl/config/profiles/studio"),
    );
    expect(backend.writes()[0]).toMatchObject({
      method: "POST",
      body: { id: "studio", name: "Studio" },
    });
    // The create invalidated the list.
    await waitFor(() =>
      expect(backend.reads(`${P}/config/profiles`)).toBeGreaterThan(1),
    );
  });

  it("tells a taken id apart from other create failures (PRF-5)", async () => {
    bootConfig(
      "#/p/djdl/config/profiles",
      listRoutes({
        [`POST ${P}/config/profiles`]: apiError(409, {
          reason: "profile_exists",
        }),
      }),
    );
    await screen.findByRole("link", { name: "Spare" });
    await userEvent.click(screen.getByRole("button", { name: "New profile" }));
    const drawer = await screen.findByRole("dialog", { name: "New profile" });
    const id = within(drawer).getByRole("textbox", { name: /^Id/ });
    // Known locally first.
    await userEvent.type(id, "spare");
    expect(within(drawer).getByText("That id is already in use.")).toBeTruthy();
    // Taken on the server since the list loaded.
    await userEvent.clear(id);
    await userEvent.type(id, "fresh");
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Create profile" }),
    );
    expect(
      await within(drawer).findByText("That id is already in use."),
    ).toBeTruthy();
  });

  it("asks for a catalog before a profile can be created (PRF-5)", async () => {
    bootConfig(
      "#/p/djdl/config/profiles",
      listRoutes({ [`${P}/config/catalog`]: apiError(404) }),
    );
    await screen.findByRole("link", { name: "Spare" });
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "New profile" })
          .getAttribute("aria-disabled"),
      ).toBe("true"),
    );
    expect(screen.getByText(/Publish a catalog first/)).toBeTruthy();
  });

  it("deletes only an unused profile, after an L2 confirmation (PRF-2)", async () => {
    const backend = bootConfig(
      "#/p/djdl/config/profiles",
      listRoutes({
        [`DELETE ${P}/config/profiles/spare`]: { ok: true, id: "spare" },
      }),
    );
    await screen.findByRole("link", { name: "Spare" });
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for Base (Pro)" }),
    );
    const used = await screen.findByRole("menuitem", { name: /Delete/ });
    expect(used.getAttribute("aria-disabled")).toBe("true");
    expect(used.textContent).toContain("Used by 1 tier, 2 licenses");
    await userEvent.keyboard("{Escape}");
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for Spare" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Delete/ }),
    );
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText("Delete profile spare?")).toBeTruthy();
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Delete profile" }),
    );
    await waitFor(() =>
      expect(backend.writes()).toEqual([
        expect.objectContaining({
          method: "DELETE",
          path: `${P}/config/profiles/spare`,
        }),
      ]),
    );
    await waitFor(() =>
      expect(backend.reads(`${P}/config/profiles`)).toBeGreaterThan(1),
    );
  });

  it("passes axe", async () => {
    bootConfig("#/p/djdl/config/profiles", listRoutes());
    await screen.findByRole("link", { name: "Spare" });
    await axeClean();
  });
});

// ── the record ─────────────────────────────────────────────────────────────────────────────────

const recordRoutes = (extra: Record<string, unknown> = {}) =>
  listRoutes({
    [`${P}/config/profiles/base-pro`]: DETAIL,
    [`${P}/config/profiles/spare`]: UNUSED,
    ...extra,
  });

describe("Profile record", () => {
  it("shows the profile once, with its tabs (PRF-3)", async () => {
    bootConfig("#/p/djdl/config/profiles/base-pro", recordRoutes());
    await screen.findByRole("heading", { level: 1, name: "Base (Pro)" });
    expect(screen.getAllByText("base-pro")).toHaveLength(1);
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(
      within(crumbs)
        .getByRole("link", { name: "Profiles" })
        .getAttribute("href"),
    ).toBe("#/p/djdl/config/profiles");
    const tabs = screen.getByRole("navigation", { name: "Profile" });
    expect(
      within(tabs)
        .getByRole("link", { name: /Payload/ })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      within(tabs).getByRole("link", { name: /Used by/ }).textContent,
    ).toContain("2");
  });

  it("lists what uses it, linked to each tier and license (PRF-8)", async () => {
    bootConfig("#/p/djdl/config/profiles/base-pro/used-by", recordRoutes());
    const table = await screen.findByRole("table", {
      name: /What uses this profile/,
    });
    expect(
      within(table).getByRole("link", { name: "Pro" }).getAttribute("href"),
    ).toBe("#/p/djdl/license/tiers/pro");
    expect(
      within(table)
        .getByRole("link", { name: "Ada Lovelace" })
        .getAttribute("href"),
    ).toBe("#/p/djdl/license/licenses/lic_1");
  });

  it("edits the name and description (A-7, PRF-1)", async () => {
    const backend = bootConfig(
      "#/p/djdl/config/profiles/base-pro",
      recordRoutes({
        [`PATCH ${P}/config/profiles/base-pro`]: { ok: true, id: "base-pro" },
      }),
    );
    await screen.findByRole("heading", { level: 1, name: "Base (Pro)" });
    await userEvent.click(
      screen.getAllByRole("button", { name: /Edit details/ })[0]!,
    );
    const drawer = await screen.findByRole("dialog", { name: "Edit details" });
    const name = within(drawer).getByRole("textbox", { name: /^Name/ });
    await userEvent.clear(name);
    await userEvent.type(name, "Pro baseline");
    await userEvent.clear(
      within(drawer).getByRole("textbox", { name: /^Description/ }),
    );
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Save details" }),
    );
    await waitFor(() => expect(backend.writes()).toHaveLength(1));
    expect(backend.writes()[0]!.body).toEqual({
      name: "Pro baseline",
      description: null,
    });
    await waitFor(() =>
      expect(backend.reads(`${P}/config/profiles/base-pro`)).toBeGreaterThan(1),
    );
  });

  it("keeps Delete disabled while the profile is used, with the reason (PRF-2)", async () => {
    bootConfig("#/p/djdl/config/profiles/base-pro", recordRoutes());
    await screen.findByRole("heading", { level: 1, name: "Base (Pro)" });
    await userEvent.click(
      screen.getAllByRole("button", { name: "More actions" })[0]!,
    );
    const del = await screen.findByRole("menuitem", { name: /Delete/ });
    expect(del.getAttribute("aria-disabled")).toBe("true");
    expect(del.textContent).toContain("Used by 1 tier, 1 license");
  });

  it("deletes an unused profile and returns to the list", async () => {
    const backend = bootConfig(
      "#/p/djdl/config/profiles/spare",
      recordRoutes({
        [`DELETE ${P}/config/profiles/spare`]: { ok: true, id: "spare" },
      }),
    );
    await screen.findByRole("heading", { level: 1, name: "Spare" });
    await userEvent.click(
      screen.getAllByRole("button", { name: "More actions" })[0]!,
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Delete/ }),
    );
    const confirm = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Delete profile" }),
    );
    await waitFor(() =>
      expect(window.location.hash).toBe("#/p/djdl/config/profiles"),
    );
    expect(backend.writes()[0]).toMatchObject({ method: "DELETE" });
  });

  it("saves the payload and puts a 422 back on its row", async () => {
    let reject = true;
    const backend = bootConfig(
      "#/p/djdl/config/profiles/base-pro",
      recordRoutes({
        [`PUT ${P}/config/profiles/base-pro`]: () =>
          reject
            ? apiError(422, {
                fields: ['ui.theme must be one of "dark", "light"'],
              })
            : { ok: true, id: "base-pro" },
      }),
    );
    await screen.findByText("ui.theme");
    await userEvent.click(screen.getByRole("radio", { name: "Hidden" }));
    await userEvent.click(screen.getByRole("button", { name: "Save payload" }));
    expect(
      await screen.findByText('must be one of "dark", "light"'),
    ).toBeTruthy();
    expect(backend.writes()[0]!.body).toEqual({
      updates: [{ key: "ui.theme", state: "hidden", value: "dark" }],
    });
    // The draft survived the refusal.
    expect(screen.getByText(/1 unsaved change/)).toBeTruthy();
    // Editing the refused row retires the server's message; the save goes through.
    reject = false;
    await userEvent.click(screen.getByRole("radio", { name: "Default" }));
    await waitFor(() =>
      expect(screen.queryByText('must be one of "dark", "light"')).toBeNull(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save payload" }));
    await waitFor(() => expect(backend.writes()).toHaveLength(2));
    await waitFor(() =>
      expect(backend.reads(`${P}/config/profiles/base-pro`)).toBeGreaterThan(1),
    );
  });

  it("asks before leaving with unsaved payload edits (PRF-6)", async () => {
    bootConfig("#/p/djdl/config/profiles/base-pro", recordRoutes());
    await screen.findByText("ui.theme");
    await userEvent.click(screen.getByRole("radio", { name: "Hidden" }));
    await screen.findByText(/1 unsaved change/);
    await userEvent.click(
      within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole(
        "link",
        { name: "Profiles" },
      ),
    );
    const confirm = await screen.findByRole("alertdialog");
    expect(
      within(confirm).getByText("Discard unsaved changes to this profile?"),
    ).toBeTruthy();
    expect(window.location.hash).toBe("#/p/djdl/config/profiles/base-pro");
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Discard" }),
    );
    await waitFor(() =>
      expect(window.location.hash).toBe("#/p/djdl/config/profiles"),
    );
  });

  it("keeps the payload draft across its own tabs without asking (C-33)", async () => {
    bootConfig("#/p/djdl/config/profiles/base-pro", recordRoutes());
    await screen.findByText("ui.theme");
    await userEvent.click(screen.getByRole("radio", { name: "Hidden" }));
    await screen.findByText(/1 unsaved change/);
    const tabs = screen.getByRole("navigation", { name: "Profile" });
    await userEvent.click(within(tabs).getByRole("link", { name: /Used by/ }));
    await waitFor(() =>
      expect(window.location.hash).toBe(
        "#/p/djdl/config/profiles/base-pro/used-by",
      ),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await userEvent.click(within(tabs).getByRole("link", { name: /Payload/ }));
    await waitFor(() =>
      expect(window.location.hash).toBe("#/p/djdl/config/profiles/base-pro"),
    );
    expect(screen.getByText(/1 unsaved change/)).toBeTruthy();
  });

  it("asks for a catalog when the product has none (PRF-7)", async () => {
    bootConfig(
      "#/p/djdl/config/profiles/base-pro",
      recordRoutes({ [`${P}/config/catalog`]: apiError(404) }),
    );
    expect(await screen.findByText("Publish a catalog first")).toBeTruthy();
    expect(screen.queryByText("Could not load the catalog")).toBeNull();
  });

  it("says when the profile does not exist", async () => {
    bootConfig(
      "#/p/djdl/config/profiles/gone",
      recordRoutes({ [`${P}/config/profiles/gone`]: apiError(404) }),
    );
    expect(await screen.findByText("Profile not found")).toBeTruthy();
  });

  it("passes axe", async () => {
    bootConfig("#/p/djdl/config/profiles/base-pro", recordRoutes());
    await screen.findByText("ui.theme");
    await axeClean();
  });
});
