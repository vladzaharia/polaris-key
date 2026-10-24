/**
 * ST-10: a palette deep link (`?setting=<key>`) lands on the setting's row in All settings.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import type * as ApiModule from "../src/api.js";
import { SettingsHub } from "../src/console/sections/core/pages/SettingsHub.js";
import { PortalPage } from "../src/console/sections/core/pages/Portal.js";
import { SettingsPage } from "../src/console/sections/core/pages/Settings.js";
import { SettingsAllPage } from "../src/console/sections/core/pages/SettingsAll.js";
import { SETTINGS_INDEX } from "../src/console/settings.generated.js";
import { ALL_ON, ME } from "./consoleHarness.js";
import { expectNoAxeViolations, renderAt, resetCore } from "./coreTestUtils.js";

const fns = vi.hoisted(() => ({
  me: vi.fn(),
  product: vi.fn(),
  productSettings: vi.fn(),
  portalSettings: vi.fn(),
}));
vi.mock("../src/api.js", async () => {
  const actual = await vi.importActual<typeof ApiModule>("../src/api.js");
  return {
    ...actual,
    api: new Proxy(actual.api, {
      get: (t, k: string) =>
        k in fns
          ? (...a: unknown[]) =>
              (fns as Record<string, (...x: unknown[]) => unknown>)[k]!(...a)
          : (t as unknown as Record<string, unknown>)[k],
    }),
  };
});

describe("the deep link", () => {
  beforeEach(() => {
    resetCore();
    for (const f of Object.values(fns)) f.mockReset();
    fns.me.mockResolvedValue({ ...ME, platformAdmin: true });
    fns.product.mockResolvedValue({
      product: {
        slug: "djdl",
        name: "DJDL",
        services: ALL_ON,
        manifestAuthoritative: { value: false, locked: false },
      },
    });
    fns.productSettings.mockResolvedValue({ settings: [] });
    fns.portalSettings.mockResolvedValue({
      settings: {
        portalEnabled: true,
        keyReissueEnabled: false,
        claimByKey: false,
        branding: null,
        modifiedAt: 1,
      },
    });
  });
  afterEach(cleanup);

  it("lands on the setting's row in All settings", async () => {
    const e = SETTINGS_INDEX.find(
      (x) =>
        x.scope === "product" &&
        x.rbacArea === "core" &&
        x.service === "core" &&
        x.pending === null &&
        x.deprecated === null,
    )!;
    renderAt(
      `#/p/djdl/settings/all?setting=${encodeURIComponent(e.key)}`,
      <SettingsHub slug="djdl" page="settings-all">
        <SettingsAllPage slug="djdl" />
      </SettingsHub>,
    );
    await waitFor(() =>
      expect(document.activeElement?.id).toBe(`all-setting-${e.key}`),
    );
    // The hub header alone has no shell around it: check the table the row sits in.
    await expectNoAxeViolations(
      document.getElementById(`all-setting-${e.key}`)!.closest("table")!,
    );
  });

  // Every rendered setting row carries `setting-<key>`, so the link lands on the row itself at
  // once (ST-10, UX review M6) rather than on its section after a wait.
  it.each([
    ["portal.enabled", "portal"],
    ["identity.keyEntry.claimByKey", "portal"],
    ["license.defaults.deviceLimit", "settings"],
    ["license.defaults.maxOfflineDays", "settings"],
    ["core.web.origins", "settings"],
  ] as const)("%s lands on its own row", async (key, page) => {
    const started = Date.now();
    renderAt(
      `#/p/djdl/settings/${page}?setting=${encodeURIComponent(key)}`,
      <SettingsHub slug="djdl" page={page === "portal" ? "portal" : "settings"}>
        {page === "portal" ? (
          <PortalPage slug="djdl" />
        ) : (
          <SettingsPage slug="djdl" />
        )}
      </SettingsHub>,
    );
    const id = `setting-${key}`;
    await waitFor(
      () =>
        expect(
          document.getElementById(id)?.contains(document.activeElement),
        ).toBe(true),
      { timeout: 1400 },
    );
    // Not the 1.5 s section fallback.
    expect(Date.now() - started).toBeLessThan(1400);
    expect(document.getElementById(id)?.tagName).toBe("DIV");
  });
});
