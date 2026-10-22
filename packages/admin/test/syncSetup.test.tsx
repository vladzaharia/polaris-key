/**
 * Cloud Sync → Setup (config.cloud-sync, -paused, -product-role, pause-writes, storage-default):
 * the platform default storage and the writes-paused switch, over the platform settings list.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import type {
  PlatformIntegerSetting,
  PlatformSettingsView,
  PlatformSwitchSetting,
  ProductDetail,
  ProductSetting,
  SyncUsageResponse,
} from "../src/api.js";
import { ApiError } from "../src/api.js";
import { KitProviders } from "../src/kit/KitProviders.js";

const gate = vi.hoisted(() => ({
  value: {
    allowed: true,
    canView: true,
    disabledReason: undefined as string | undefined,
  },
}));
vi.mock("../src/console/access/useCan.js", () => ({
  useWriteGate: () => gate.value,
  useCan: () => gate.value.allowed,
}));

const product = vi.fn();
const products = vi.fn();
const platformSettings = vi.fn<() => Promise<PlatformSettingsView>>();
const reach = vi.fn();
const stepUpRedirect = vi.fn();
const patch = vi.fn();
const me = vi.fn();
const schema = vi.fn();
const usage = vi.fn();
const productSettings = vi.fn();
const updateSetting = vi.fn();

vi.mock("../src/api.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
  return {
    ...actual,
    api: {
      product: (s: string) => product(s),
      products: () => products(),
      me: () => me(),
      schema: (s: string) => schema(s),
      syncUsage: (s: string) => usage(s),
      productSettings: (s: string, a?: string) => productSettings(s, a),
      updateProductSetting: (s: string, k: string, b: unknown) =>
        updateSetting(s, k, b),
      platformSettings: () => platformSettings(),
      platformSettingReach: (k: string, v?: number) => reach(k, v),
      patchPlatformSetting: (k: string, b: unknown) => patch(k, b),
    },
  };
});

import { setStepUpRedirectForTests } from "../src/lib/stepUp.js";

const { CloudSyncSetupPage } =
  await import("../src/console/sections/sync/CloudSyncSetup.js");
const api = await import("../src/api.js");

const axe = configureAxe({
  rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
});

const base = {
  area: "cloudSync",
  description: "",
  scripts: ["main"],
  precedence: "runtime" as const,
  deployValue: null,
  source: "default" as const,
  forcedOff: false,
  stored: null,
  version: 4,
};
const PAUSED = (on: boolean): PlatformSwitchSetting => ({
  ...base,
  key: "cloudSync.writesPaused",
  label: "Pause Cloud Sync writes",
  kind: "switch",
  default: "off",
  value: on ? "on" : "off",
  confirm: { on: "L2", off: "L1" },
  stored: on
    ? { value: "on", valid: true, updatedAt: 1_790_000_000, updatedBy: "ana" }
    : null,
});
const QUOTA: PlatformIntegerSetting = {
  ...base,
  key: "cloudSync.quota.defaultBytes",
  label: "Default Cloud Sync quota",
  kind: "integer",
  unit: "bytes",
  min: 1_048_576,
  max: 1_073_741_824,
  default: 268_435_456,
  value: 268_435_456,
  confirm: { raise: "L2", lower: "L2" },
  link: "default",
};
const view = (s: (PlatformSwitchSetting | PlatformIntegerSetting)[]) =>
  ({
    settings: s,
    storeAvailable: true,
    propagationSeconds: 30,
    deployTime: [],
    secrets: [],
  }) as unknown as PlatformSettingsView;

const GiB = 1024 ** 3;
const CEILING = (value = 50 * GiB, source = "default"): ProductSetting =>
  ({
    key: "cloudSync.ceiling.bytes",
    area: "cloudSync.limits",
    service: "sync",
    label: "Product storage ceiling",
    description: "",
    docs: "",
    spec: { kind: "integer", unit: "bytes", min: 0, max: 1024 ** 5 },
    confirm: { up: "L2", down: "L1" },
    critical: true,
    manifestPath: null,
    visibleWhen: null,
    serviceEnabled: true,
    value,
    source,
    defaultValue: 50 * GiB,
    version: 3,
    updatedAt: null,
    updatedBy: null,
    reason: null,
  }) as unknown as ProductSetting;
const USAGE = (
  over: { free?: number; standard?: number } = { free: 41, standard: 3 },
): SyncUsageResponse => ({
  enabled: true,
  usage: {
    bytes: Math.round(18.4 * GiB),
    people: 4812,
    settingsBytes: 0,
    recordBytes: 0,
    fileBytes: 0,
    revisionBytes: 0,
    computedAt: 1_790_000_000,
    breakdown: {
      byTier: [
        {
          tierId: "free",
          people: 3120,
          bytes: 0,
          medianBytes: 0,
          over80: over.free ?? 0,
        },
        {
          tierId: "standard",
          people: 1402,
          bytes: 0,
          medianBytes: 0,
          over80: over.standard ?? 0,
        },
        { tierId: "deluxe", people: 290, bytes: 0, medianBytes: 0, over80: 0 },
      ],
      byKind: { settings: 0, records: 0, files: 0, revisions: 0 },
      byPlatform: [],
    },
  },
  today: { day: "2026-10-22", syncs: 0, conflicts: 0 },
  tiers: [
    { id: "free", label: "Free", bytes: 64 * 1024 * 1024 },
    { id: "standard", label: "Standard", bytes: null },
    { id: "deluxe", label: "Deluxe", bytes: GiB },
  ],
  defaultBytes: 256 * 1024 * 1024,
});

const detail = (slug: string, name: string): ProductDetail =>
  ({ slug, name, services: { sync: { enabled: true } } }) as ProductDetail;

function renderPage() {
  return render(
    <KitProviders>
      <div data-service="sync">
        <CloudSyncSetupPage slug="diceroll" />
      </div>
    </KitProviders>,
  );
}

beforeEach(() => {
  stepUpRedirect.mockReset();
  setStepUpRedirectForTests(() => stepUpRedirect());
  sessionStorage.clear();
  gate.value = { allowed: true, canView: true, disabledReason: undefined };
  for (const m of [
    product,
    products,
    platformSettings,
    reach,
    patch,
    me,
    schema,
    usage,
    productSettings,
    updateSetting,
  ])
    m.mockReset();
  usage.mockResolvedValue(USAGE());
  productSettings.mockResolvedValue({ settings: [CEILING()] });
  updateSetting.mockResolvedValue({
    ok: true,
    claimed: false,
    setting: CEILING(),
  });
  product.mockResolvedValue({ product: detail("diceroll", "Diceroll") });
  products.mockResolvedValue({
    products: [detail("djdl", "DJDL"), detail("diceroll", "Diceroll")],
  });
  schema.mockResolvedValue({
    schemaVersion: 6,
    entries: [
      {
        kind: "config",
        key: "audio.music",
        category: "Audio",
        label: "Music",
        description: "",
        schema: { type: "number" },
      },
      {
        kind: "config",
        key: "graphics.quality",
        category: "Graphics",
        label: "Quality",
        description: "",
        schema: { type: "string" },
        user: { sync: "local" },
      },
    ],
  });
  me.mockResolvedValue({ sub: "a", csrf: "x", authAt: 1_790_000_000 });
  platformSettings.mockResolvedValue(view([PAUSED(false), QUOTA]));
  reach.mockResolvedValue({
    kind: "default",
    direction: "raise",
    total: 2,
    reaches: 2,
    from: 268_435_456,
    to: 536_870_912,
    products: [
      {
        product: "djdl",
        name: "DJDL",
        from: 268435456,
        to: 536870912,
        inherited: true,
      },
      {
        product: "diceroll",
        name: "Diceroll",
        from: 268435456,
        to: 536870912,
        inherited: true,
      },
    ],
  });
  patch.mockResolvedValue(PAUSED(true));
});
afterEach(cleanup);

describe("Cloud Sync → Setup", () => {
  it("shows the default storage and the pause switch, with Setup and Data tabs", async () => {
    const { container } = renderPage();
    expect((await screen.findAllByText("256 MiB")).length).toBeGreaterThan(0);
    const tabs = screen.getByRole("navigation", { name: "Cloud Sync" });
    expect(
      within(tabs)
        .getByRole("link", { name: "Setup" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      within(tabs).getByRole("link", { name: "Data" }).getAttribute("href"),
    ).toContain("sync/data");
    expect(screen.getByRole("button", { name: "Pause writes…" })).toBeTruthy();
    expect(screen.queryByText(/paused for every product/)).toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });

  it("reads what syncs from the catalog: the keys, and the ones that stay on the device", async () => {
    renderPage();
    expect(await screen.findByText("Settings: 1 sync")).toBeTruthy();
    expect(screen.getByText("audio.music")).toBeTruthy();
    expect(screen.getByText("graphics.quality")).toBeTruthy();
    expect(screen.getByText(/1 stay on each device/)).toBeTruthy();
    expect(screen.getByText("Up to 256")).toBeTruthy();
  });

  it("draws nothing for a setting the platform list does not serve", async () => {
    platformSettings.mockResolvedValue(view([]));
    renderPage();
    await screen.findByRole("heading", { name: "Cloud Sync" });
    await vi.waitFor(() => expect(platformSettings).toHaveBeenCalled());
    expect(screen.queryByText("Pause all writes")).toBeNull();
    expect(screen.queryByText("Default")).toBeNull();
  });

  it("pauses: names who it reaches, needs a reason, sends the passkey confirm", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: "Pause writes…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("DJDL")).toBeTruthy();
    expect(within(dialog).getByText("Diceroll")).toBeTruthy();
    const confirm = within(dialog).getByRole("button", {
      name: "Pause writes for 2 products",
    });
    expect(
      confirm.getAttribute("aria-disabled") ?? confirm.hasAttribute("disabled"),
    ).toBeTruthy();
    await user.type(
      within(dialog).getByLabelText(/Reason/),
      "Storage errors in eu-west",
    );
    await user.click(confirm);
    expect(patch).toHaveBeenCalledWith("cloudSync.writesPaused", {
      value: "on",
      expectedVersion: 4,
      reason: "Storage errors in eu-west",
      confirm: "cloudSync.writesPaused",
    });
  });

  it("answers a stale sign-in with the step-up state, consequences kept", async () => {
    const user = userEvent.setup();
    patch.mockRejectedValue(new ApiError(403, undefined, "step_up_required"));
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: "Pause writes…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByLabelText(/Reason/), "Outage");
    await user.click(
      within(dialog).getByRole("button", { name: /Pause writes for/ }),
    );
    expect(
      await within(dialog).findByText("Sign in again to confirm it's you"),
    ).toBeTruthy();
    expect(within(dialog).getByText("Nothing is deleted.")).toBeTruthy();
    await user.click(
      within(dialog).getByRole("button", { name: "Sign in again" }),
    );
    expect(stepUpRedirect).toHaveBeenCalled();

    // The page comes back from the sign-in: the dialog opens again with the reason.
    cleanup();
    patch.mockReset();
    renderPage();
    const again = await screen.findByRole("alertdialog");
    expect(
      (within(again).getByLabelText(/Reason/) as HTMLTextAreaElement).value,
    ).toBe("Outage");
    await user.click(
      within(again).getByRole("button", { name: /Pause writes for/ }),
    );
    expect(patch).toHaveBeenCalledWith(
      "cloudSync.writesPaused",
      expect.objectContaining({ value: "on", reason: "Outage" }),
    );
  });

  it("says who paused writes, and shows an error with Try again when the settings read fails", async () => {
    const user = userEvent.setup();
    platformSettings.mockResolvedValue(view([PAUSED(true), QUOTA]));
    renderPage();
    expect(await screen.findByText(/Paused .* by ana\./)).toBeTruthy();
    cleanup();
    platformSettings.mockReset();
    platformSettings.mockRejectedValueOnce(new ApiError(500));
    platformSettings.mockResolvedValue(view([PAUSED(false), QUOTA]));
    renderPage();
    await user.click(await screen.findByRole("button", { name: /Try again/ }));
    expect(
      await screen.findByRole("button", { name: "Pause writes…" }),
    ).toBeTruthy();
  });

  it("shows the paused banner and resumes", async () => {
    const user = userEvent.setup();
    platformSettings.mockResolvedValue(view([PAUSED(true), QUOTA]));
    renderPage();
    expect(
      await screen.findByText("Cloud Sync writes are paused for every product"),
    ).toBeTruthy();
    await user.click(
      screen.getAllByRole("button", { name: "Resume writes" })[0]!,
    );
    const dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByLabelText(/Reason/), "Provider fixed");
    await user.click(
      within(dialog).getByRole("button", { name: "Resume writes" }),
    );
    expect(patch).toHaveBeenCalledWith("cloudSync.writesPaused", {
      value: "off",
      expectedVersion: 4,
      reason: "Provider fixed",
    });
  });

  it("changes the default: leads with who it reaches and holds Confirm until counted", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(
      (await screen.findAllByRole("button", { name: "Change…" }))[0]!,
    );
    const dialog = await screen.findByRole("alertdialog");
    const field = within(dialog).getByLabelText(/Default storage per person/);
    await user.clear(field);
    await user.type(field, "512");
    expect(
      await within(dialog).findByText(/Raises all 2 products/),
    ).toBeTruthy();
    await user.click(
      within(dialog).getByRole("button", { name: /Raise all 2 products/ }),
    );
    expect(patch).toHaveBeenCalledWith(
      "cloudSync.quota.defaultBytes",
      expect.objectContaining({
        value: 536_870_912,
        expectedVersion: 4,
        confirm: "cloudSync.quota.defaultBytes",
      }),
    );
  });

  it("shows the product ceiling as a meter, X of Y, with Change… for a member who can edit", async () => {
    renderPage();
    const meter = await screen.findByRole("meter");
    expect(meter.getAttribute("aria-valuetext")).toBe("18.4 GiB of 50 GiB");
    expect(screen.getByText("Platform default")).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "Change…" }).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("lists the tiers read-only: null is 'Uses the default', over 80% only where N > 0", async () => {
    renderPage();
    expect(await screen.findByText("Standard")).toBeTruthy();
    expect(screen.getByText("Free")).toBeTruthy();
    expect(screen.getByText("Deluxe")).toBeTruthy();
    expect(screen.getAllByText("Uses the default")).toHaveLength(1);
    expect(screen.getByText("41 people over 80%")).toBeTruthy();
    expect(screen.getByText("3 people over 80%")).toBeTruthy();
    expect(screen.getByText("64 MiB")).toBeTruthy();
    expect(screen.getByText("1 GiB")).toBeTruthy();
    // Standard shows the platform default beside its note (the Default row shows it too).
    expect(screen.getAllByText("256 MiB").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/over 80%/)).toHaveLength(2);
  });

  it("says nothing about 80% when nobody is near a limit, and says it for one person", async () => {
    usage.mockResolvedValue(USAGE({ free: 0, standard: 0 }));
    renderPage();
    await screen.findByText("Standard");
    expect(screen.queryByText(/over 80%/)).toBeNull();
    cleanup();
    usage.mockResolvedValue(USAGE({ free: 1, standard: 0 }));
    renderPage();
    expect(await screen.findByText("1 person over 80%")).toBeTruthy();
  });

  it("states what a device without a license gets, and links to Usage", async () => {
    renderPage();
    expect(
      await screen.findByText("Without a license: 1 MiB, no files"),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /See Usage/ }).getAttribute("href"),
    ).toBe("#/p/diceroll/sync/usage");
  });

  it("draws no tier rows or meter while the usage read is off for the product", async () => {
    usage.mockResolvedValue({ enabled: false });
    renderPage();
    await screen.findAllByText("256 MiB");
    expect(screen.queryByText("Standard")).toBeNull();
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("raises the ceiling at L2: a danger confirm that writes with the typed key", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("meter");
    const change = screen.getAllByRole("button", { name: "Change…" });
    await user.click(change[change.length - 1]!);
    const dialog = await screen.findByRole("alertdialog");
    const field = within(dialog).getByLabelText(
      /Total storage for this product/,
    );
    await user.clear(field);
    await user.type(field, "100");
    await user.click(
      within(dialog).getByRole("button", { name: "Raise the ceiling" }),
    );
    expect(updateSetting).toHaveBeenCalledWith(
      "diceroll",
      "cloudSync.ceiling.bytes",
      {
        value: 100 * GiB,
        expectedVersion: 3,
        reason: "Ceiling set to 100 GiB",
        confirm: "cloudSync.ceiling.bytes",
      },
    );
  });

  it("lowers the ceiling at L1: a caution confirm, nothing deleted, no typed key", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("meter");
    const change = screen.getAllByRole("button", { name: "Change…" });
    await user.click(change[change.length - 1]!);
    const dialog = await screen.findByRole("alertdialog");
    const field = within(dialog).getByLabelText(
      /Total storage for this product/,
    );
    await user.clear(field);
    await user.type(field, "10");
    expect(within(dialog).getByText("Nothing is deleted.")).toBeTruthy();
    expect(within(dialog).getByText(/holds 18\.4 GiB/)).toBeTruthy();
    await user.click(
      within(dialog).getByRole("button", { name: "Lower the ceiling" }),
    );
    expect(updateSetting).toHaveBeenCalledWith(
      "diceroll",
      "cloudSync.ceiling.bytes",
      {
        value: 10 * GiB,
        expectedVersion: 3,
        reason: "Ceiling set to 10 GiB",
      },
    );
  });

  it("keeps the typed number when the save fails, and on a version conflict reloads the setting", async () => {
    const user = userEvent.setup();
    updateSetting.mockRejectedValueOnce(new ApiError(500));
    renderPage();
    await screen.findByRole("meter");
    const change = screen.getAllByRole("button", { name: "Change…" });
    await user.click(change[change.length - 1]!);
    const dialog = await screen.findByRole("alertdialog");
    const field = within(dialog).getByLabelText(
      /Total storage for this product/,
    ) as HTMLInputElement;
    await user.clear(field);
    await user.type(field, "20");
    await user.click(
      within(dialog).getByRole("button", { name: "Lower the ceiling" }),
    );
    await vi.waitFor(() => expect(updateSetting).toHaveBeenCalledTimes(1));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(field.value).toBe("20");

    // A conflict: the setting is read again and the next confirm names the version in force.
    updateSetting.mockRejectedValueOnce(new ApiError(409));
    productSettings.mockClear();
    productSettings.mockResolvedValue({
      settings: [CEILING(40 * GiB, "console")],
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Lower the ceiling" }),
    );
    expect(
      await within(dialog).findByText(
        "The ceiling changed since you opened this",
      ),
    ).toBeTruthy();
    expect(field.value).toBe("20");
    await vi.waitFor(() => expect(productSettings).toHaveBeenCalled());
  });

  it("opens the resume dialog from Home's attention link and resumes through the pause write", async () => {
    window.location.hash = "#/p/diceroll/sync/setup?resume=1";
    platformSettings.mockResolvedValue(view([PAUSED(true), QUOTA]));
    const user = userEvent.setup();
    renderPage();
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByRole("heading", {
        name: "Resume Cloud Sync writes?",
      }),
    ).toBeTruthy();
    await user.type(within(dialog).getByLabelText(/Reason/), "Provider fixed");
    await user.click(
      within(dialog).getByRole("button", { name: "Resume writes" }),
    );
    expect(patch).toHaveBeenCalledWith("cloudSync.writesPaused", {
      value: "off",
      expectedVersion: 4,
      reason: "Provider fixed",
    });
    window.location.hash = "";
  });

  it("does not open the resume dialog when writes are not paused", async () => {
    window.location.hash = "#/p/diceroll/sync/setup?resume=1";
    renderPage();
    await screen.findByRole("button", { name: "Pause writes…" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    window.location.hash = "";
  });

  it("draws the platform controls disabled for a product role, with who can change them", async () => {
    gate.value = {
      allowed: false,
      canView: true,
      disabledReason:
        "Ask Ana Lima (ana@example.com) for Platform edit access.",
    };
    renderPage();
    // Who can change them is said once, and no control implies a state the member cannot read.
    expect(
      await screen.findAllByText(/Platform admins only\. Ask Ana Lima/),
    ).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Change…" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Pause writes/ })).toBeNull();
    // The usage read still draws the default and the tiers, read-only.
    expect(await screen.findByText("Standard")).toBeTruthy();
    expect(platformSettings).not.toHaveBeenCalled();
  });
});
