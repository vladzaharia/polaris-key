/**
 * Cloud Sync in the console (U-04): the Data page (read-only, over the catalog's declarations),
 * the catalog editor's "User setting" fields and the editor's user-block checks, which are the
 * publish route's own (`userSettingIssues` in `@polaris-key/catalog`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import type { ConfigEntry, ProductCatalog, ProductDetail } from "../src/api.js";
import { ApiError } from "../src/api.js";
import { resetCache } from "../src/context.js";
import { KitProviders } from "../src/kit/KitProviders.js";
import { catalogIssues } from "../src/schema/catalogValidation.js";

const product = vi.fn<(slug: string) => Promise<{ product: ProductDetail }>>();
const schema = vi.fn<(slug: string) => Promise<ProductCatalog>>();

vi.mock("../src/api.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
  return {
    ...actual,
    api: {
      product: (slug: string) => product(slug),
      schema: (slug: string) => schema(slug),
    },
  };
});

const { SyncDataPage } = await import("../src/console/pages/sync/SyncData.js");
const { CatalogEntryForm } =
  await import("../src/console/pages/config/CatalogEntryForm.js");

const axe = configureAxe({
  rules: {
    "color-contrast": { enabled: false },
    region: { enabled: false },
  },
});

const services = (sync: boolean): ProductDetail["services"] => ({
  license: { enabled: true },
  config: { enabled: true },
  release: { enabled: false },
  distribution: { enabled: false },
  update: { enabled: false },
  identity: { enabled: true },
  sync: { enabled: sync },
});

const PRODUCT = (sync: boolean): ProductDetail => ({
  slug: "djdl",
  name: "DJDL",
  signingKid: "kid-2026",
  releaseSource: "github",
  compatMin: "1.0.0",
  compatMax: "2.0.0",
  defaultMaxOfflineDays: 14,
  defaultDeviceLimit: 3,
  adminGroup: "djdl-admins",
  createdAt: 1_700_000_000,
  modifiedAt: 1_710_000_000,
  services: services(sync),
});

const entry = (over: Partial<ConfigEntry> & { key: string }): ConfigEntry => ({
  kind: "config",
  category: "Audio",
  label: over.key,
  description: "",
  schema: { type: "number" },
  ...over,
});

const CATALOG: ProductCatalog = {
  schemaVersion: 3,
  entries: [
    entry({ key: "audio.volume", user: { sync: "user", conflict: "max" } }),
    entry({
      key: "input.bindings",
      schema: { type: "object" },
      user: { sync: "platform", conflict: "merge", listed: false },
    }),
    entry({ key: "server.url", schema: { type: "string" } }),
  ],
  cloudSync: {
    collections: [
      { name: "progress", access: "owner", onAttach: "merge" },
      { name: "notes", access: "server" },
    ],
    saves: { conflict: "mostRecent", requiresFlag: "cloudSaves" },
    migrations: [
      { toSchemaVersion: 3, rename: { "audio.vol": "audio.volume" } },
    ],
  },
};

function renderPage() {
  return render(
    <KitProviders>
      <div data-service="sync">
        <SyncDataPage slug="djdl" />
      </div>
    </KitProviders>,
  );
}

beforeEach(() => {
  resetCache();
  product.mockReset();
  schema.mockReset();
  product.mockResolvedValue({ product: PRODUCT(true) });
  schema.mockResolvedValue(CATALOG);
});
afterEach(cleanup);

describe("Cloud Sync → Data", () => {
  it("lists the user settings, collections, saves and migrations the catalog declares", async () => {
    const { container } = renderPage();
    const settings = await screen.findByRole("table", {
      name: "User settings",
    });
    const rows = within(settings).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      "audio.volumeEverywhere the person signs inKeep the highestShown",
      "input.bindingsPer platform familyMerge membersHidden",
    ]);
    const collections = screen.getByRole("table", { name: "Collections" });
    expect(within(collections).getByText("progress")).toBeTruthy();
    expect(
      within(collections).getByText("Console and backend only"),
    ).toBeTruthy();
    expect(screen.getByText("cloudSaves")).toBeTruthy();
    expect(screen.getByText("mostRecent")).toBeTruthy();
    expect(screen.getByText(/audio\.vol → audio\.volume/)).toBeTruthy();
    expect((await axe(container)).violations).toEqual([]);
  });

  it("says that only signed-in people sync, and key-activated devices keep settings locally", async () => {
    renderPage();
    expect(await screen.findByText("Only signed-in people sync")).toBeTruthy();
    expect(
      screen.getByText(/activated with a licence key keep their settings/),
    ).toBeTruthy();
  });

  it("shows the platform ceilings declared limits are held to", async () => {
    renderPage();
    await screen.findByRole("table", { name: "User settings" });
    expect(screen.getByText("Settings per person")).toBeTruthy();
    expect(screen.getByText("People holding data")).toBeTruthy();
    expect(screen.getByText("100,000")).toBeTruthy();
  });

  it("before the first catalog publish, declares nothing rather than failing", async () => {
    schema.mockRejectedValue(new ApiError(404));
    renderPage();
    expect(
      await screen.findByText("No catalog key is a user setting."),
    ).toBeTruthy();
    expect(screen.getByText("No collections are declared.")).toBeTruthy();
    expect(screen.getByText("Saves are not declared.")).toBeTruthy();
  });

  it("with Cloud Sync off, offers the Services page instead", async () => {
    product.mockResolvedValue({ product: PRODUCT(false) });
    renderPage();
    expect(
      await screen.findByText("Cloud Sync is off for this product"),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Services" })).toBeTruthy();
  });
});

describe("the catalog editor's User setting fields", () => {
  function renderForm(initial: ConfigEntry) {
    const onChange = vi.fn<(next: ConfigEntry) => void>();
    const utils = render(
      <KitProviders>
        <CatalogEntryForm
          entry={initial}
          issues={catalogIssues({ schemaVersion: 1, entries: [initial] })}
          categories={[]}
          onChange={onChange}
        />
      </KitProviders>,
    );
    return { onChange, ...utils };
  }

  it("turns a config key into a user setting, syncing everywhere by default", async () => {
    const user = userEvent.setup();
    const { onChange } = renderForm(entry({ key: "audio.volume" }));
    await user.click(
      screen.getByRole("checkbox", { name: /People choose this value/ }),
    );
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ user: { sync: "user" } }),
    );
  });

  it("hides the listed flag's default and drops the block when unchecked", async () => {
    const user = userEvent.setup();
    const { onChange } = renderForm(
      entry({ key: "audio.volume", user: { sync: "user" } }),
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Show in settings panels" }),
    );
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ user: { sync: "user", listed: false } }),
    );
    await user.click(
      screen.getByRole("checkbox", { name: /People choose this value/ }),
    );
    expect(onChange.mock.lastCall![0].user).toBeUndefined();
  });

  it("shows the publish route's own refusal on the section", () => {
    renderForm(
      entry({
        key: "audio.volume",
        schema: { type: "string" },
        user: { sync: "user", conflict: "max" },
      }),
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "user.conflict max needs a number schema.",
    );
  });

  it("offers no User setting section on a secret or a flag", () => {
    renderForm(entry({ key: "api.token", kind: "secret" }));
    expect(screen.queryByText("User setting")).toBeNull();
  });
});

describe("catalogIssues: user blocks (Cloud Sync rules 1–5)", () => {
  const issues = (e: ConfigEntry) =>
    catalogIssues({ schemaVersion: 1, entries: [e] }).map((i) => [
      i.field,
      i.message,
    ]);

  it("accepts a valid user setting", () => {
    expect(
      issues(entry({ key: "a", user: { sync: "device", conflict: "min" } })),
    ).toEqual([]);
  });

  it("refuses one on a flag, under a locked default, or with union", () => {
    expect(
      issues(entry({ key: "a", kind: "flag", user: { sync: "user" } })),
    ).toEqual([["user", "user is only valid on config entries."]]);
    expect(
      issues(
        entry({
          key: "a",
          managementDefault: "hidden",
          user: { sync: "user" },
        }),
      ),
    ).toEqual([
      [
        "user",
        "user is not allowed on a key whose managementDefault is enforced or hidden.",
      ],
    ]);
    expect(
      issues(
        entry({
          key: "a",
          schema: { type: "object" },
          user: { sync: "user", conflict: "union" as never },
        }),
      )[0]![1],
    ).toMatch(/cannot be union/);
  });

  it("puts a merge value's member limit on the schema", () => {
    expect(
      issues(
        entry({
          key: "a",
          schema: { type: "object", maxProperties: 300 },
          user: { sync: "user", conflict: "merge" },
        }),
      ),
    ).toEqual([
      [
        "schema",
        "A merged value has at most 256 top-level members (maxProperties and declared properties).",
      ],
    ]);
  });
});
