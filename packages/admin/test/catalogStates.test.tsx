import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import type { ConfigEntry, ProductCatalog } from "../src/api.js";
import { resetConsole } from "./consoleHarness.js";
import { apiError, bootConfig } from "./configHarness.js";
import {
  mergeDraft,
  settle,
} from "../src/console/sections/config/model/mergeDraft.js";
import { invalidResync } from "../src/console/sections/config/model/syncProblems.js";
import { removedValues } from "../src/console/sections/config/model/valueUse.js";

/**
 * The catalog's less happy states (docs/design/mockups config.entry-draft-stale,
 * config.entry-setting-remove-value, config.catalog-invalid, config.catalog-review-states,
 * config.entry-minted-token-no-key; admin-2-16, -19, -20, -21).
 */

const axe = configureAxe({
  rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
});
async function axeClean(): Promise<void> {
  const results = await axe(document.querySelector("main")!);
  expect(results.violations.map((v) => v.id)).toEqual([]);
}

const P = "/manage/api/products/djdl";

const E = (key: string, extra: Partial<ConfigEntry> = {}): ConfigEntry => ({
  key,
  kind: "config",
  category: "Quality",
  label: key.split(".").pop()!,
  description: "",
  schema: { type: "string" },
  ...extra,
});

const FLOOR = E("quality.floor", {
  label: "Floor",
  schema: { type: "string", enum: ["flac", "mp3-320", "any"] },
  default: "any",
});
const RUN = E("run.count", { label: "Count", category: "Run" });
const V9: ProductCatalog = { schemaVersion: 9, entries: [FLOOR, RUN] };

beforeEach(() => {
  resetConsole();
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("mergeDraft", () => {
  const base = [FLOOR, RUN];
  const draft = (entries: ConfigEntry[]) => ({
    baseVersion: 9,
    baseEntries: base,
    entries,
  });

  it("takes a field only the repository changed and keeps one only the person changed", () => {
    const server = {
      schemaVersion: 10,
      entries: [{ ...FLOOR, description: "Theirs" }, RUN],
    };
    const merged = mergeDraft(
      draft([FLOOR, { ...RUN, label: "Mine" }]),
      server,
    );
    expect(merged.conflicts).toEqual([]);
    expect(merged.baseVersion).toBe(10);
    expect(
      merged.entries.find((e) => e.key === "quality.floor")!.description,
    ).toBe("Theirs");
    expect(merged.entries.find((e) => e.key === "run.count")!.label).toBe(
      "Mine",
    );
  });

  it("keeps a repository-added entry and the person's added one", () => {
    const server = {
      schemaVersion: 10,
      entries: [FLOOR, RUN, E("theirs.new")],
    };
    const merged = mergeDraft(draft([FLOOR, RUN, E("mine.new")]), server);
    expect(merged.entries.map((e) => e.key).sort()).toEqual([
      "mine.new",
      "quality.floor",
      "run.count",
      "theirs.new",
    ]);
  });

  it("holds a field both changed, and settles it either way", () => {
    const server = {
      schemaVersion: 10,
      entries: [{ ...FLOOR, label: "Theirs" }, RUN],
    };
    const merged = mergeDraft(
      draft([{ ...FLOOR, label: "Mine" }, RUN]),
      server,
    );
    expect(merged.conflicts).toEqual([
      {
        key: "quality.floor",
        fields: [{ field: "label", mine: "Mine", theirs: "Theirs" }],
      },
    ]);
    const keep = settle(merged, "quality.floor", "label", false);
    expect(keep.conflicts).toBeUndefined();
    expect(keep.entries[0]!.label).toBe("Mine");
    const take = settle(merged, "quality.floor", "label", true);
    expect(take.conflicts).toBeUndefined();
    expect(take.entries[0]!.label).toBe("Theirs");
  });

  it("flags an entry the repository removed while the person edited it", () => {
    const server = { schemaVersion: 10, entries: [RUN] };
    const merged = mergeDraft(
      draft([{ ...FLOOR, label: "Mine" }, RUN]),
      server,
    );
    expect(merged.conflicts[0]!.key).toBe("quality.floor");
    expect(merged.entries.map((e) => e.key)).toContain("quality.floor");
    const take = settle(merged, "quality.floor", "*", true);
    expect(take.entries.map((e) => e.key)).toEqual(["run.count"]);
  });
});

describe("removedValues", () => {
  it("lists allowed values the draft dropped, and none when the list is gone", () => {
    const next = E("quality.floor", {
      schema: { type: "string", enum: ["flac", "any"] },
    });
    expect(removedValues(FLOOR, next)).toEqual(["mp3-320"]);
    expect(removedValues(FLOOR, E("quality.floor"))).toEqual([]);
    expect(removedValues(undefined, next)).toEqual([]);
  });
});

describe("invalidResync", () => {
  it("reads the schema errors of a failed resync, and nothing from a good one", () => {
    const sync = {
      status: "error",
      commitSha: "7c41d0e9",
      errors: [
        'schema/entries/0/default: the default "lossless" is not one of its allowed values',
        "product/name: too short",
      ],
    };
    const out = invalidResync(sync, V9.entries)!;
    expect(out.commit).toBe("7c41d0e9");
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0]).toMatchObject({ index: 0, key: "quality.floor" });
    expect(invalidResync({ status: "ok" }, V9.entries)).toBeNull();
  });
});

async function openEditor(
  routes: Record<string, unknown> = {},
  product?: Record<string, unknown>,
  hash = "#/p/djdl/config/catalog/edit?entry=quality.floor",
) {
  const backend = bootConfig(
    hash,
    {
      [`${P}/config/catalog`]: V9,
      [`${P}/config/catalog/usage`]: { keys: {} },
      ...routes,
    },
    { product },
  );
  await screen.findByRole("heading", { level: 1, name: "Edit catalog" });
  return backend;
}

describe("Catalog editor: the repository moved under a draft", () => {
  const seed = (): void => {
    // A draft started from v8, where the person renamed two entries.
    const v8 = [E("quality.floor", { label: "Old" }), RUN];
    window.sessionStorage.setItem(
      "pk-catalog-draft:djdl",
      JSON.stringify({
        baseVersion: 8,
        baseEntries: v8,
        entries: [
          { ...v8[0]!, label: "Mine" },
          { ...RUN, label: "Mine run" },
        ],
      }),
    );
  };

  it("names the commit and the conflict, keeps the notice up, and Review waits (admin-2-16, -21)", async () => {
    seed();
    await openEditor(
      {
        [`${P}/config/catalog`]: {
          schemaVersion: 9,
          entries: [{ ...FLOOR, label: "Theirs" }, RUN],
        },
      },
      { sync: { status: "ok", commitSha: "7c41d0e1f2" } },
    );
    const notice = await screen
      .findByRole("status", {
        name: "",
      })
      .catch(() => null);
    void notice;
    const note = await screen.findByText(/1 of your edits conflicts/);
    expect(note.textContent).toContain("7c41d0e");
    const callout = note.closest("[data-tone]") as HTMLElement;
    expect(callout.getAttribute("role")).toBe("status");
    expect(callout.getAttribute("data-tone")).toBe("warning");
    // The non-conflicting edit merged in; the conflicting entry shows both sides.
    const panel = screen.getByRole("region", {
      name: "Conflicts on quality.floor",
    });
    expect(within(panel).getByText("Mine")).toBeTruthy();
    expect(within(panel).getByText("Theirs")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Review changes" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(screen.getByText("(conflicts with the repository)")).toBeTruthy();
    await axeClean();

    await userEvent.click(
      within(panel).getByRole("button", { name: /Keep mine/ }),
    );
    await waitFor(() =>
      expect(screen.queryByText(/of your edits conflict/)).toBeNull(),
    );
    expect(
      screen
        .getByRole("button", { name: "Review changes" })
        .getAttribute("aria-disabled"),
    ).toBeNull();
  });

  it("takes the repository's side when asked", async () => {
    seed();
    await openEditor({
      [`${P}/config/catalog`]: {
        schemaVersion: 9,
        entries: [{ ...FLOOR, label: "Theirs" }, RUN],
      },
    });
    const panel = await screen.findByRole("region", {
      name: "Conflicts on quality.floor",
    });
    await userEvent.click(
      within(panel).getByRole("button", { name: /Take the repo/ }),
    );
    await waitFor(() =>
      expect(
        (screen.getByRole("textbox", { name: /^Label/ }) as HTMLInputElement)
          .value,
      ).toBe("Theirs"),
    );
  });
});

describe("Catalog editor: removing a value that is still in use", () => {
  it("warns under the chips, names who holds it, and keeps Review off until they move", async () => {
    let held = "mp3-320";
    await openEditor({
      [`${P}/config/catalog/usage`]: {
        keys: {
          "quality.floor": {
            profiles: [{ id: "studio", name: "Studio" }],
            tiers: [],
            licenses: [],
          },
        },
      },
      [`${P}/config/profiles/studio`]: () => ({
        id: "studio",
        name: "Studio",
        payload: {
          config: {
            "quality.floor": { state: "default", value: held, updatedAt: 1 },
          },
          secrets: {},
          entitlements: {},
        },
      }),
    });
    const chips = await screen.findByRole("list", { name: "Allowed values" });
    // Each chip says who uses it: the profile that sets mp3-320 is named on it.
    await waitFor(() => expect(within(chips).getByText("Studio")).toBeTruthy());
    await userEvent.click(
      within(chips).getByRole("button", { name: "Remove mp3-320" }),
    );
    const warning = await screen.findByText(/is still in use/);
    expect(warning.closest("[data-tone]")!.textContent).toContain("Studio");
    expect(warning.closest("[data-tone]")!.textContent).toContain("mp3-320");
    expect(
      screen
        .getByRole("button", { name: "Review changes" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    // The removed chip stays, struck, with Undo.
    expect(within(chips).getByText("(removed)")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Undo/ }));
    await waitFor(() =>
      expect(screen.queryByText(/is still in use/)).toBeNull(),
    );
    expect(
      within(screen.getByRole("list", { name: "Allowed values" })).getByText(
        "mp3-320",
      ),
    ).toBeTruthy();
    held = "flac";
  });
});

describe("Catalog: a resync that failed validation", () => {
  it("names the commit and each error, says what still serves, and marks the entry", async () => {
    bootConfig(
      "#/p/djdl/config/catalog",
      { [`${P}/config/catalog`]: V9 },
      {
        product: {
          sync: {
            status: "error",
            commitSha: "7c41d0e1f2",
            errors: [
              "schema/entries/0/default: the default lossless isn't one of its allowed values",
            ],
          },
        },
      },
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Resync from 7c41d0e failed: 1 error");
    expect(alert.textContent).toContain("Devices still get v9");
    expect(alert.textContent).toContain("quality.floor");
    expect(within(alert).getByRole("button", { name: "Resync" })).toBeTruthy();
    expect(
      screen.getByText("The last resync reported an error here"),
    ).toBeTruthy();
  });

  it("draws nothing when the last resync was fine", async () => {
    bootConfig("#/p/djdl/config/catalog", { [`${P}/config/catalog`]: V9 });
    await screen.findByText("quality.floor");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Catalog review: a failed publish", () => {
  it("says nothing changed, keeps the draft, and offers Publish again", async () => {
    await openEditor({
      [`PUT ${P}/config/catalog`]: apiError(504, {}),
    });
    const label = await screen.findByRole("textbox", { name: /^Label/ });
    await userEvent.type(label, "!");
    await userEvent.click(
      screen.getByRole("button", { name: "Review changes" }),
    );
    const drawer = await screen.findByRole("dialog");
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Publish version 10" }),
    );
    const alert = await within(drawer).findByRole("alert");
    expect(alert.textContent).toContain("Publish didn’t finish");
    expect(alert.textContent).toContain(
      "Devices still get v9. Your draft is kept.",
    );
    expect(
      within(drawer).getByRole("button", { name: "Publish version 10 again" }),
    ).toBeTruthy();
    expect(
      window.sessionStorage.getItem("pk-catalog-draft:djdl"),
    ).not.toBeNull();
  });
});

describe("Minted token with no signing key", () => {
  it("shows the empty Signing key state and adds the key as an edge-mint secret", async () => {
    const TOKEN = E("applemusic.token", {
      kind: "secret",
      delivery: "edgeMint",
      label: "Apple Music token",
      category: "Integrations",
    });
    const recipe = {
      id: "applemusic.token",
      alg: "ES256",
      signingKeySecret: "APPLE_MUSIC_KEY",
      kid: "3HWR8C2N6T",
      claimsTemplateJson: null,
      claimsTemplate: null,
      ttlSeconds: 3600,
      audience: null,
      requires: "licensed",
      requiredEntitlement: null,
      status: "approved",
      secretUsage: "missing",
      changedFields: [],
      approval: null,
    };
    const backend = bootConfig(
      "#/p/djdl/config/catalog/edit?entry=applemusic.token",
      {
        [`${P}/config/catalog`]: { schemaVersion: 9, entries: [TOKEN] },
        [`${P}/config/catalog/usage`]: { keys: {} },
        [`${P}/config/mint`]: {
          registration: "requires-license",
          anonymousEnroll: false,
          oidcDefault: false,
          publicMint: false,
          licenseEnabled: true,
          identity: null,
          recipes: [recipe],
        },
        [`PUT ${P}/secrets/APPLE_MUSIC_KEY`]: {
          ok: true,
          name: "APPLE_MUSIC_KEY",
        },
      },
    );
    await screen.findByRole("heading", { level: 1, name: "Edit catalog" });
    expect(await screen.findByText("Needs a signing key")).toBeTruthy();
    const key = screen.getByRole("region", { name: "Signing key" });
    expect(key.textContent).toContain("No key yet");
    expect(key.textContent).toContain("3HWR8C2N6T");
    expect(key.textContent).toContain("can’t be read back");
    await userEvent.click(screen.getByRole("button", { name: "Add the key…" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Add the signing key",
    });
    await userEvent.type(
      within(dialog).getByRole("textbox"),
      "-----BEGIN PRIVATE KEY-----",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Add key" }),
    );
    await waitFor(() => expect(backend.writes()).toHaveLength(1));
    expect(backend.writes()[0]).toMatchObject({
      method: "PUT",
      body: { value: "-----BEGIN PRIVATE KEY-----", usage: "edge-mint" },
    });
  });
});

describe("Catalog review: who it reaches", () => {
  it("counts who sets a changed key and says when devices get it", async () => {
    await openEditor({
      [`${P}/config/catalog/usage`]: {
        keys: {
          "quality.floor": {
            profiles: [{ id: "studio", name: "Studio" }],
            tiers: [],
            licenses: [{ id: "L1", name: "Ana", email: null }],
            accounts: [{ subject: "s1" }, { subject: "s2" }],
          },
        },
      },
      [`${P}/config/profiles/studio`]: {
        id: "studio",
        name: "Studio",
        payload: { config: {}, secrets: {}, entitlements: {} },
      },
    });
    const label = await screen.findByRole("textbox", { name: /^Label/ });
    await userEvent.type(label, "!");
    await userEvent.click(
      screen.getByRole("button", { name: "Review changes" }),
    );
    const drawer = await screen.findByRole("dialog");
    const rail = await within(drawer).findByRole("heading", {
      name: "Who it reaches",
    });
    const card = rail.closest("section")!;
    await waitFor(() =>
      expect(card.textContent).toContain("1 set a changed key"),
    );
    expect(card.textContent).toContain("2 set their own");
    expect(card.textContent).toContain("Devices get v10 at their next check.");
  });
});

describe("Minted token: a lifetime changed since approval", () => {
  it("heads the entry with the pill, marks Was, offers Keep, and previews the token", async () => {
    const TOKEN = E("applemusic.token", {
      kind: "secret",
      delivery: "edgeMint",
      label: "Apple Music token",
      category: "Integrations",
    });
    const base = {
      id: "applemusic.token",
      alg: "ES256",
      signingKeySecret: "APPLE_MUSIC_KEY",
      kid: "3HWR8C2N6T",
      claimsTemplateJson: '{"iss":"K7Q2M9X4PL"}',
      claimsTemplate: { iss: "K7Q2M9X4PL" },
      audience: null,
      requires: "licensed",
      requiredEntitlement: null,
    };
    const approval = {
      ...base,
      ttlSeconds: 900,
      openRegistrationAcknowledged: false,
      licenseEnabled: true,
      identity: null,
      approvedAt: 1791000000,
      approvedBy: "Ana Lima",
    };
    bootConfig("#/p/djdl/config/catalog/edit?entry=applemusic.token", {
      [`${P}/config/catalog`]: { schemaVersion: 9, entries: [TOKEN] },
      [`${P}/config/catalog/usage`]: { keys: {} },
      [`${P}/secrets`]: {
        secrets: [
          {
            name: "APPLE_MUSIC_KEY",
            configured: true,
            usage: "edge-mint",
            createdAt: 1790000000,
            updatedAt: 1790000000,
            requiredBy: [],
          },
        ],
      },
      [`${P}/config/mint`]: {
        registration: "requires-license",
        anonymousEnroll: false,
        oidcDefault: false,
        publicMint: false,
        licenseEnabled: true,
        identity: null,
        recipes: [
          {
            ...base,
            ttlSeconds: 3600,
            status: "changed",
            secretUsage: "edge-mint",
            changedFields: ["ttlSeconds"],
            approval,
          },
        ],
      },
    });
    await screen.findByRole("heading", { level: 1, name: "Edit catalog" });
    expect(await screen.findByText("Changed since approval")).toBeTruthy();
    expect(
      await screen.findByText("Lifetime changed from 15 minutes to 1 hour"),
    ).toBeTruthy();
    expect(screen.getByText("Was 15 minutes")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Keep 15 minutes" }),
    ).toBeTruthy();
    expect(screen.getByText(/Sealed /)).toBeTruthy();
    expect(screen.getByText("Used only for this token")).toBeTruthy();
    const preview = screen.getByText(/decoded preview/);
    expect(preview.closest("[data-code-frame]")!.textContent).toContain(
      '"kid":"3HWR8C2N6T"',
    );
    expect(screen.getByText("Ana Lima approved")).toBeTruthy();
    expect(screen.getByText("Who can get one")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Keep 15 minutes" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Was 15 minutes")).toBeNull(),
    );
  });
});
