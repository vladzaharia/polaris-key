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
  gate.value = { allowed: true, canView: true, disabledReason: undefined };
  for (const m of [
    product,
    products,
    platformSettings,
    reach,
    patch,
    me,
    schema,
  ])
    m.mockReset();
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
    expect(await screen.findByText("256 MiB")).toBeTruthy();
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
    await user.click(await screen.findByRole("button", { name: "Change…" }));
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

  it("draws the platform controls disabled for a product role, with who can change them", async () => {
    gate.value = {
      allowed: false,
      canView: true,
      disabledReason:
        "Ask Ana Lima (ana@example.com) for Platform edit access.",
    };
    renderPage();
    const change = await screen.findByRole("button", { name: "Change…" });
    expect(change.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Pause writes…" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      screen.getAllByText(/Platform admins only\. Ask Ana Lima/).length,
    ).toBeGreaterThan(0);
    expect(platformSettings).not.toHaveBeenCalled();
  });
});
