/**
 * Cloud Sync in the console (U-04, plans/U-01b.md §3.3): the Data page (read-only, over the
 * catalog's declarations and the platform constants), the catalog editor's "Synced setting"
 * fields and the editor's user-block checks, which are the publish route's own
 * (`userSettingIssues` in `@polaris-key/catalog`; only its errors block).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import type { ConfigEntry, ProductCatalog, ProductDetail } from "../src/api.js";
import { ApiError } from "../src/api.js";
import { KitProviders } from "../src/kit/KitProviders.js";
import {
  catalogDiagnostics,
  catalogIssues,
  catalogNotes,
} from "../src/schema/catalogValidation.js";

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

const { SyncDataPage, formatBinaryBytes } =
  await import("../src/console/sections/sync/pages/SyncData.js");
const { CatalogEntryForm } =
  await import("../src/console/sections/config/components/CatalogEntryForm.js");

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
    // No user block: an Editable key syncs everywhere, last write wins (D2).
    entry({ key: "server.url", schema: { type: "string" } }),
    // Never synced: a local key, a locked key, a secret.
    entry({ key: "ui.window", user: { sync: "local" } }),
    entry({ key: "ops.mode", managementDefault: "enforced" }),
    entry({ key: "api.token", kind: "secret", schema: { type: "string" } }),
  ],
  cloudSync: {
    collections: [
      { name: "saves", template: "saves", requires: "cloudSaves" },
      { name: "progress", conflict: "max", conflictField: "level" },
    ],
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
  product.mockReset();
  schema.mockReset();
  product.mockResolvedValue({ product: PRODUCT(true) });
  schema.mockResolvedValue(CATALOG);
});
afterEach(cleanup);

describe("Cloud Sync → Data", () => {
  it("lists every Editable key as a synced setting, with or without a user block", async () => {
    const { container } = renderPage();
    const settings = await screen.findByRole("table", {
      name: "Synced settings",
    });
    const rows = within(settings).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      "audio.volumeEverywhere the person signs inKeep the highestShown",
      "input.bindingsPer platform familyMerge membersHidden",
      "server.urlEverywhere the person signs inLast write winsShown",
    ]);
    // Negative control: a local key, a locked key and a secret never sync.
    for (const key of ["ui.window", "ops.mode", "api.token"])
      expect(within(settings).queryByText(key)).toBeNull();
    expect(
      screen.getByText(/Keys the game adds itself also sync/),
    ).toBeTruthy();
    expect((await axe(container)).violations).toEqual([]);
  });

  it("shows the settings budget from the constants: 256 keys and 64 KiB per player", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Synced settings" });
    expect(screen.getByText("Keys per player")).toBeTruthy();
    expect(screen.getByText("Up to 256")).toBeTruthy();
    expect(screen.getByText("Size per player")).toBeTruthy();
    expect(screen.getByText("Up to 64 KiB")).toBeTruthy();
  });

  it("resolves each collection over its template: saves slots are pinned at 16", async () => {
    renderPage();
    const collections = await screen.findByRole("table", {
      name: "Collections",
    });
    const rows = within(collections).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      "savesSavesUp to 16 per playerAsk the player32 MiB, last 5 versionscloudSaves",
      "progressUp to 10,000 per playerKeep the highest on level32 MiB, last 5 versionsNone",
    ]);
    expect(screen.getByText(/audio\.vol → audio\.volume/)).toBeTruthy();
  });

  it("says that only signed-in people sync, and key-activated devices keep settings locally", async () => {
    renderPage();
    expect(await screen.findByText("Only signed-in people sync")).toBeTruthy();
    expect(
      screen.getByText(/activated with a licence key keep their settings/),
    ).toBeTruthy();
  });

  it("shows the platform limits, the quota being an entitlement", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Synced settings" });
    expect(screen.getByText("Default quota")).toBeTruthy();
    expect(screen.getByText("256 MiB")).toBeTruthy();
    expect(
      screen.getByText("Without a licence: 1 MiB, no files."),
    ).toBeTruthy();
    // The saves collection's row and the platform limit both read the one constant.
    expect(screen.getAllByText("Up to 16 per player")).toHaveLength(2);
    expect(screen.getByText(/pkey\.cloudSync\.bytes/)).toBeTruthy();
    expect(screen.getByText("People holding data")).toBeTruthy();
    expect(screen.getByText("100,000")).toBeTruthy();
  });

  it("formats limits in binary units, as they are set", () => {
    expect(formatBinaryBytes(65_536)).toBe("64 KiB");
    expect(formatBinaryBytes(268_435_456)).toBe("256 MiB");
    expect(formatBinaryBytes(1_048_576)).toBe("1 MiB");
    expect(formatBinaryBytes(53_687_091_200)).toBe("50 GiB");
    expect(formatBinaryBytes(512)).toBe("512 bytes");
  });

  it("before the first catalog publish, declares nothing rather than failing", async () => {
    schema.mockRejectedValue(new ApiError(404));
    renderPage();
    expect(await screen.findByText("No catalog key syncs.")).toBeTruthy();
    expect(screen.getByText("No collections are declared.")).toBeTruthy();
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

describe("the catalog editor's Synced setting fields", () => {
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

  it("shows a key with no user block as syncing, and offers no device scope", () => {
    renderForm(entry({ key: "audio.volume" }));
    const syncs = screen.getByRole("checkbox", {
      name: /Syncs across devices/,
    });
    expect(syncs.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText("Per device")).toBeNull();
  });

  it("turns syncing off as sync: local, not by dropping the block", async () => {
    const user = userEvent.setup();
    const { onChange } = renderForm(entry({ key: "audio.volume" }));
    await user.click(
      screen.getByRole("checkbox", { name: /Syncs across devices/ }),
    );
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ user: { sync: "local" } }),
    );
  });

  it("turns syncing back on by removing local, dropping an empty block", async () => {
    const user = userEvent.setup();
    const { onChange } = renderForm(
      entry({ key: "audio.volume", user: { sync: "local" } }),
    );
    await user.click(
      screen.getByRole("checkbox", { name: /Syncs across devices/ }),
    );
    expect(onChange.mock.lastCall![0].user).toBeUndefined();
  });

  it("hides a key from settings panels with listed: false", async () => {
    const user = userEvent.setup();
    const { onChange } = renderForm(entry({ key: "audio.volume" }));
    await user.click(
      screen.getByRole("checkbox", { name: "Show in settings panels" }),
    );
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ user: { listed: false } }),
    );
  });

  it("offers merge for an object and only last write for a list (combine is object-only)", () => {
    const { unmount } = renderForm(
      entry({ key: "input.bindings", schema: { type: "object" } }),
    );
    expect(
      screen.getByRole("combobox", { name: "When two devices disagree" }),
    ).toBeTruthy();
    unmount();
    renderForm(
      entry({
        key: "input.recent",
        schema: { type: "array", uniqueItems: true },
      }),
    );
    // Negative control: a list gets last write only, as fixed text.
    expect(
      screen.queryByRole("combobox", { name: "When two devices disagree" }),
    ).toBeNull();
    expect(screen.getByText("Last write wins")).toBeTruthy();
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

  it("says a locked key never syncs, and a block on it is a note, not an alert", () => {
    renderForm(
      entry({
        key: "ops.mode",
        managementDefault: "hidden",
        user: { sync: "user" },
      }),
    );
    expect(screen.getByText(/Locked keys never sync/)).toBeTruthy();
    expect(screen.getByText(/user has no effect on a key/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers no Synced setting section on a secret or a flag", () => {
    renderForm(entry({ key: "api.token", kind: "secret" }));
    expect(screen.queryByText("Synced setting")).toBeNull();
  });
});

describe("catalogIssues: user blocks (Cloud Sync rules 1–5)", () => {
  const issues = (e: ConfigEntry) =>
    catalogIssues({ schemaVersion: 1, entries: [e] }).map((i) => [
      i.field,
      i.message,
    ]);

  it("accepts a valid synced setting, and an empty block", () => {
    expect(
      issues(entry({ key: "a", user: { sync: "platform", conflict: "min" } })),
    ).toEqual([]);
    expect(issues(entry({ key: "a", user: {} }))).toEqual([]);
  });

  it("refuses the retired device scope, pointing to local", () => {
    const found = issues(
      entry({ key: "a", user: { sync: "device" as never } }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]![1]).toMatch(/Use local/);
  });

  it("refuses one on a flag, or with union", () => {
    expect(
      issues(entry({ key: "a", kind: "flag", user: { sync: "user" } })),
    ).toEqual([["user", "user is only valid on config entries."]]);
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

  it("does not block a block on a locked key: it is a note", () => {
    const doc = {
      schemaVersion: 1,
      entries: [
        entry({
          key: "a",
          managementDefault: "hidden",
          user: { sync: "user" },
        }),
      ],
    };
    expect(catalogIssues(doc)).toEqual([]);
    expect(catalogNotes(doc).map((n) => [n.index, n.field])).toEqual([
      [0, "user"],
    ]);
    const marks = catalogDiagnostics(JSON.stringify(doc, null, 2));
    expect(marks.map((m) => m.severity)).toEqual(["warning"]);
    // Negative control: without the lock there is nothing to note.
    expect(
      catalogNotes({
        schemaVersion: 1,
        entries: [entry({ key: "a", user: { sync: "user" } })],
      }),
    ).toEqual([]);
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
