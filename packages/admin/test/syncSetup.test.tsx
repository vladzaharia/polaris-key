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
import { HttpError } from "../src/api.js";
import { invalidationFor } from "../src/console/data/mutations.js";
import { qk } from "../src/console/data/queries.js";
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
const revertSetting = vi.fn();

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
      revertProductSetting: (s: string, k: string, b: unknown) =>
        revertSetting(s, k, b),
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
  paused: {
    since: number | null;
    by: string | null;
    reason: string | null;
  } | null = null,
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
  paused,
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
    revertSetting,
  ])
    m.mockReset();
  usage.mockResolvedValue(USAGE());
  productSettings.mockResolvedValue({ settings: [CEILING()] });
  revertSetting.mockResolvedValue({
    ok: true,
    applied: true,
    setting: CEILING(),
  });
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

  it.each([
    [undefined, "End-to-end"],
    ["e2e", "End-to-end"],
    ["server", "Readable by Polaris Key"],
  ] as const)(
    "shows the catalog's encryption (%s) as '%s'",
    async (declared, label) => {
      const cat = await schema();
      schema.mockResolvedValue({
        ...cat,
        ...(declared ? { cloudSync: { encryption: declared } } : {}),
      });
      renderPage();
      const term = await screen.findByText("Encryption");
      expect(term.closest("div")?.textContent).toContain(label);
    },
  );

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
    const confirmButton = () =>
      within(dialog).getByRole("button", {
        name: "Pause writes for 2 products",
      });
    const confirm = confirmButton();
    expect(
      confirm.getAttribute("aria-disabled") ?? confirm.hasAttribute("disabled"),
    ).toBeTruthy();
    await user.type(
      within(dialog).getByLabelText(/Reason/),
      "Storage errors in eu-west",
    );
    await user.click(confirmButton());
    expect(patch).toHaveBeenCalledWith("cloudSync.writesPaused", {
      value: "on",
      expectedVersion: 4,
      reason: "Storage errors in eu-west",
      confirm: "cloudSync.writesPaused",
    });
  });

  it("answers a stale sign-in with the step-up state, consequences kept", async () => {
    const user = userEvent.setup();
    patch.mockRejectedValue(new HttpError(403, { code: "step_up_required" }));
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
    usage.mockResolvedValue(
      USAGE(undefined, {
        since: 1_790_000_000,
        by: "Ana Lima",
        reason: "Storage errors in eu-west",
      }),
    );
    renderPage();
    expect(await screen.findByText(/Paused .* by/)).toBeTruthy();
    expect(screen.getByText("Ana Lima")).toBeTruthy();
    expect(screen.getByText(/Storage errors in eu-west/)).toBeTruthy();
    cleanup();
    usage.mockResolvedValue(USAGE());
    platformSettings.mockReset();
    platformSettings.mockRejectedValueOnce(new HttpError(500));
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
      await screen.findByRole("button", { name: "Change the default storage" }),
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

  it("shows the product ceiling as a meter: the reading at body size with its share", async () => {
    renderPage();
    const meter = await screen.findByRole("meter");
    expect(meter.getAttribute("aria-valuetext")).toBe("18.4 GiB of 50 GiB");
    expect(within(meter).getByText("18.4 GiB of 50 GiB · 37%")).toBeTruthy();
    expect(screen.getByText("Platform default")).toBeTruthy();
    // Two Change… buttons, told apart by name.
    expect(
      screen.getByRole("button", { name: "Change total storage" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Change the default storage" }),
    ).toBeTruthy();
  });

  it("says the meter's status in words: near the ceiling, at it, and a ceiling of 0", async () => {
    const near = USAGE() as Extract<SyncUsageResponse, { enabled: true }>;
    near.usage.bytes = 45 * GiB;
    usage.mockResolvedValue(near);
    renderPage();
    expect(await screen.findByText("Near the ceiling")).toBeTruthy();
    cleanup();
    const full = USAGE() as Extract<SyncUsageResponse, { enabled: true }>;
    full.usage.bytes = 61 * GiB;
    usage.mockResolvedValue(full);
    renderPage();
    expect(
      await screen.findByText("At the ceiling: saves are refused"),
    ).toBeTruthy();
    cleanup();
    usage.mockResolvedValue(USAGE());
    productSettings.mockResolvedValue({ settings: [CEILING(0, "console")] });
    renderPage();
    expect(
      await screen.findByText("At the ceiling: saves are refused"),
    ).toBeTruthy();
    expect(screen.getByRole("meter").getAttribute("aria-valuetext")).toBe(
      "18.4 GiB of 0 GiB",
    );
  });

  it("lists the tiers read-only, each name a link to its tier: null is 'Uses the default', over 80% only where N > 0", async () => {
    const { container } = renderPage();
    expect(await screen.findByText("Standard")).toBeTruthy();
    expect(screen.getByText("Free")).toBeTruthy();
    expect(screen.getByText("Deluxe")).toBeTruthy();
    expect(screen.getAllByText("Uses the default")).toHaveLength(1);
    expect(screen.getByText("41 people over 80%")).toBeTruthy();
    expect(screen.getByText("3 people over 80%")).toBeTruthy();
    expect(screen.getByText("64 MiB")).toBeTruthy();
    expect(screen.getByText("1 GiB")).toBeTruthy();
    expect(screen.getAllByText("256 MiB").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/over 80%/)).toHaveLength(2);
    expect(
      screen.getByRole("link", { name: "Standard" }).getAttribute("href"),
    ).toContain("tiers/standard");
    // A tier name is isolated, so a right-to-left label cannot reorder what is around it.
    expect(
      [...container.querySelectorAll("bdi")].map((b) => b.textContent),
    ).toContain("Standard");
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

  it("draws 'Without a license' as a row, with the number from the catalog, and links to Usage and Tiers", async () => {
    renderPage();
    const row = (await screen.findByText("Without a license")).closest("li")!;
    expect(within(row).getByText(/1 MiB, no\s+files/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /See Usage/ }).getAttribute("href"),
    ).toBe("#/p/diceroll/sync/usage");
    expect(
      screen.getByRole("link", { name: /Edit on Tiers/ }).getAttribute("href"),
    ).toContain("tiers");
  });

  it("draws no tier rows or meter while the usage read is off for the product", async () => {
    usage.mockResolvedValue({ enabled: false });
    renderPage();
    await screen.findAllByText("256 MiB");
    expect(screen.queryByText("Standard")).toBeNull();
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("shows placeholders while the usage and ceiling reads load", async () => {
    usage.mockReturnValue(new Promise(() => undefined));
    productSettings.mockReturnValue(new Promise(() => undefined));
    const { container } = renderPage();
    await screen.findByText("Without a license");
    expect(container.querySelectorAll("[data-skeleton]").length).toBe(2);
  });

  it("gives each failed read its own error with Retry, and keeps the rest of the card", async () => {
    const user = userEvent.setup();
    usage.mockRejectedValueOnce(new HttpError(500));
    productSettings.mockRejectedValueOnce(new HttpError(500));
    renderPage();
    expect(await screen.findByText(/Usage didn't load/)).toBeTruthy();
    expect(screen.getByText(/The storage ceiling didn't load/)).toBeTruthy();
    // Nothing else went missing: the default, the no-license row and the pause row stay.
    expect(screen.getByText("Without a license")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Change the default storage" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause writes…" })).toBeTruthy();
    const retries = screen.getAllByRole("button", { name: /Retry/ });
    expect(retries.length).toBeGreaterThanOrEqual(2);
    for (const b of retries) await user.click(b);
    expect(await screen.findByRole("meter")).toBeTruthy();
    expect(screen.getByText("Standard")).toBeTruthy();
  });

  async function openCeiling(user: ReturnType<typeof userEvent.setup>) {
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: "Change total storage" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    const field = within(dialog).getByLabelText(
      /Total storage for this product/,
    ) as HTMLInputElement;
    return { dialog, field };
  }

  it("opens the ceiling dialog neutral, with focus in the field; the direction shows on the button only", async () => {
    const user = userEvent.setup();
    const { dialog, field } = await openCeiling(user);
    expect(document.activeElement).toBe(field);
    const title = () =>
      within(dialog).getByRole("heading", {
        name: "Change the storage ceiling",
      });
    expect(title()).toBeTruthy();
    await user.clear(field);
    await user.type(field, "100");
    expect(title()).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Raise to 100 GiB" }),
    ).toBeTruthy();
    await user.clear(field);
    await user.type(field, "10");
    expect(title()).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Lower to 10 GiB" }),
    ).toBeTruthy();
  });

  it("raises the ceiling at L2: the reason is the operator's own, and the key is sent", async () => {
    const user = userEvent.setup();
    const { dialog, field } = await openCeiling(user);
    await user.clear(field);
    await user.type(field, "100");
    const raise = () =>
      within(dialog).getByRole("button", { name: "Raise to 100 GiB" });
    // Soft-disabled: focusable, and the reason is its tooltip (confirmDisabledReason).
    expect(raise().getAttribute("aria-disabled")).toBe("true");
    await user.type(
      within(dialog).getByLabelText(/Reason/),
      "A big launch next week",
    );
    await user.click(raise());
    expect(updateSetting).toHaveBeenCalledWith(
      "diceroll",
      "cloudSync.ceiling.bytes",
      {
        value: 100 * GiB,
        expectedVersion: 3,
        reason: "A big launch next week",
        confirm: "cloudSync.ceiling.bytes",
      },
    );
  });

  it("lowers the ceiling at L1, says nothing is deleted, and Enter in the field confirms", async () => {
    const user = userEvent.setup();
    const { dialog, field } = await openCeiling(user);
    await user.clear(field);
    await user.type(field, "10");
    expect(within(dialog).getByText("Nothing is deleted.")).toBeTruthy();
    expect(within(dialog).getByText(/holds 18\.4 GiB/)).toBeTruthy();
    await user.type(within(dialog).getByLabelText(/Reason/), "Cost");
    await user.click(field);
    await user.keyboard("{Enter}");
    expect(updateSetting).toHaveBeenCalledWith(
      "diceroll",
      "cloudSync.ceiling.bytes",
      { value: 10 * GiB, expectedVersion: 3, reason: "Cost" },
    );
  });

  it("words the edge cases: over the maximum, 0, and a number that rounds", async () => {
    const user = userEvent.setup();
    const { dialog, field } = await openCeiling(user);
    await user.clear(field);
    await user.type(field, "2000000");
    expect(
      within(dialog).getByText("Use 0 to 1,048,576 GiB (1 PiB)."),
    ).toBeTruthy();
    await user.clear(field);
    await user.type(field, "0");
    expect(
      within(dialog).getByText(
        "Every save that adds data is refused until you raise it.",
      ),
    ).toBeTruthy();
    await user.clear(field);
    await user.type(field, "50.004");
    // What is typed is what is stored (whole MiB), and the button says it.
    expect(
      within(dialog).getByRole("button", { name: "Raise to 50.004 GiB" }),
    ).toBeTruthy();
  });

  it("words a ceiling in GiB to three decimals, and in MiB only below 1 GiB", async () => {
    const user = userEvent.setup();
    const { dialog, field } = await openCeiling(user);
    await user.clear(field);
    await user.type(field, "10.5");
    expect(
      within(dialog).getByRole("button", { name: "Lower to 10.5 GiB" }),
    ).toBeTruthy();
    expect(within(dialog).getByText(/less than 10.5 GiB/)).toBeTruthy();
    await user.clear(field);
    await user.type(field, "0.5");
    expect(
      within(dialog).getByRole("button", { name: "Lower to 512 MiB" }),
    ).toBeTruthy();
  });

  it("keeps the number and the reason across a step-up sign-in", async () => {
    const user = userEvent.setup();
    updateSetting.mockRejectedValueOnce(
      new HttpError(403, { code: "step_up_required" }),
    );
    const { dialog, field } = await openCeiling(user);
    await user.clear(field);
    await user.type(field, "20");
    await user.type(within(dialog).getByLabelText(/Reason/), "Cost");
    await user.click(
      within(dialog).getByRole("button", { name: "Lower to 20 GiB" }),
    );
    await user.click(
      await within(dialog).findByRole("button", { name: "Sign in again" }),
    );
    expect(stepUpRedirect).toHaveBeenCalled();
    cleanup();
    const again = await (async () => {
      renderPage();
      return screen.findByRole("alertdialog");
    })();
    expect(
      (
        within(again).getByLabelText(
          /Total storage for this product/,
        ) as HTMLInputElement
      ).value,
    ).toBe("20");
    expect(
      (within(again).getByLabelText(/Reason/) as HTMLTextAreaElement).value,
    ).toBe("Cost");
  });

  it("goes back to the platform default with the revert write, with a reason", async () => {
    const user = userEvent.setup();
    productSettings.mockResolvedValue({
      settings: [CEILING(80 * GiB, "console")],
    });
    const { dialog } = await openCeiling(user);
    await user.click(
      within(dialog).getByRole("button", {
        name: /Use the platform default \(50 GiB\)/,
      }),
    );
    await user.type(within(dialog).getByLabelText(/Reason/), "Back to normal");
    await user.click(
      within(dialog).getByRole("button", { name: "Use the platform default" }),
    );
    expect(revertSetting).toHaveBeenCalledWith(
      "diceroll",
      "cloudSync.ceiling.bytes",
      // 80 GiB down to the default is a lowering: L1, no typed key.
      { expectedVersion: 3, reason: "Back to normal" },
    );
  });

  it("offers no way back to the default while the ceiling is the default", async () => {
    const user = userEvent.setup();
    const { dialog } = await openCeiling(user);
    expect(
      within(dialog).queryByRole("button", {
        name: /Use the platform default/,
      }),
    ).toBeNull();
  });

  it("keeps the typed number when the save fails, and on a version conflict reloads the setting", async () => {
    const user = userEvent.setup();
    updateSetting.mockRejectedValueOnce(new HttpError(500));
    const { dialog, field } = await openCeiling(user);
    await user.clear(field);
    await user.type(field, "20");
    await user.type(within(dialog).getByLabelText(/Reason/), "Cost");
    await user.click(
      within(dialog).getByRole("button", { name: "Lower to 20 GiB" }),
    );
    await vi.waitFor(() => expect(updateSetting).toHaveBeenCalledTimes(1));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(field.value).toBe("20");

    // A conflict: the setting is read again and the typed number and reason stay.
    updateSetting.mockRejectedValueOnce(new HttpError(409));
    productSettings.mockClear();
    productSettings.mockResolvedValue({
      settings: [CEILING(40 * GiB, "console")],
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Lower to 20 GiB" }),
    );
    expect(
      await within(dialog).findByText(
        "The ceiling changed since you opened this",
      ),
    ).toBeTruthy();
    expect(field.value).toBe("20");
    expect(
      (within(dialog).getByLabelText(/Reason/) as HTMLTextAreaElement).value,
    ).toBe("Cost");
    await vi.waitFor(() => expect(productSettings).toHaveBeenCalled());
  });

  it("opens the resume dialog from Home's link: the reason has focus, who and why lead it, and the URL loses the query", async () => {
    window.location.hash = "#/p/diceroll/sync/setup?resume=1";
    platformSettings.mockResolvedValue(view([PAUSED(true), QUOTA]));
    usage.mockResolvedValue(
      USAGE(undefined, {
        since: 1_790_000_000,
        by: "Ana Lima",
        reason: "Storage errors in eu-west",
      }),
    );
    const user = userEvent.setup();
    renderPage();
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByRole("heading", {
        name: "Resume Cloud Sync writes?",
      }),
    ).toBeTruthy();
    expect(within(dialog).getByText("Ana Lima")).toBeTruthy();
    expect(within(dialog).getByText(/Storage errors in eu-west/)).toBeTruthy();
    const reason = within(dialog).getByLabelText(/Reason/);
    expect(document.activeElement).toBe(reason);
    expect(window.location.hash).not.toContain("resume");
    await user.type(reason, "Provider fixed");
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

  it("does not open the resume dialog when writes are not paused, and still drops the query", async () => {
    window.location.hash = "#/p/diceroll/sync/setup?resume=1";
    renderPage();
    await screen.findByRole("button", { name: "Pause writes…" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(window.location.hash).not.toContain("resume");
    window.location.hash = "";
  });

  it("ends a quoted reason with a full stop, and the resume hint promises no banner", async () => {
    window.location.hash = "#/p/diceroll/sync/setup?resume=1";
    platformSettings.mockResolvedValue(view([PAUSED(true), QUOTA]));
    usage.mockResolvedValue(
      USAGE(undefined, {
        since: 1_790_000_000,
        by: "Ana Lima",
        reason: "Storage errors",
      }),
    );
    renderPage();
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("“Storage errors.”");
    expect(within(dialog).getByText("Recorded in Activity.")).toBeTruthy();
    expect(within(dialog).queryByText(/banner/)).toBeNull();
    window.location.hash = "";
  });

  it("has one Resume writes button on the paused page: the banner's; the row shows the Paused pill", async () => {
    platformSettings.mockResolvedValue(view([PAUSED(true), QUOTA]));
    renderPage();
    await screen.findByText("Cloud Sync writes are paused for every product");
    expect(
      screen.getAllByRole("button", { name: "Resume writes" }),
    ).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Pause writes…" })).toBeNull();
    expect(screen.getByText("Paused")).toBeTruthy();
  });

  it("tells a member with a product role that writes are paused, without a way to resume", async () => {
    gate.value = {
      allowed: false,
      canView: true,
      disabledReason:
        "Ask Ana Lima (ana@example.com) for Platform edit access.",
    };
    usage.mockResolvedValue(
      USAGE(undefined, { since: 1_790_000_000, by: null, reason: null }),
    );
    renderPage();
    expect(
      await screen.findByText("Cloud Sync writes are paused for every product"),
    ).toBeTruthy();
    expect(screen.getByText(/Paused since .*\./)).toBeTruthy();
    expect(screen.queryByText(/Paused .* by /)).toBeNull();
    expect(screen.queryByRole("button", { name: /Resume writes/ })).toBeNull();
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(platformSettings).not.toHaveBeenCalled();
  });

  it("draws the platform controls without buttons for a product role, with who can change them at each", async () => {
    gate.value = {
      allowed: false,
      canView: true,
      disabledReason:
        "Ask Ana Lima (ana@example.com) for Platform edit access.",
    };
    renderPage();
    expect(
      await screen.findAllByText(/Platform admins only\. Ask Ana Lima/),
    ).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: "Change the default storage" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Pause writes/ })).toBeNull();
    expect(await screen.findByText("Standard")).toBeTruthy();
    expect(screen.getByText("Off")).toBeTruthy();
    // The access line wraps anywhere: a long address cannot push the page sideways.
    for (const line of screen.getAllByText(/Platform admins only/))
      expect(line.closest("p")!.className).toContain(
        "[overflow-wrap:anywhere]",
      );
    expect(platformSettings).not.toHaveBeenCalled();
  });

  it("a platform write refreshes every product's usage read, so the banner names who and why at once", () => {
    for (const method of ["patchPlatformSetting", "revertPlatformSetting"]) {
      const targets = invalidationFor(method, ["cloudSync.writesPaused", {}])!;
      const t = targets.find((x) => x.match);
      expect(t).toBeTruthy();
      expect(t!.match!(qk.syncUsage("djdl"))).toBe(true);
      expect(t!.match!(qk.syncUsage("northwind"))).toBe(true);
      expect(t!.match!(qk.catalog("djdl"))).toBe(false);
    }
  });

  it("a platform write refreshes Home's Needs attention, so the paused rows clear after Resume", () => {
    for (const method of ["patchPlatformSetting", "revertPlatformSetting"]) {
      const targets = invalidationFor(method, ["cloudSync.writesPaused", {}]);
      expect(targets).toContainEqual({ key: qk.attention(), exact: true });
    }
  });
});
