/**
 * License → Settings (LX-06; S-19 §7.13, S-18 §4.5 model C) through the whole console: each
 * licensing setting with its value and owner, a save that asks for the registry's confirmation
 * (and a reason for a critical setting) and sends the row version it read, and Revert.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { productRow, resetConsole, ALL_ON } from "./consoleHarness.js";
import { API, axe, bootLicense, writes } from "./licenseFixture.js";
import type { ProductSetting } from "../src/api.js";
import {
  confirmLevel,
  formatSettingValue,
} from "../src/console/components/ProductSettingsSection.js";

beforeEach(resetConsole);
afterEach(cleanup);

const HASH = "#/p/djdl/license/settings";
const EFFECTIVE = `${API}/settings/effective`;

function setting(
  key: string,
  over: Partial<ProductSetting> = {},
): ProductSetting {
  return {
    key,
    area: "license.licensing",
    service: "license",
    label: key,
    description: `What ${key} does.`,
    docs: "/docs/services/license/model/",
    spec: { kind: "enum", values: ["a", "b"] },
    confirm: { change: "L1" },
    critical: false,
    manifestPath: `product:${key}`,
    visibleWhen: { service: "license", offBehaviour: "hide" },
    serviceEnabled: true,
    value: "a",
    source: "default",
    defaultValue: "a",
    version: 0,
    updatedAt: null,
    updatedBy: null,
    reason: null,
    ...over,
  };
}

const ANCHOR = setting("licensing.anchorPolicy", {
  label: "Anchor licence choice",
  spec: { kind: "enum", values: ["rank-first", "most-free-seats", "oldest"] },
  value: "rank-first",
  defaultValue: "rank-first",
  source: "manifest",
  manifestValue: "rank-first",
  version: 1,
});
const HOLDER = setting("licensing.entitlementHolder", {
  label: "Entitlement holder",
  spec: { kind: "enum", values: ["device", "owner"] },
  confirm: { up: "L2", down: "L1" },
  critical: true,
  value: "device",
  defaultValue: "device",
});
const REFUND = setting("licensing.refundGraceHours", {
  label: "Refund grace",
  spec: { kind: "integer", unit: "hours", min: 0, max: 168 },
  confirm: { up: "L1", down: "L0" },
  value: 24,
  defaultValue: 0,
  source: "console",
  manifestValue: 12,
  version: 3,
});

function boot(settings: ProductSetting[] = [ANCHOR, HOLDER, REFUND]) {
  return bootLicense(HASH, {
    routes: {
      [EFFECTIVE]: { settings },
      "/manage/api/products/djdl": {
        product: {
          ...productRow("djdl", "DJ Downloader", ALL_ON),
          releaseSource: "github",
        },
      },
      [`PATCH ${API}/settings/licensing.anchorPolicy`]: {
        ok: true,
        claimed: true,
        setting: { ...ANCHOR, value: "oldest", source: "console", version: 2 },
      },
      [`PATCH ${API}/settings/licensing.entitlementHolder`]: {
        ok: true,
        claimed: true,
        setting: { ...HOLDER, value: "owner", source: "console", version: 1 },
      },
      [`DELETE ${API}/settings/licensing.refundGraceHours`]: {
        ok: true,
        applied: true,
        setting: { ...REFUND, value: 12, source: "manifest", version: 4 },
      },
    },
  });
}

async function card() {
  await screen.findByRole("heading", { level: 1, name: "Settings" });
  return screen.findByRole("region", { name: "Licensing model" });
}

describe("License → Settings", () => {
  it("shows each setting with its value and owner, and the area it reads", async () => {
    const log = boot();
    const c = await card();
    expect(await within(c).findByText("Anchor licence choice")).toBeTruthy();
    expect(within(c).getByText("From manifest")).toBeTruthy();
    expect(within(c).getByText("Code default")).toBeTruthy();
    expect(within(c).getByText("Set in console")).toBeTruthy();
    expect(
      log.calls.some(
        (r) => r.path === EFFECTIVE && r.query === "area=license.licensing",
      ),
    ).toBe(true);
    // Nothing to save until a value differs.
    expect(within(c).queryByRole("button", { name: "Save…" })).toBeNull();
    const results = await axe(document.body);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });

  it("saves a change behind the registry's confirmation, with the version it read", async () => {
    const user = userEvent.setup();
    const log = boot();
    const c = await card();
    await user.click(
      await within(c).findByRole("combobox", { name: "Anchor licence choice" }),
    );
    await user.click(
      await screen.findByRole("option", { name: "Oldest licence" }),
    );
    await user.click(within(c).getByRole("button", { name: "Save…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/claims it from \.pkey\/product/),
    ).toBeTruthy();
    await user.click(
      within(dialog).getByRole("button", {
        name: "Change anchor licence choice",
      }),
    );
    await waitFor(() =>
      expect(writes(log)).toEqual([
        {
          path: `${API}/settings/licensing.anchorPolicy`,
          method: "PATCH",
          body: { value: "oldest", expectedVersion: 1 },
        },
      ]),
    );
  });

  it("asks for a reason, with S-19's warning, before widening the entitlement holder", async () => {
    const user = userEvent.setup();
    const log = boot();
    const c = await card();
    await user.click(
      await within(c).findByRole("combobox", { name: "Entitlement holder" }),
    );
    await user.click(
      await screen.findByRole("option", { name: "Licence owner" }),
    );
    await user.click(within(c).getByRole("button", { name: "Save…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/sees everything the owner holds/),
    ).toBeTruthy();
    const confirm = within(dialog).getByRole("button", {
      name: "Change entitlement holder",
    });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.type(
      within(dialog).getByRole("textbox", { name: "Reason" }),
      "Studio keys are shared",
    );
    await user.click(confirm);
    await waitFor(() =>
      expect(writes(log)[0]).toEqual({
        path: `${API}/settings/licensing.entitlementHolder`,
        method: "PATCH",
        body: {
          value: "owner",
          expectedVersion: 0,
          reason: "Studio keys are shared",
        },
      }),
    );
  });

  it("reverts a console value to the manifest's", async () => {
    const user = userEvent.setup();
    const log = boot();
    const c = await card();
    await user.click(
      await within(c).findByRole("button", { name: /Set in console/ }),
    );
    await user.click(await screen.findByRole("button", { name: "Revert…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText("Return refund grace to the manifest?"),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        "The manifest's value, 12 hours, replaces 24 hours now.",
      ),
    ).toBeTruthy();
    await user.click(
      within(dialog).getByRole("button", { name: "Revert to manifest" }),
    );
    await waitFor(() =>
      expect(writes(log)).toEqual([
        {
          path: `${API}/settings/licensing.refundGraceHours`,
          method: "DELETE",
          body: { expectedVersion: 3 },
        },
      ]),
    );
  });

  it("hides a setting whose service is off", async () => {
    boot([ANCHOR, { ...HOLDER, serviceEnabled: false }]);
    const c = await card();
    await within(c).findByText("Anchor licence choice");
    expect(within(c).queryByText("Entitlement holder")).toBeNull();
  });
});

describe("the confirm level a change needs", () => {
  it("reads the registry's direction for ordered enums, integers and switches", () => {
    const holder = { kind: "enum", values: ["device", "owner"] } as const;
    expect(
      confirmLevel(holder, { up: "L2", down: "L1" }, "device", "owner"),
    ).toBe("L2");
    expect(
      confirmLevel(holder, { up: "L2", down: "L1" }, "owner", "device"),
    ).toBe("L1");
    const hours = { kind: "integer", unit: "hours", min: 0, max: 168 } as const;
    expect(confirmLevel(hours, { up: "L1", down: "L0" }, 0, 24)).toBe("L1");
    expect(confirmLevel(hours, { up: "L1", down: "L0" }, 24, 0)).toBe("L0");
    expect(
      confirmLevel({ kind: "boolean" }, { on: "L0", off: "L1" }, true, false),
    ).toBe("L1");
    expect(confirmLevel(holder, { change: "L1" }, "device", "owner")).toBe(
      "L1",
    );
  });

  it("formats values in words", () => {
    expect(formatSettingValue({ kind: "boolean" }, false)).toBe("Off");
    expect(
      formatSettingValue({ kind: "integer", unit: "days", min: 0, max: 30 }, 7),
    ).toBe("7 days");
    expect(
      formatSettingValue({ kind: "enum", values: ["never"] }, "never", {
        values: { never: "Never" },
      }),
    ).toBe("Never");
  });
});
