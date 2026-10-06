import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import type { ConfigEntry, ProductCatalog } from "../src/api.js";
import { resetConsole } from "./consoleHarness.js";
import { apiError, bootConfig } from "./configHarness.js";
import {
  guessDefault,
  labelFromKey,
} from "../src/console/pages/config/CatalogEntryForm.js";

/**
 * Config → Catalog (docs/design/ADMIN.md §6.6.1) and its editor (§6.6.2), driven through the
 * whole console. Pins CAT-1 to CAT-8: the first publish, ownership, the dense table and facets,
 * the key drawer's "Overridden by" (A-7b), version history (A-6), the persisted draft, the review
 * with breaking removals, `expectedVersion` and the 409.
 */

const axe = configureAxe({
  rules: {
    "color-contrast": { enabled: false },
    region: { enabled: false },
  },
});

const P = "/manage/api/products/djdl";

const E = (
  key: string,
  kind: ConfigEntry["kind"],
  category: string,
  extra: Partial<ConfigEntry> = {},
): ConfigEntry => ({
  key,
  kind,
  category,
  label: key.split(".").pop()!,
  description: `About ${key}`,
  schema: { type: kind === "flag" ? "boolean" : "string" },
  ...extra,
});

const ENTRIES: ConfigEntry[] = [
  E("network.proxy.url", "config", "Network", { label: "Proxy URL" }),
  E("network.timeout", "config", "Network", {
    label: "Timeout",
    schema: { type: "integer", minimum: 1 },
    default: 30,
    managementDefault: "enforced",
  }),
  E("license.hd", "flag", "Content", { label: "HD", userGrant: true }),
  E("sentry.dsn", "secret", "Telemetry", { label: "Sentry DSN" }),
];
const CATALOG: ProductCatalog = { schemaVersion: 8, entries: ENTRIES };

const NO_USAGE = (keys: string[]) => ({
  keys: Object.fromEntries(
    keys.map((k) => [k, { profiles: [], tiers: [], licenses: [] }]),
  ),
});

beforeEach(() => {
  resetConsole();
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const table = (): HTMLElement =>
  screen.getByRole("table", { name: /Catalog keys/ });

async function axeClean(): Promise<void> {
  const main = document.querySelector("main")!;
  const results = await axe(main);
  expect(
    results.violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    ),
  ).toEqual([]);
}

// ── the catalog page ───────────────────────────────────────────────────────────────────────────

describe("Catalog page", () => {
  it("lists every key in one dense table with kind and management (CAT-7)", async () => {
    bootConfig("#/p/djdl/config/catalog", { [`${P}/config/catalog`]: CATALOG });
    await screen.findByRole("heading", { level: 1, name: "Catalog" });
    await waitFor(() =>
      expect(within(table()).getAllByRole("row")).toHaveLength(5),
    );
    expect(screen.getByText("v8")).toBeTruthy();
    expect(screen.getByText("4 keys")).toBeTruthy();
    const timeout = within(table()).getByText("network.timeout").closest("tr")!;
    expect(within(timeout).getByText("Config")).toBeTruthy();
    expect(within(timeout).getByText("Enforced")).toBeTruthy();
    expect(within(timeout).getByText("30")).toBeTruthy();
    const dsn = within(table()).getByText("sentry.dsn").closest("tr")!;
    expect(within(dsn).getByText("(write-only)")).toBeTruthy();
  });

  it("shows who owns the catalog (CAT-3)", async () => {
    bootConfig(
      "#/p/djdl/config/catalog",
      { [`${P}/config/catalog`]: CATALOG },
      { product: { releaseSource: "github" } },
    );
    expect(
      await screen.findByRole("button", { name: /From manifest/ }),
    ).toBeTruthy();
  });

  it("shows a skeleton while loading", async () => {
    bootConfig("#/p/djdl/config/catalog", {
      [`${P}/config/catalog`]: () => new Promise(() => undefined),
    });
    await waitFor(() =>
      expect(document.querySelector('[data-skeleton="table"]')).not.toBeNull(),
    );
  });

  it("explains a failed load and retries", async () => {
    let fail = true;
    const backend = bootConfig("#/p/djdl/config/catalog", {
      [`${P}/config/catalog`]: () => (fail ? apiError(500) : CATALOG),
    });
    const retry = await screen.findByRole("button", { name: "Retry" });
    fail = false;
    await userEvent.click(retry);
    await screen.findByText("network.timeout");
    expect(backend.reads(`${P}/config/catalog`)).toBe(2);
  });

  it("opens the editor seeded empty when there is no catalog yet (CAT-1)", async () => {
    bootConfig("#/p/djdl/config/catalog", {
      [`${P}/config/catalog`]: apiError(404),
    });
    await screen.findByText("No catalog yet");
    await userEvent.click(
      screen.getByRole("button", { name: "Create catalog" }),
    );
    await screen.findByRole("heading", { level: 1, name: "Edit catalog" });
    expect(window.location.hash).toBe("#/p/djdl/config/catalog/edit");
    expect(screen.getByText("Draft v1")).toBeTruthy();
    expect(screen.getByText("No entries yet")).toBeTruthy();
  });

  it("filters by kind from the URL and writes the search back to it", async () => {
    bootConfig("#/p/djdl/config/catalog?kind=flag", {
      [`${P}/config/catalog`]: CATALOG,
    });
    await screen.findByText("license.hd");
    expect(screen.queryByText("network.timeout")).toBeNull();
    await userEvent.type(
      screen.getByRole("searchbox", { name: /Search/ }),
      "nothing-matches",
    );
    await waitFor(() =>
      expect(window.location.hash).toContain("q=nothing-matches"),
    );
    expect(window.location.hash).toContain("kind=flag");
    expect(await screen.findByText(/No .*match/)).toBeTruthy();
  });

  it("opens a key drawer with what overrides the key (A-7b)", async () => {
    const backend = bootConfig("#/p/djdl/config/catalog", {
      [`${P}/config/catalog`]: CATALOG,
      [`${P}/config/catalog/usage`]: {
        keys: {
          "network.timeout": {
            profiles: [{ id: "base-pro", name: "Base (Pro)" }],
            tiers: [{ id: "pro", label: "Pro", profile: "base-pro" }],
            licenses: [{ id: "lic_1", name: "Ada", email: "ada@x.io" }],
          },
        },
      },
    });
    await userEvent.click(
      await screen.findByRole("link", { name: /network\.timeout/ }),
    );
    const drawer = await screen.findByRole("dialog", { name: "Timeout" });
    expect(window.location.hash).toContain("key=network.timeout");
    expect(
      await within(drawer).findByRole("link", { name: "Base (Pro)" }),
    ).toBeTruthy();
    expect(
      within(drawer).getByRole("link", { name: /Pro \(via base-pro\)/ }),
    ).toBeTruthy();
    expect(
      within(drawer).getByRole("link", { name: "Ada" }).getAttribute("href"),
    ).toBe("#/p/djdl/license/licenses/lic_1");
    const usage = backend.calls.find((c) => c.path.endsWith("/catalog/usage"))!;
    expect(usage.query).toBe("key=network.timeout");
  });

  it("compares an earlier version with the active one (A-6)", async () => {
    bootConfig("#/p/djdl/config/catalog", {
      [`${P}/config/catalog`]: CATALOG,
      [`${P}/config/catalog/versions`]: {
        versions: [
          {
            version: 8,
            active: true,
            createdAt: 1_700_000_000,
            entryCount: 4,
            source: "admin",
            publishedBy: "ada@x.io",
          },
          {
            version: 7,
            active: false,
            createdAt: 1_699_000_000,
            entryCount: 4,
            source: "manifest",
            publishedBy: null,
          },
        ],
      },
      [`${P}/config/catalog/versions/7`]: {
        schemaVersion: 7,
        entries: [...ENTRIES.slice(0, 3), E("old.key", "config", "Old")],
      },
    });
    await screen.findByText("network.timeout");
    await userEvent.click(
      screen.getByRole("button", { name: /Version history/ }),
    );
    const drawer = await screen.findByRole("dialog", {
      name: "Version history",
    });
    await userEvent.click(
      await within(drawer).findByRole("button", {
        name: "Compare with active",
      }),
    );
    expect(await within(drawer).findByText("v7 → v8")).toBeTruthy();
    expect(await within(drawer).findByText("old.key")).toBeTruthy();
    expect(within(drawer).getByText("sentry.dsn")).toBeTruthy();
    expect(window.location.hash).toContain("version=7");
  });

  it("passes axe", async () => {
    bootConfig("#/p/djdl/config/catalog", { [`${P}/config/catalog`]: CATALOG });
    await screen.findByText("network.timeout");
    await axeClean();
  });
});

// ── the editor ─────────────────────────────────────────────────────────────────────────────────

async function openEditor(
  routes: Record<string, unknown> = {},
  hash = "#/p/djdl/config/catalog/edit?entry=network.timeout",
  product?: Record<string, unknown>,
) {
  const backend = bootConfig(
    hash,
    {
      [`${P}/config/catalog`]: CATALOG,
      [`${P}/config/catalog/usage`]: NO_USAGE(["x"]),
      [`PUT ${P}/config/catalog`]: { ok: true, schemaVersion: 9 },
      ...routes,
    },
    { product },
  );
  await screen.findByRole("heading", { level: 1, name: "Edit catalog" });
  return backend;
}

const labelBox = async (): Promise<HTMLInputElement> =>
  (await screen.findByRole("textbox", { name: /^Label/ })) as HTMLInputElement;

describe("Catalog editor", () => {
  it("edits an entry in the form and publishes it with expectedVersion (A-6)", async () => {
    const backend = await openEditor();
    expect(screen.getByText("Draft v9")).toBeTruthy();
    const label = await labelBox();
    await userEvent.clear(label);
    await userEvent.type(label, "Request timeout");
    expect(await screen.findByText(/1 changed/)).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Review changes" }),
    );
    const drawer = await screen.findByRole("dialog", {
      name: "Publish version 9",
    });
    expect(within(drawer).getByText(/"Timeout"/)).toBeTruthy();
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Publish version 9" }),
    );
    await waitFor(() =>
      expect(window.location.hash).toBe("#/p/djdl/config/catalog"),
    );
    const put = backend.writes().find((c) => c.method === "PUT")!;
    expect(put.body).toMatchObject({ expectedVersion: 8 });
    const sent = (put.body as { catalog: ProductCatalog }).catalog;
    expect(sent.entries.find((e) => e.key === "network.timeout")!.label).toBe(
      "Request timeout",
    );
    expect(window.sessionStorage.getItem("pk-catalog-draft:djdl")).toBeNull();
    // The publish invalidated the catalog, so the page reads it again.
    await waitFor(() =>
      expect(backend.reads(`${P}/config/catalog`)).toBeGreaterThan(1),
    );
  });

  it("keeps the draft in this tab across leaving and coming back (CAT-6)", async () => {
    await openEditor();
    const label = await labelBox();
    await userEvent.clear(label);
    await userEvent.type(label, "Kept");
    await waitFor(() =>
      expect(window.sessionStorage.getItem("pk-catalog-draft:djdl")).toContain(
        "Kept",
      ),
    );
    cleanup();
    vi.unstubAllGlobals();
    await openEditor();
    expect((await labelBox()).value).toBe("Kept");
  });

  it("adds an entry and publishes the first version with expectedVersion 0 (CAT-1)", async () => {
    const backend = await openEditor(
      {
        [`${P}/config/catalog`]: apiError(404),
        [`PUT ${P}/config/catalog`]: { ok: true, schemaVersion: 1 },
      },
      "#/p/djdl/config/catalog/edit",
    );
    await userEvent.click(
      screen.getAllByRole("button", { name: "Add entry" })[0]!,
    );
    expect(await screen.findByText(/\+1 key/)).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Review changes" }),
    );
    const drawer = await screen.findByRole("dialog");
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Publish version 1" }),
    );
    await waitFor(() => expect(backend.writes()).toHaveLength(1));
    expect(backend.writes()[0]!.body).toMatchObject({
      expectedVersion: 0,
      catalog: { entries: [{ key: "new.key", kind: "config" }] },
    });
  });

  it("blocks review while the draft has an error, and names it", async () => {
    await openEditor();
    const key = await screen.findByRole("textbox", { name: /^Key/ });
    await userEvent.clear(key);
    await userEvent.type(key, "network.proxy.url");
    expect(
      await screen.findByText("The key network.proxy.url is used twice."),
    ).toBeTruthy();
    expect(screen.getByText(/1 error/)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Review changes" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("requires the acknowledgement for a breaking removal (L2)", async () => {
    const backend = await openEditor({
      [`${P}/config/catalog/usage`]: {
        keys: {
          "network.timeout": {
            profiles: [{ id: "base-pro", name: "Base (Pro)" }],
            tiers: [],
            licenses: [],
          },
        },
      },
    });
    await userEvent.click(
      await screen.findByRole("button", { name: "Remove entry" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Review changes" }),
    );
    const drawer = await screen.findByRole("dialog");
    expect(
      await within(drawer).findByText(
        /Breaking: referenced by profile base-pro/,
      ),
    ).toBeTruthy();
    const publish = within(drawer).getByRole("button", {
      name: "Publish version 9",
    });
    await waitFor(() =>
      expect(publish.getAttribute("aria-disabled")).toBe("true"),
    );
    await userEvent.click(within(drawer).getByRole("checkbox"));
    // The button re-renders without its disabled reason (a fresh element), so query it again.
    const enabled = within(drawer).getByRole("button", {
      name: "Publish version 9",
    });
    expect(enabled.getAttribute("aria-disabled")).toBeNull();
    await userEvent.click(enabled);
    await waitFor(() => expect(backend.writes()).toHaveLength(1));
  });

  it("warns that publishing claims a manifest-owned catalog (CAT-3, ST-01b)", async () => {
    await openEditor({}, undefined, { releaseSource: "github" });
    await userEvent.type(await labelBox(), "!");
    await userEvent.click(
      screen.getByRole("button", { name: "Review changes" }),
    );
    const drawer = await screen.findByRole("dialog");
    expect(
      within(drawer).getByText("This catalog is manifest-owned"),
    ).toBeTruthy();
    expect(
      within(drawer).getByText(/Publishing claims it for the console/),
    ).toBeTruthy();
  });

  it("keeps a refused publish's error inline, with no toast (CAT-6)", async () => {
    await openEditor({
      [`PUT ${P}/config/catalog`]: apiError(422, {
        fields: ["network.timeout: unsupported keyword"],
      }),
    });
    await userEvent.type(await labelBox(), "!");
    await userEvent.click(
      screen.getByRole("button", { name: "Review changes" }),
    );
    const drawer = await screen.findByRole("dialog");
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Publish version 9" }),
    );
    const alert = await within(drawer).findByRole("alert");
    expect(alert.textContent).toContain("network.timeout: unsupported keyword");
    expect(document.querySelector("[data-sonner-toast]")).toBeNull();
  });

  it("shows what changed on the server after a 409 and rebases on request", async () => {
    let active: ProductCatalog = CATALOG;
    const backend = await openEditor({
      [`${P}/config/catalog`]: () => active,
      [`PUT ${P}/config/catalog`]: () => {
        active = {
          schemaVersion: 9,
          entries: [...ENTRIES, E("teammate.key", "config", "Team")],
        };
        return apiError(409, {
          reason: "catalog_version_conflict",
          currentVersion: 9,
        });
      },
    });
    await userEvent.type(await labelBox(), "!");
    await userEvent.click(
      screen.getByRole("button", { name: "Review changes" }),
    );
    let drawer = await screen.findByRole("dialog");
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Publish version 9" }),
    );
    drawer = await screen.findByRole("dialog", {
      name: "The catalog changed since you started",
    });
    expect(await within(drawer).findByText("teammate.key")).toBeTruthy();
    await userEvent.click(
      within(drawer).getByRole("button", {
        name: "Review my draft against v9",
      }),
    );
    drawer = await screen.findByRole("dialog", { name: "Publish version 10" });
    // Publishing over v9 now would drop the teammate's key: the review shows it as removed.
    expect(within(drawer).getByText("teammate.key")).toBeTruthy();
    expect(backend.writes()).toHaveLength(1);
  });

  it("switches between form and JSON without losing the draft (CAT-4)", async () => {
    await openEditor();
    const label = await labelBox();
    await userEvent.clear(label);
    await userEvent.type(label, "Both modes");
    await userEvent.click(screen.getByRole("radio", { name: "JSON" }));
    expect(await screen.findByText(/The whole catalog as JSON/)).toBeTruthy();
    expect(window.location.hash).toContain("mode=json");
    await userEvent.click(screen.getByRole("radio", { name: "Form" }));
    expect((await labelBox()).value).toBe("Both modes");
  });

  it("explains a failed catalog load instead of opening an empty draft", async () => {
    bootConfig("#/p/djdl/config/catalog/edit", {
      [`${P}/config/catalog`]: apiError(500),
    });
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText("No entries yet")).toBeNull();
    expect(window.sessionStorage.getItem("pk-catalog-draft:djdl")).toBeNull();
  });

  it("passes axe", async () => {
    await openEditor();
    await labelBox();
    await axeClean();
  });
});

// ── the entry form's progressive disclosure (EXPERIENCE.md §0.4 S4, UX-34) ──────────────────────

describe("Catalog entry form", () => {
  it("derives a label from the key's last segment", () => {
    expect(labelFromKey("audio.bufferSize")).toBe("Buffer size");
    expect(labelFromKey("net.retry_count")).toBe("Retry count");
    expect(labelFromKey("ui.dark-mode")).toBe("Dark mode");
    expect(labelFromKey("sentry.DSN")).toBe("DSN");
    expect(labelFromKey("telemetry.sentryDSNUrl")).toBe("Sentry DSN url");
    expect(labelFromKey("")).toBe("");
  });

  it("guesses a type from a typed default", () => {
    expect(guessDefault("")).toBeNull();
    expect(guessDefault("true")).toEqual({ type: "boolean", value: true });
    expect(guessDefault("512")).toEqual({ type: "integer", value: 512 });
    expect(guessDefault("-0.5")).toEqual({ type: "number", value: -0.5 });
    expect(guessDefault("[1, 2]")).toEqual({ type: "array", value: [1, 2] });
    expect(guessDefault('{"a":1}')).toEqual({
      type: "object",
      value: { a: 1 },
    });
    expect(guessDefault("[not json")).toEqual({
      type: "string",
      value: "[not json",
    });
    expect(guessDefault(" eu-west ")).toEqual({
      type: "string",
      value: " eu-west ",
    });
  });

  it("leads with key, kind, type and default and collapses the rest", async () => {
    await openEditor(
      {},
      "#/p/djdl/config/catalog/edit?entry=network.proxy.url",
    );
    for (const name of [/^Key/, /^Label/])
      expect(await screen.findByRole("textbox", { name })).toBeTruthy();
    // A category suggests the draft's others, so it is a combobox.
    expect(screen.getByRole("combobox", { name: /^Category/ })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: /^Type/ })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: /^Default/ })).toBeTruthy();
    const validation = screen.getByText("Validation").closest("details")!;
    const hints = screen.getByText("Form hints").closest("details")!;
    expect(validation.open).toBe(false);
    expect(hints.open).toBe(false);
    await userEvent.click(screen.getByText("Validation"));
    await waitFor(() => expect(validation.open).toBe(true));
  });

  it("opens Validation by itself when the entry has rules", async () => {
    await openEditor();
    const validation = (await screen.findByText("Validation")).closest(
      "details",
    )!;
    expect(validation.open).toBe(true);
    expect(screen.getByRole("spinbutton", { name: /^Minimum$/ })).toBeTruthy();
  });

  it("rewrites a derived label as the key changes, never a typed one", async () => {
    const backend = await openEditor(
      {
        [`${P}/config/catalog`]: apiError(404),
        [`PUT ${P}/config/catalog`]: { ok: true, schemaVersion: 1 },
      },
      "#/p/djdl/config/catalog/edit",
    );
    await userEvent.click(
      screen.getAllByRole("button", { name: "Add entry" })[0]!,
    );
    const key = await screen.findByRole("textbox", { name: /^Key/ });
    await userEvent.clear(key);
    await userEvent.type(key, "audio.bufferSize");
    expect((await labelBox()).value).toBe("Buffer size");

    const label = await labelBox();
    await userEvent.clear(label);
    await userEvent.type(label, "Buffer");
    await userEvent.type(key, "Ms");
    expect((await labelBox()).value).toBe("Buffer");

    // The type follows the typed default on a new entry.
    const value = screen.getByRole("textbox", { name: /^Default/ });
    await userEvent.type(value, "512");
    expect(await screen.findByText("Guessed from the default.")).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: /^Type/ }).textContent,
    ).toContain("Whole number");
    await userEvent.click(
      screen.getByRole("button", { name: "Review changes" }),
    );
    const drawer = await screen.findByRole("dialog");
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Publish version 1" }),
    );
    await waitFor(() => expect(backend.writes()).toHaveLength(1));
    expect(backend.writes()[0]!.body).toMatchObject({
      catalog: {
        entries: [
          {
            key: "audio.bufferSizeMs",
            label: "Buffer",
            schema: { type: "integer" },
            default: 512,
          },
        ],
      },
    });
  });

  it("keeps the typed default control on an entry that already exists", async () => {
    await openEditor();
    // network.timeout is an integer with a default: its Default is the number box, not a guess.
    expect(
      await screen.findByRole("spinbutton", { name: /^Default/ }),
    ).toBeTruthy();
    expect(screen.queryByText("Guessed from the default.")).toBeNull();
  });
});
