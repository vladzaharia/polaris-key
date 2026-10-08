/**
 * License → Settings (LX-06; S-19 §7.13, S-18 §4.5 model C) through the whole console: each
 * licensing setting with its value and owner, a save that asks for the registry's confirmation
 * (and a reason for a critical setting) and sends the row version it read, and Revert. The
 * settings whose behavior has not shipped are read-only, grouped under "Not in effect yet" after the
 * clamp, each with what devices do today (P0-47); only the offline grace clamp is edited here.
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
import { LICENSING_PENDING } from "../src/console/pages/license/LicenseSettingsPage.js";

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
const CLAMP = setting("licensing.clampGraceToExpiry", {
  label: "Clamp offline grace to expiry",
  spec: { kind: "boolean" },
  confirm: { on: "L0", off: "L1" },
  critical: true,
  value: true,
  defaultValue: true,
  source: "default",
  version: 2,
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

function boot(settings: ProductSetting[] = [ANCHOR, HOLDER, CLAMP, REFUND]) {
  return bootLicense(HASH, {
    routes: {
      [EFFECTIVE]: { settings },
      "/manage/api/products/djdl": {
        product: {
          ...productRow("djdl", "DJ Downloader", ALL_ON),
          releaseSource: "github",
        },
      },
      [`PATCH ${API}/settings/licensing.clampGraceToExpiry`]: {
        ok: true,
        claimed: true,
        setting: { ...CLAMP, value: false, source: "console", version: 3 },
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
    expect(within(c).getAllByText("Code default")).toHaveLength(2);
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

  it("groups the settings that do nothing yet after the clamp, read-only, each saying what devices do today (P0-47)", async () => {
    boot();
    const c = await card();
    await within(c).findByText("Anchor licence choice");
    // One subheading over the pending rows, not a pill on each.
    const group = within(c).getByRole("group", { name: "Not in effect yet" });
    expect(within(c).getAllByText("Not in effect yet")).toHaveLength(1);
    expect(
      within(group).getByText(/keep their value but change nothing/),
    ).toBeTruthy();
    for (const name of [
      "Anchor licence choice",
      "Entitlement holder",
      "Refund grace",
    ]) {
      expect(within(group).getByText(name)).toBeTruthy();
      expect(within(c).queryByRole("combobox", { name })).toBeNull();
      expect(within(c).queryByRole("spinbutton", { name })).toBeNull();
    }
    // The clamp is in effect: editable, outside the group, and first.
    const clamp = within(c).getByRole("switch", {
      name: "Clamp offline grace to expiry",
    });
    expect(group.contains(clamp)).toBe(false);
    expect(
      clamp.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The value stored, in words and muted, and what devices do today, per key.
    expect(within(group).getByText("Highest-ranked tier").className).toContain(
      "text-fg-muted",
    );
    expect(within(group).getByText("Signed-in account")).toBeTruthy();
    expect(
      within(group).getByText(
        "Today a device runs on the license it was activated with.",
      ),
    ).toBeTruthy();
    expect(
      within(group).getByText(
        "Today each device sees only its own license's entitlements, whoever is signed in.",
      ),
    ).toBeTruthy();
    expect(
      within(group).getByText("Today a refund takes effect at once."),
    ).toBeTruthy();
    expect(screen.queryByText(/behaviour/)).toBeNull();
    expect(
      screen.getByText(
        /Only clamping offline grace to expiry is in effect\. Devices pick up a change to it at their next license refresh\./,
      ),
    ).toBeTruthy();
  });

  it("names every no-op licensing setting pending, and never the clamp", () => {
    expect(Object.keys(LICENSING_PENDING).sort()).toEqual([
      "licensing.anchorPolicy",
      "licensing.entitlementHolder",
      "licensing.entitlementModel",
      "licensing.reanchor",
      "licensing.refundGraceHours",
    ]);
    expect(LICENSING_PENDING["licensing.clampGraceToExpiry"]).toBeUndefined();
  });

  it("saves a change behind the registry's confirmation and a reason, with the version it read", async () => {
    const user = userEvent.setup();
    const log = boot();
    const c = await card();
    await user.click(
      await within(c).findByRole("switch", {
        name: "Clamp offline grace to expiry",
      }),
    );
    await user.click(within(c).getByRole("button", { name: "Save…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(
        "A license that expires can keep running offline until its offline grace ends.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(/claims it from \.pkey\/product/),
    ).toBeTruthy();
    const confirm = within(dialog).getByRole("button", {
      name: "Change clamp offline grace to expiry",
    });
    // A critical setting asks for a reason first.
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.type(
      within(dialog).getByRole("textbox", { name: "Reason" }),
      "Offline studios",
    );
    await user.click(confirm);
    await waitFor(() =>
      expect(writes(log)).toEqual([
        {
          path: `${API}/settings/licensing.clampGraceToExpiry`,
          method: "PATCH",
          body: { value: false, expectedVersion: 2, reason: "Offline studios" },
        },
      ]),
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
